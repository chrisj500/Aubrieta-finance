/** Canonical Aubrieta release source shared by hub + browser-safe solo builds. */
export const AUBRIETA_RELEASE_REPOSITORY = "chrisj500/Aubrieta-finance";
export const AUBRIETA_LATEST_RELEASE_API = `https://api.github.com/repos/${AUBRIETA_RELEASE_REPOSITORY}/releases/latest`;
export const AUBRIETA_RELEASE_SOURCE = `github:${AUBRIETA_RELEASE_REPOSITORY}`;
export const AUBRIETA_UPDATE_USER_AGENT = "aubrieta-updater";
export const AUBRIETA_APK_ASSET = "app-release.apk";
export const AUBRIETA_CHECKSUMS_ASSET = "SHA256SUMS";

/** Strict checksum gate used before native APK installation. */
export function isSha256Hex(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
