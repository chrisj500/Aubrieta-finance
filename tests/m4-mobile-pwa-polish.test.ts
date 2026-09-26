import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
  name: string;
  short_name: string;
  lang?: string;
  categories?: string[];
};
const layout = read("src/app/(app)/layout.tsx");
const sidebar = read("src/components/sidebar.tsx");
const settings = read("src/app/(app)/settings/page.tsx");
const plan = read("src/app/(app)/plan/page.tsx");
const agents = read("src/app/(app)/agents/page.tsx");
const mobileBuild = read("scripts/build-mobile.mjs");

describe("final M4 mobile/PWA polish", () => {
  it("installs with Aubrieta branding instead of the pre-M4 name", () => {
    expect(manifest.name).toBe("Aubrieta");
    expect(manifest.short_name).toBe("Aubrieta");
    expect(manifest.lang).toBe("en-US");
    expect(manifest.categories).toEqual(expect.arrayContaining(["finance", "productivity"]));
  });

  it("reserves page-bottom space for both the mobile tab bar and device safe area", () => {
    expect(layout).toContain("pb-[calc(5rem+env(safe-area-inset-bottom))]");
  });

  it("lets the More sheet scroll on short phones rather than clipping controls", () => {
    expect(sidebar).toContain("max-h-[calc(100dvh-0.5rem)]");
    expect(sidebar).toContain("overflow-y-auto overscroll-contain");
  });

  it("wraps long connection/agent technical strings instead of clipping them on narrow screens", () => {
    expect(settings).toContain('className="block break-all rounded-md bg-surface-muted');
    expect(settings).toContain('className="mt-2 min-w-0 space-y-1.5 break-all font-mono"');
  });

  it("gives the formerly 14px Plan delete controls real touch targets", () => {
    expect(plan).toMatch(/removeBill\.mutate\(b\)[\s\S]{0,180}h-9 w-9/);
    expect(plan).toMatch(/removeDebt\.mutate\(d\)[\s\S]{0,180}h-9 w-9/);
    expect(plan).toMatch(/removeGoal\.mutate\(g\)[\s\S]{0,180}h-9 w-9/);
  });


  it("keeps account detail available in static mobile/PWA exports", () => {
    expect(mobileBuild).toContain('const ACCOUNT_DETAIL_DIR = path.join(root, "src", "app", "(app)", "accounts", "[id]")');
    expect(mobileBuild).toContain("static export uses /account?id=...");
    expect(mobileBuild).toContain("src/app/(app)/accounts/[id] restored");
    expect(mobileBuild).toContain('execSync("npm run build"');
  });

  it("lets the Agents endpoint shrink and wrap beside its copy button on narrow phones", () => {
    expect(agents).toContain("block min-w-0 flex-1 break-all");
    expect(agents).toContain('aria-label="Copy endpoint"');
  });
});
