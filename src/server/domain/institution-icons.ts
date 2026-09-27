import { apiErrors } from "@/lib/api-error";
import { validateIconDataUrl } from "@/server/domain/icon-image";
import type { Db } from "@/server/db/types";
import { normalizeInstitutionKey } from "@/server/domain/account-identity";

export interface InstitutionIconRow {
  institutionKey: string;
  institutionName: string;
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
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
      const image = validateIconDataUrl(dataUrl);
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
