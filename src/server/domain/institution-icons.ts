import { apiErrors } from "@/lib/api-error";
import type { Db } from "@/server/db/types";
import { normalizeInstitutionKey } from "@/server/domain/account-identity";

const MAX_ICON_BYTES = 256 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface InstitutionIconRow {
  institutionKey: string;
  institutionName: string;
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
}

function validateImageDataUrl(dataUrl: string): { mimeType: string; sizeBytes: number } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || !ALLOWED.has(match[1])) throw apiErrors.badRequest("Icon must be a PNG, JPEG, or WebP image.");
  let bytes: string;
  try { bytes = atob(match[2]); } catch { throw apiErrors.badRequest("Icon image data is invalid."); }
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) throw apiErrors.badRequest("Icon must be 256 KB or smaller after resizing.");
  const b = (i: number) => bytes.charCodeAt(i) & 0xff;
  const png = bytes.length >= 8 && b(0) === 0x89 && bytes.slice(1, 4) === "PNG";
  const jpeg = bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  const webp = bytes.length >= 12 && bytes.slice(0, 4) === "RIFF" && bytes.slice(8, 12) === "WEBP";
  if ((match[1] === "image/png" && !png) || (match[1] === "image/jpeg" && !jpeg) || (match[1] === "image/webp" && !webp)) {
    throw apiErrors.badRequest("Icon file contents do not match the declared image type.");
  }
  return { mimeType: match[1], sizeBytes: bytes.length };
}

export function createInstitutionIconService(db: Db) {
  return {
    async list(userId: string): Promise<InstitutionIconRow[]> {
      const rows = await db.all<{ institution_key: string; institution_name: string; data_url: string; mime_type: string; size_bytes: number }>(
        `SELECT institution_key, institution_name, data_url, mime_type, size_bytes
           FROM institution_icon_overrides WHERE user_id = ? ORDER BY institution_name COLLATE NOCASE`, userId,
      );
      return rows.map((r) => ({ institutionKey: r.institution_key, institutionName: r.institution_name, dataUrl: r.data_url, mimeType: r.mime_type, sizeBytes: r.size_bytes }));
    },

    async set(userId: string, institutionName: string, dataUrl: string): Promise<InstitutionIconRow> {
      const name = institutionName.trim();
      if (!name || name.length > 160) throw apiErrors.badRequest("Institution name is invalid.");
      const key = normalizeInstitutionKey(name);
      if (!key) throw apiErrors.badRequest("Institution name is invalid.");
      const image = validateImageDataUrl(dataUrl);
      const now = new Date().toISOString();
      const existing = await db.get<{ institution_key: string }>(
        "SELECT institution_key FROM institution_icon_overrides WHERE user_id = ? AND institution_key = ?", userId, key,
      );
      if (existing) {
        await db.run(
          `UPDATE institution_icon_overrides SET institution_name = ?, data_url = ?, mime_type = ?, size_bytes = ?, updated_at = ?
            WHERE user_id = ? AND institution_key = ?`,
          name, dataUrl, image.mimeType, image.sizeBytes, now, userId, key,
        );
      } else {
        await db.run(
          `INSERT INTO institution_icon_overrides
           (user_id, institution_key, institution_name, data_url, mime_type, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          userId, key, name, dataUrl, image.mimeType, image.sizeBytes, now, now,
        );
      }
      return { institutionKey: key, institutionName: name, dataUrl, mimeType: image.mimeType, sizeBytes: image.sizeBytes };
    },

    async remove(userId: string, institutionName: string): Promise<void> {
      const key = normalizeInstitutionKey(institutionName);
      if (!key) throw apiErrors.badRequest("Institution name is invalid.");
      await db.run("DELETE FROM institution_icon_overrides WHERE user_id = ? AND institution_key = ?", userId, key);
    },
  };
}
