import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.resolve(__dirname, "../src/app/(app)/plan/page.tsx"), "utf8");

describe("M4.3 Bills experience", () => {
  it("uses the Aubrieta page shell and gives Plan a visible purpose", () => {
    expect(src).toContain('import { Page, PageHeader } from "@/components/ui/page"');
    expect(src).toContain('title="Plan"');
    expect(src).toContain('description="Stay ahead of bills first, then plan for debt, goals, and the months ahead."');
  });

  it("puts current bill obligations ahead of longer-range forecasting", () => {
    expect(src).toContain('id="bills-overview-heading"');
    expect(src).toContain('label="Due in view"');
    expect(src).toContain('value={<Money cents={focusedBillTotalCents} />}');
    expect(src).toContain('hint="next 30 days + overdue"');
    expect(src).toContain('label="Overdue"');
    expect(src).toContain('label="Active bills"');
    expect(src).toContain('id="planning-ahead-heading"');
    expect(src.indexOf('id="bills-overview-heading"')).toBeLessThan(src.indexOf('id="planning-ahead-heading"'));
  });

  it("keeps the bill calendar focused by default with an explicit expanded history view", () => {
    expect(src).toContain('const [showAllOccurrences, setShowAllOccurrences] = useState(false);');
    expect(src).toContain('o.status === "overdue" || (o.status === "upcoming"');
    expect(src).toContain('"Show all 165 days"');
    expect(src).toContain('"Show next 30 days"');
    expect(src).toContain('aria-expanded={showAllOccurrences}');
  });
});
