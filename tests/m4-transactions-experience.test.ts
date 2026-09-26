import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.resolve(__dirname, "../src/app/(app)/transactions/page.tsx"), "utf8");

describe("M4.2 Transactions experience", () => {
  it("uses the Aubrieta page primitives and gives the screen a visible purpose", () => {
    expect(src).toContain('import { Page, PageHeader } from "@/components/ui/page"');
    expect(src).toContain('title="Transactions"');
    expect(src).toContain('description="Search, review, and organize activity across every account."');
  });

  it("keeps everyday controls ahead of maintenance/history tools", () => {
    expect(src).toContain('aria-label="Search transactions"');
    expect(src).toContain('History tools');
    expect(src.indexOf('aria-label="Search transactions"')).toBeLessThan(src.indexOf('History tools'));
    expect(src.indexOf('History tools')).toBeLessThan(src.lastIndexOf('Pull full history'));
    expect(src.indexOf('History tools')).toBeLessThan(src.lastIndexOf('Import CSV'));
  });

  it("offers a single reusable clear-filter action for active filters and empty results", () => {
    expect(src).toContain('const clearFilters = () => {');
    expect(src).toContain('Clear filters{filterCount > 0 ? ` (${filterCount})` : ""}');
    expect(src).toContain('onClick={clearFilters}');
    expect(src).toContain('{hasFilters ? (');
  });
});
