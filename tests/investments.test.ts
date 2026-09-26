import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "./helpers";
import { ensureProviderConnection } from "@/server/providers/connections";
import { syncProviderConnection } from "@/server/providers/sync";
import { createInvestmentsService } from "@/server/domain/investments";
import type { FinancialProvider } from "@/server/providers/types";

function investmentProvider(): FinancialProvider {
  return {
    descriptor: {
      kind: "teller",
      displayName: "Test Brokerage",
      capabilities: new Set(["accounts", "balances", "investments"]),
    },
    async listAccounts() {
      return [{
        externalId: "brokerage-1",
        name: "Brokerage",
        officialName: "Individual Brokerage",
        type: "investment",
        subtype: "brokerage",
        mask: "9001",
        currency: "USD",
        currentBalanceMinor: 20_000_00,
        availableBalanceMinor: null,
      }];
    },
    async getInvestments() {
      return {
        securities: [
          {
            externalId: "sec-vti",
            name: "Vanguard Total Stock Market ETF",
            ticker: "VTI",
            isin: null,
            cusip: null,
            type: "equity",
            currency: "USD",
          },
          {
            externalId: "sec-vxus",
            name: "Vanguard Total International Stock ETF",
            ticker: "VXUS",
            isin: null,
            cusip: null,
            type: "equity",
            currency: "USD",
          },
        ],
        holdings: [
          {
            accountExternalId: "brokerage-1",
            securityExternalId: "sec-vti",
            quantity: 40,
            institutionPriceMinor: 285_00,
            institutionValueMinor: 11_400_00,
            costBasisMinor: 8_600_00,
            currency: "USD",
          },
          {
            accountExternalId: "brokerage-1",
            securityExternalId: "sec-vxus",
            quantity: 95,
            institutionPriceMinor: 62_00,
            institutionValueMinor: 5_890_00,
            costBasisMinor: 5_100_00,
            currency: "USD",
          },
        ],
      };
    },
  };
}

describe("investments", () => {
  it("persists provider holdings and computes portfolio metrics", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "investor");
    const provider = investmentProvider();
    const connectionId = await ensureProviderConnection(db, {
      userId: user.id,
      provider,
      externalConnectionId: "brokerage-enrollment",
      institutionExternalId: "test-broker",
      institutionName: "Test Brokerage",
      environment: "sandbox",
    });

    await syncProviderConnection(db, {
      userId: user.id,
      connectionId,
      provider,
      connectionSecret: {},
    });

    const holdingCount = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM investment_holdings WHERE user_id = ?",
      user.id,
    );
    expect(holdingCount?.n).toBe(2);

    const overview = await createInvestmentsService(db).overview(user.id);
    expect(overview.accounts).toHaveLength(1);
    expect(overview.accounts[0]).toMatchObject({
      name: "Brokerage",
      balanceCents: 20_000_00,
      holdingsCount: 2,
      holdingsValueCents: 17_290_00,
    });
    expect(overview.totalValueCents).toBe(20_000_00);
    expect(overview.holdingsValueCents).toBe(17_290_00);
    expect(overview.unallocatedValueCents).toBe(2_710_00);
    expect(overview.totalCostBasisCents).toBe(13_700_00);
    expect(overview.totalGainCents).toBe(3_590_00);
    expect(overview.totalGainPct).toBeCloseTo(26.2, 1);
  });

  it("keeps investment-account balances useful when no holdings are available", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "balance-only-investor");
    await db.run(
      `INSERT INTO accounts
         (id, user_id, name, type, current_balance_cents, currency, created_at)
       VALUES ('investment-only', ?, '401(k)', 'investment', 900000, 'USD', ?)`,
      user.id,
      new Date().toISOString(),
    );

    const overview = await createInvestmentsService(db).overview(user.id);
    expect(overview.totalValueCents).toBe(900000);
    expect(overview.holdings).toEqual([]);
    expect(overview.unallocatedValueCents).toBe(900000);
    expect(overview.totalGainCents).toBeNull();
  });
});
