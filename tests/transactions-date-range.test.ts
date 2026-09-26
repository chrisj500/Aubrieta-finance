import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("transactions date-range filter", () => {
  it("wires From/To date pickers into the list query", () => {
    const src = read("src/app/(app)/transactions/page.tsx");
    // both picker states exist
    expect(src).toMatch(/const \[from, setFrom\] = useState\(""\);/);
    expect(src).toMatch(/const \[to, setTo\] = useState\(""\);/);
    // pickers are rendered with aria-labels
    expect(src).toContain('ariaLabel="From date"');
    expect(src).toContain('ariaLabel="To date"');
    // query params include the date window
    expect(src).toContain('if (from) p.set("from", from);');
    expect(src).toContain('if (to) p.set("to", to);');
    // memo deps include from + to
    expect(src).toMatch(/\[\s*debouncedQ,\s*accountId,\s*categoryId,\s*pendingOnly,\s*from,\s*to\s*\]/);
  });

  it("Clear filters resets both date bounds", () => {
    const src = read("src/app/(app)/transactions/page.tsx");
    // active-filter detection covers both date bounds and drives the empty state
    expect(src).toContain("const hasFilters = Boolean(q || accountId || categoryId || pendingOnly || from || to);");
    expect(src).toContain("{hasFilters ? (");
    // the shared Clear filters handler clears from + to
    expect(src).toMatch(/setPendingOnly\(false\);\s*setFrom\(""\);\s*setTo\(""\);/);
    expect(src).toContain("onClick={clearFilters}");
  });
});
