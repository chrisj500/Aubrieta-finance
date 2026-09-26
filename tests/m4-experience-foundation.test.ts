import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relative = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(relative));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

describe("M4 experience foundation", () => {
  it("provides a bounded page shell and accessible page heading primitive", () => {
    const src = read("src/components/ui/page.tsx");
    expect(src).toContain('max-w-[1200px]');
    expect(src).toContain("<h1");
    expect(src).toContain("{title}");
  });

  it("provides a reusable financial metric card with tabular money styling", () => {
    const src = read("src/components/ui/metric-card.tsx");
    expect(src).toContain("<CardLabel>{label}</CardLabel>");
    expect(src).toContain('"money mt-1.5');
    expect(src).toContain('tone?: "default" | "positive" | "danger"');
  });

  it("presents the dashboard route as Overview without breaking dashboard storage or agent slots", () => {
    const src = read("src/app/(app)/dashboard/page.tsx");
    expect(src).toContain('usePageTitle("Overview")');
    expect(src).toContain('title="Overview"');
    expect(src).toContain("useDashboardLayout()");
    expect(src).toContain('<AgentWidgets tab="dashboard" />');
  });

  it("uses Aubrieta branding across user-facing app and component source", () => {
    const files = [...sourceFiles("src/app"), ...sourceFiles("src/components")];
    const stale = files.filter((file) => read(file).includes("Open Finance"));
    expect(stale).toEqual([]);
    expect(read("src/components/sidebar.tsx")).toContain('label: "Overview"');
    expect(read("src/components/sidebar.tsx")).toContain(">Aubrieta</span>");
  });
});
