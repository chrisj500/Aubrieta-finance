import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("transactions search debounce", () => {
  it("debounces the search term before issuing a query", () => {
    const src = read("src/app/(app)/transactions/page.tsx");
    // a debounced value exists and is seeded from q
    expect(src).toMatch(/const \[debouncedQ, setDebouncedQ\] = useState\(q\)/);
    // a 300ms setTimeout debounce keyed on q
    expect(src).toMatch(/setTimeout\(\(\) => setDebouncedQ\(q\), 300\)/);
    // the query params use the debounced value, not the raw q
    expect(src).toContain('if (debouncedQ.trim()) p.set("q", debouncedQ.trim());');
    // the input itself stays responsive to the immediate q value
    expect(src).toContain("value={q}");
    expect(src).toContain('onChange={(e) => setQ(e.target.value)}');
    // memo deps reference debouncedQ, not q (from/to were added for date-range)
    expect(src).toMatch(/\[\s*debouncedQ,\s*accountId,\s*categoryId,\s*pendingOnly,\s*from,\s*to,\s*sortBy,\s*sortDir\s*\]/);
  });

  it("Clear filters resets the debounced search immediately", () => {
    const src = read("src/app/(app)/transactions/page.tsx");
    // the Clear filters handler must clear both q AND debouncedQ so the
    // search drops instantly instead of lingering for the 300ms debounce
    expect(src).toMatch(/setQ\(""\);\s*setDebouncedQ\(""\);/);
    // it lives inside the "No transactions match your filters" empty-state branch
    expect(src).toContain("No transactions match your filters.");
  });

  it("search box uses semantic search semantics (Q36)", () => {
    const src = read("src/app/(app)/transactions/page.tsx");
    // it is a real search field, not a bare text box (native searchbox role)
    expect(src).toContain('type="search"');
    // the filter bar is labelled as a search region for assistive tech
    expect(src).toContain('<div className="flex flex-wrap items-center gap-3" role="search">');
    // the search flexes to fill the primary row without forcing mobile overflow
    expect(src).toContain('className="relative min-w-0 flex-1 basis-64"');
    // the input is linked to the results region it filters
    expect(src).toContain('aria-controls="tx-list"');
    // the input keeps its accessible name
    expect(src).toContain('aria-label="Search transactions"');
    // the results container carries the matching id
    expect(src).toContain('id="tx-list"');
    expect(src).toContain('md:grid-cols-[minmax(0,1fr)_max-content_max-content_max-content_2rem]');
  });
  it("hydrates report drill-down filters from the transaction URL", () => {
    const src = read("src/app/(app)/transactions/page.tsx");
    expect(src).toContain('url.get("categoryId")');
    expect(src).toContain('url.get("uncategorized") === "1"');
    expect(src).toContain('url.get("from")');
    expect(src).toContain('url.get("to")');
    expect(src).toContain('{ value: UNCATEGORIZED_FILTER, label: "Uncategorized" }');
  });

  it("offers compact reversible icon sorting for date, vendor, and amount", () => {
    const src = read("src/app/(app)/transactions/page.tsx");
    expect(src).toContain('aria-label="Sort transactions"');
    expect(src).toContain('Icon: CalendarDays');
    expect(src).toContain('Icon: ALargeSmall');
    expect(src).toContain('Icon: DollarSign');
    expect(src).toContain('field === sortBy');
    expect(src).toContain('sortDir === "asc" ? "desc" : "asc"');
    expect(src).toContain('p.set("sort", sortBy)');
    expect(src).toContain('p.set("dir", sortDir)');
  });

});
