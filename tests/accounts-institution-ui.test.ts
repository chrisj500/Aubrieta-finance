import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const page = readFileSync(join(root, "src/app/(app)/accounts/page.tsx"), "utf8");
const tile = readFileSync(join(root, "src/components/account-brand-tile.tsx"), "utf8");
const identity = readFileSync(join(root, "src/lib/card-identity.ts"), "utf8");

describe("institution-first Accounts experience", () => {
  it("groups accounts by institution and keeps groups collapsed until requested", () => {
    expect(page).toContain("institutionGroups.map");
    expect(page).toContain("expandedGroups.includes(group.name)");
    expect(page).toContain("Show accounts");
    expect(page).toContain("Hide accounts");
    expect(page).toContain("Assets");
    expect(page).toContain("Owed");
  });

  it("provides account-type filters and reversible icon sorting", () => {
    expect(page).toContain('aria-label="Filter accounts by type"');
    expect(page).toContain('aria-label="Sort accounts"');
    expect(page).toContain("Icon: ALargeSmall");
    expect(page).toContain("Icon: DollarSign");
    expect(page).toContain("Icon: CalendarClock");
    expect(page).toContain('field === "due" && !hasDueDates');
    expect(page).toContain('current === "asc" ? "desc" : "asc"');
  });

  it("supports explicit multi-select bulk type, privacy, and net-worth changes", () => {
    expect(page).toContain('ariaLabel="Bulk account type"');
    expect(page).toContain('ariaLabel="Bulk visibility"');
    expect(page).toContain('ariaLabel="Bulk net-worth inclusion"');
    expect(page).toContain('api.patch<{ updated: number }>("/api/accounts/bulk"');
    expect(page).toContain('{ value: "private", label: "Private" }');
    expect(page).toContain('{ value: "shared", label: "Household" }');
  });

  it("uses fixed predicted product palettes only inside the card-art tile", () => {
    expect(page).toContain("<AccountBrandTile");
    expect(page).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(tile).toContain("linear-gradient");
    expect(identity).toContain('primary: "#123D67"');
    expect(identity).toContain('primary: "#A67C2E"');
    expect(identity).not.toContain("var(--");
  });
});
