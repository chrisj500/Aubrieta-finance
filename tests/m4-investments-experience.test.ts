import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(path.resolve(__dirname, "../src/app/(app)/investments/page.tsx"), "utf8");
const api = readFileSync(path.resolve(__dirname, "../src/app/api/investments/route.ts"), "utf8");
const sync = readFileSync(path.resolve(__dirname, "../src/server/providers/sync.ts"), "utf8");
const sidebar = readFileSync(path.resolve(__dirname, "../src/components/sidebar.tsx"), "utf8");

describe("M4.7 Investments experience", () => {
  it("adds Investments as a first-class desktop and mobile destination", () => {
    expect(sidebar).toContain('{ href: "/investments", label: "Investments", Icon: TrendingUp }');
    expect(sidebar).toContain('{ href: "/investments", label: "Investments", Icon: TrendingUp, blurb: "Portfolio & holdings" }');
  });

  it("uses the Aubrieta page shell and explains balance vs holding coverage", () => {
    expect(page).toContain('title="Investments"');
    expect(page).toContain('id="investment-overview-heading"');
    expect(page).toContain('label="Investment value"');
    expect(page).toContain('label="Synced holdings"');
    expect(page).toContain('label="Unrealized gain"');
    expect(page).toContain("Account balances are authoritative.");
  });

  it("surfaces investment accounts even without provider holdings", () => {
    expect(page).toContain("<CardTitle>Holdings are not available yet</CardTitle>");
    expect(page).toContain("Position-level holdings will appear automatically");
    expect(page).toContain("account.balanceCents");
  });

  it("renders provider holdings with value, cost-basis gain, and account context", () => {
    expect(page).toContain("<CardTitle>Holdings</CardTitle>");
    expect(page).toContain("holding.accountName");
    expect(page).toContain("holding.quantity");
    expect(page).toContain("holding.priceCents");
    expect(page).toContain("holding.valueCents");
    expect(page).toContain("holding.gainCents");
  });

  it("protects the Investments API with read:investments", () => {
    expect(api).toContain('requireSessionOrAgent(req, ["read:investments"], "get_investments")');
  });

  it("syncs optional provider investment snapshots without making sync depend on them", () => {
    expect(sync).toContain("if (input.provider.getInvestments)");
    expect(sync).toContain("DELETE FROM investment_holdings WHERE connection_id = ? AND user_id = ?");
    expect(sync).toContain("Holdings are additive; keep the last known snapshot if refresh fails.");
  });
});
