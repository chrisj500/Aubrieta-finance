import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AUBRIETA_APK_ASSET,
  AUBRIETA_CHECKSUMS_ASSET,
  AUBRIETA_LATEST_RELEASE_API,
  AUBRIETA_RELEASE_REPOSITORY,
  AUBRIETA_RELEASE_SOURCE,
  isSha256Hex,
} from "@/lib/update-source";
import { createUpdatesService } from "@/server/domain/updates";
import { createSoloUpdatesService } from "@/server/domain/updates-solo";
import { createTestDb } from "./helpers";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("M5.3 canonical update source", () => {
  it("uses the Aubrieta repository as the shared release source", () => {
    expect(AUBRIETA_RELEASE_REPOSITORY).toBe("chrisj500/Aubrieta-finance");
    expect(AUBRIETA_LATEST_RELEASE_API).toBe(
      "https://api.github.com/repos/chrisj500/Aubrieta-finance/releases/latest",
    );
    expect(AUBRIETA_RELEASE_SOURCE).toBe("github:chrisj500/Aubrieta-finance");
  });

  it("the hub check calls the canonical Aubrieta release endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      void input;
      return new Response(JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://github.com/chrisj500/Aubrieta-finance/releases/tag/v9.9.9",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const db = createTestDb();
    const result = await createUpdatesService(db).check();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(AUBRIETA_LATEST_RELEASE_API);
    expect(result.source).toBe(AUBRIETA_RELEASE_SOURCE);
    expect((await createUpdatesService(db).status()).source).toBe(AUBRIETA_RELEASE_SOURCE);
  });

  it("the solo check records an APK only with the release checksum it fetched", async () => {
    const sha = "a".repeat(64);
    const apkUrl = "https://github.com/chrisj500/Aubrieta-finance/releases/download/v9.9.9/app-release.apk";
    const sumsUrl = "https://github.com/chrisj500/Aubrieta-finance/releases/download/v9.9.9/SHA256SUMS";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === AUBRIETA_LATEST_RELEASE_API) {
        return new Response(JSON.stringify({
          tag_name: "v9.9.9",
          html_url: "https://github.com/chrisj500/Aubrieta-finance/releases/tag/v9.9.9",
          assets: [
            { name: AUBRIETA_APK_ASSET, browser_download_url: apkUrl },
            { name: AUBRIETA_CHECKSUMS_ASSET, browser_download_url: sumsUrl },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === sumsUrl) return new Response(`${sha}  ./release/app-release.apk\n`, { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const db = createTestDb();
    const result = await createSoloUpdatesService(db).check();
    expect(result.status.source).toBe(AUBRIETA_RELEASE_SOURCE);
    expect(result.status.apkUrl).toBe(apkUrl);
    expect(result.status.apkSha256).toBe(sha);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a strict 64-hex checksum gate", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(true);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
    expect(isSha256Hex("g".repeat(64))).toBe(false);
    expect(isSha256Hex(null)).toBe(false);
  });

  it("has no historical upstream release source in active update/install code", () => {
    const active = [
      read("src/lib/update-source.ts"),
      read("src/server/domain/updates.ts"),
      read("src/server/domain/updates-solo.ts"),
      read("scripts/install.sh"),
    ].join("\n");
    expect(active).not.toContain("DeseretSaint/open-finance");
  });
});

describe("M5.3 native updater fail-closed contracts", () => {
  it("requires a checksum in both native update UI surfaces", () => {
    const banner = read("src/components/update-banner.tsx");
    const card = read("src/components/updates-card.tsx");
    for (const source of [banner, card]) {
      expect(source).toContain("isSha256Hex");
      expect(source).toContain("Verified SHA-256 checksum unavailable");
      expect(source).not.toContain("sha256: s.apkSha256 ?? null");
      expect(source).not.toContain("sha256: st.apkSha256 ?? null");
    }
  });

  it("the Android plugin rejects missing/malformed checksums before download and always verifies the APK", () => {
    const source = read("android/app/src/main/java/com/openfinance/plugin/UpdaterPlugin.kt");
    expect(source).toContain("A valid SHA-256 checksum is required for native updates.");
    expect(source).toContain('Regex("^[0-9a-f]{64}$")');
    expect(source).toContain("val actual = sha256(apkFile)");
    expect(source).not.toContain("if (expectedSha != null)");
  });

  it("the one-line installer downloads Aubrieta, not the historical upstream repository", () => {
    const source = read("scripts/install.sh");
    expect(source).toContain("chrisj500/Aubrieta-finance");
    expect(source).not.toContain("DeseretSaint/open-finance");
  });
});
