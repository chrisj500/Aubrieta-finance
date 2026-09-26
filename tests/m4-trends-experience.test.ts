import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const reports = readFileSync(path.resolve(__dirname, "../src/app/(app)/reports/page.tsx"), "utf8");
const cashflowRoute = readFileSync(path.resolve(__dirname, "../src/app/api/reports/cashflow/route.ts"), "utf8");
const categoryRoute = readFileSync(path.resolve(__dirname, "../src/app/api/reports/spending-by-category/route.ts"), "utf8");
const spendingRoute = readFileSync(path.resolve(__dirname, "../src/app/api/reports/spending-trend/route.ts"), "utf8");
const domain = readFileSync(path.resolve(__dirname, "../src/server/domain/reports.ts"), "utf8");

describe("M4.6 Trends experience", () => {
  it("uses the Aubrieta page shell with a visible Reports purpose", () => {
    expect(reports).toContain('import { Page, PageHeader } from "@/components/ui/page"');
    expect(reports).toContain('title="Reports"');
    expect(reports).toContain("Understand how spending, cash flow, categories, and net worth are changing over time.");
  });

  it("uses one 3/6/12 month range for the trends experience", () => {
    expect(reports).toContain('aria-label="Trends range"');
    expect(reports).toContain("[3, 6, 12].map((m) =>");
    expect(reports).toContain("aria-pressed={trendMonths === m}");
    expect(reports).toContain("onClick={() => setTrendMonths(m)}");
  });

  it("compares the active period with an equally sized prior period", () => {
    expect(reports).toContain("months: String(trendMonths * 2)");
    expect(reports).toContain("allCashflowRows.slice(-trendMonths * 2, -trendMonths)");
    expect(reports).toContain("allSpendingRows.slice(-trendMonths * 2, -trendMonths)");
    expect(reports).toContain("vs prior period");
  });

  it("uses the dedicated spending trend endpoint and exposes trend charts", () => {
    expect(reports).toContain('/api/reports/spending-trend?${p.toString()}');
    expect(reports).toContain("Spending trend — last {trendMonths} months");
    expect(reports).toContain("Cash flow — last {trendMonths} months");
    expect(reports).toContain("Net worth trend — last {trendMonths} months");
    expect(reports).toContain("Spending trend line chart");
  });

  it("compares selected-month categories with the previous month", () => {
    expect(reports).toContain('["reports", "by-category-previous", monthOffset, includeExcluded, includePending]');
    expect(reports).toContain("<CardTitle>Category comparison</CardTitle>");
    expect(reports).toContain("categoryComparison.map((row)");
    expect(reports).toContain('row.deltaCents > 0 ? "text-danger"');
  });

  it("honors includeExcluded through cashflow, category, and spending trend APIs", () => {
    for (const src of [cashflowRoute, categoryRoute, spendingRoute]) {
      expect(src).toContain('req.nextUrl.searchParams.get("includeExcluded") === "1"');
    }
    expect(domain).toContain("async spendingTrend(userId: string, months: number, allowlist?: AllowlistCtx | null, includeExcluded = false, includePending = true)");
    expect(domain).toContain("this.cashflow(userId, months, allowlist, undefined, undefined, includeExcluded, includePending)");
  });
});
