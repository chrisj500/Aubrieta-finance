import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.resolve(__dirname, "../src/app/(app)/budgets/page.tsx"), "utf8");

describe("M4.4 Budgets experience", () => {
  it("uses the Aubrieta page shell and gives Budgets a visible purpose", () => {
    expect(src).toContain('import { Page, PageHeader } from "@/components/ui/page"');
    expect(src).toContain('title="Budgets"');
    expect(src).toContain('description="Set spending limits, see what needs attention, and understand what remains in the selected time frame."');
  });

  it("summarizes the selected budget frame before individual limits", () => {
    expect(src).toContain('id="budget-overview-heading"');
    expect(src).toContain('label="Budgeted in view"');
    expect(src).toContain('label="Spent in view"');
    expect(src).toContain('label="Remaining in view"');
    expect(src.indexOf('id="budget-overview-heading"')).toBeLessThan(src.indexOf('id="budget-list-heading"'));
  });

  it("prioritizes budgets that need attention without changing their underlying data", () => {
    expect(src).toContain('const orderedBudgets = [...(data?.budgets ?? [])].sort');
    expect(src).toContain('budget.pct > 1 ? 2 : budget.pct >= 0.85 ? 1 : 0');
    expect(src).toContain('{orderedBudgets.map((b) => {');
    expect(src).toContain('Budgets over or near their limit appear first.');
  });

  it("describes income minus spending as cash flow rather than safe-to-spend money", () => {
    expect(src).toContain('Cash flow in view');
    expect(src).toContain('This is cash-flow context, not an estimate of money available after future bills.');
    expect(src).toContain('Net cash flow');
    expect(src).not.toContain('Safe to spend');
    expect(src).not.toContain('safe-to-spend pool');
  });
});
