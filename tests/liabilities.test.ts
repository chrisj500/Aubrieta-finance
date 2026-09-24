import { describe, expect, it } from "vitest";
import { createTestDb, seedManualAccount, seedUser } from "./helpers";
import { syncProviderLiabilities } from "@/server/domain/liabilities";
import { createPlanningService } from "@/server/domain/planning";

async function seedProviderRef(
  db: ReturnType<typeof createTestDb>,
  userId: string,
  accountId: string,
  externalAccountId: string,
) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO provider_connections (
       id, user_id, provider, external_connection_id, institution_name,
       status, capabilities_json, created_at, updated_at
     ) VALUES ('conn-1', ?, 'plaid', 'item-1', 'Test Bank', 'active', '["liabilities"]', ?, ?)`,
    userId,
    now,
    now,
  );
  await db.run(
    `INSERT INTO account_provider_refs (
       id, user_id, account_id, connection_id, provider, external_account_id,
       created_at, updated_at
     ) VALUES ('ref-1', ?, ?, 'conn-1', 'plaid', ?, ?, ?)`,
    userId,
    accountId,
    externalAccountId,
    now,
    now,
  );
}

describe("provider liabilities", () => {
  it("projects a provider-confirmed credit-card minimum into Bills and retains statement balance", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "liability-card");
    const accountId = await seedManualAccount(db, user.id, "Everyday Visa", "credit");
    await seedProviderRef(db, user.id, accountId, "card-ext-1");

    const result = await syncProviderLiabilities(db, user.id, "conn-1", "plaid", [
      {
        accountExternalId: "card-ext-1",
        kind: "credit_card",
        nextPaymentDueDate: "2026-10-15",
        minimumPaymentMinor: 4500,
        statementBalanceMinor: 170877,
        statementDate: "2026-09-28",
        lastPaymentAmountMinor: 5000,
        lastPaymentDate: "2026-09-10",
        aprBps: 2499,
        rawStatus: "current",
      },
    ]);

    expect(result).toMatchObject({ synced: 1, billsUpserted: 1, skippedWithoutAccount: 0 });

    const liability = await db.get<{
      minimum_payment_cents: number;
      statement_balance_cents: number;
      next_payment_due_date: string;
    }>("SELECT minimum_payment_cents, statement_balance_cents, next_payment_due_date FROM liabilities");
    expect(liability).toEqual({
      minimum_payment_cents: 4500,
      statement_balance_cents: 170877,
      next_payment_due_date: "2026-10-15",
    });

    const bills = await createPlanningService(db).listBills(user.id);
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      name: "Everyday Visa payment",
      amount_cents: 4500,
      next_due_date: "2026-10-15",
      source: "provider",
      source_confidence: "confirmed",
      liability_kind: "credit_card",
      minimum_payment_cents: 4500,
      statement_balance_cents: 170877,
      liability_apr_bps: 2499,
    });
  });

  it("uses the next monthly mortgage payment and deactivates stale provider bills", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "liability-mortgage");
    const accountId = await seedManualAccount(db, user.id, "Home Loan", "loan");
    await seedProviderRef(db, user.id, accountId, "mortgage-ext-1");

    await syncProviderLiabilities(db, user.id, "conn-1", "plaid", [
      {
        accountExternalId: "mortgage-ext-1",
        kind: "mortgage",
        nextPaymentDueDate: "2026-10-01",
        nextMonthlyPaymentMinor: 314154,
        aprBps: 399,
        lastPaymentAmountMinor: 314154,
        lastPaymentDate: "2026-09-01",
        rawStatus: "current",
      },
    ]);

    let bill = await db.get<{ amount_cents: number; active: number; next_due_date: string }>(
      "SELECT amount_cents, active, next_due_date FROM bills",
    );
    expect(bill).toEqual({ amount_cents: 314154, active: 1, next_due_date: "2026-10-01" });

    await syncProviderLiabilities(db, user.id, "conn-1", "plaid", []);
    bill = await db.get<{ amount_cents: number; active: number; next_due_date: string }>(
      "SELECT amount_cents, active, next_due_date FROM bills",
    );
    expect(bill?.active).toBe(0);

    const liability = await db.get<{ active: number }>("SELECT active FROM liabilities");
    expect(liability?.active).toBe(0);
  });
});
