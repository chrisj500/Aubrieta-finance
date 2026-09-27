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

  it("keeps Transactions focused on everyday transaction work", () => {
    expect(src).toContain('aria-label="Search transactions"');
    expect(src).toContain('aria-label="Sort transactions"');
    expect(src).not.toContain('History tools');
    expect(src).not.toContain('Pull full history');
    expect(src).not.toContain('Import CSV');
    expect(src).toContain('Go to Data & Sync and tap “Reconnect”');
    expect(src).toContain('href="/data-sync#csv-import"');
  });

  it("offers a single reusable clear-filter action for active filters and empty results", () => {
    expect(src).toContain('const clearFilters = () => {');
    expect(src).toContain('Clear filters{filterCount > 0 ? ` (${filterCount})` : ""}');
    expect(src).toContain('onClick={clearFilters}');
    expect(src).toContain('{hasFilters ? (');
  });
  it("keeps category and exclusion inline and pins filters near the scroll edge", () => {
    expect(src).toContain('className="sticky top-2 z-20 p-3 shadow-sm sm:p-4"');
    expect(src).toContain('ariaLabel={`Category for ${t.name}`}');
    expect(src).toContain('>\n                      Exclude\n                    </button>');
    expect(src).toContain('routine review never requires opening details');
    expect(src).not.toContain('Exclude from budgets\n                      </label>');
  });

  it("aligns the right-side transaction controls through a shared desktop grid", () => {
    expect(src).toContain('md:grid-cols-[minmax(0,1fr)_max-content_max-content_max-content_2rem]');
    expect(src).toContain('md:grid-cols-subgrid');
    expect(src).toContain('md:col-start-4 md:row-start-1');
    expect(src).toContain('tabular-nums');
  });

  it("uses the semantic danger palette when a transaction is excluded", () => {
    expect(src).toContain('border-danger bg-[var(--danger-soft)] text-danger');
    expect(src).toContain('border-danger bg-danger text-[var(--danger-foreground)]');
  });

  it("renders Exclude as a destructive-intent toggle button with an X mark", () => {
    expect(src).toContain('aria-pressed={t.exclude_from_budgets === 1}');
    expect(src).toContain('M3 3L9 9M9 3L3 9');
    expect(src).not.toContain('checked={t.exclude_from_budgets === 1}');
    expect(src).toContain('hover:border-danger/50 hover:text-danger');
  });

});
