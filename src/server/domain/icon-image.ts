import { apiErrors } from "@/lib/api-error";

export const MAX_ICON_BYTES = 256 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

export function validateIconDataUrl(dataUrl: string): { mimeType: string; sizeBytes: number } {
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
