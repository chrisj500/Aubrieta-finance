import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const page = readFileSync(join(root, "src/app/(app)/accounts/page.tsx"), "utf8");
const tile = readFileSync(join(root, "src/components/account-brand-tile.tsx"), "utf8");
const identityService = readFileSync(join(root, "src/server/domain/account-identity.ts"), "utf8");
const identityMigration = readFileSync(join(root, "migrations/032_account_identity_normalization.sql"), "utf8");

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

  it("uses server-resolved fixed product palettes only inside the card-art tile", () => {
    expect(page).toContain("<AccountBrandTile");
    expect(page).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(tile).toContain("linear-gradient");
    expect(identityMigration).toContain("#123D67");
    expect(identityMigration).toContain("#A67C2E");
    expect(identityService).not.toContain("var(--");
  });

  it("lets owners correct card identity without exposing confidence in the normal row", () => {
    expect(page).toContain('aria-label={`Edit card identity for ${account.name}`}');
    expect(page).toContain('ariaLabel="Card product identity"');
    expect(page).toContain("Reset to automatic");
    expect(page).not.toContain("identity.confidence");
  });
  it("routes institution groups through the same global sort state", () => {
    expect(page).toContain('sortInstitutionGroups(rows, sortBy, sortDir, includePending)');
  });

  it("lets users replace the institution group icon with their own image", () => {
    expect(page).toContain('queryKey: ["institution-icons"]');
    expect(page).toContain('aria-label={`Edit ${group.name} icon`}');
    expect(page).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(page).toContain('Save icon');
    expect(page).toContain('Use default icon');
  });

});
