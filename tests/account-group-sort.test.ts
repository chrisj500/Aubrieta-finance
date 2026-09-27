import { describe, expect, it } from "vitest";
import { sortInstitutionGroups } from "@/lib/account-group-sort";

const groups = [
  {
    name: "American Express",
    accounts: [
      { name: "Gold", current_balance_cents: -861507, balance_with_pending_cents: -861507, next_payment_due_date: "2026-10-18" },
    ],
  },
  {
    name: "Chase Bank",
    accounts: [
      { name: "Sapphire", current_balance_cents: -764374, balance_with_pending_cents: -786147, next_payment_due_date: "2026-10-12" },
    ],
  },
];

describe("institution group sorting", () => {
  it("sorts group cards by name in either direction", () => {
    expect(sortInstitutionGroups(groups, "name", "asc", true).map((g) => g.name)).toEqual(["American Express", "Chase Bank"]);
    expect(sortInstitutionGroups(groups, "name", "desc", true).map((g) => g.name)).toEqual(["Chase Bank", "American Express"]);
  });

  it("sorts group cards by aggregate balance using the pending preference", () => {
    expect(sortInstitutionGroups(groups, "balance", "desc", false).map((g) => g.name)).toEqual(["American Express", "Chase Bank"]);
    expect(sortInstitutionGroups(groups, "balance", "asc", true).map((g) => g.name)).toEqual(["Chase Bank", "American Express"]);
  });

  it("sorts group cards by their earliest account due date", () => {
    expect(sortInstitutionGroups(groups, "due", "asc", true).map((g) => g.name)).toEqual(["Chase Bank", "American Express"]);
    expect(sortInstitutionGroups(groups, "due", "desc", true).map((g) => g.name)).toEqual(["American Express", "Chase Bank"]);
  });
});
