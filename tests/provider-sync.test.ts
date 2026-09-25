import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "./helpers";
import { ensureProviderConnection } from "@/server/providers/connections";
import { syncProviderConnection } from "@/server/providers/sync";
import type { FinancialProvider, ProviderTransactionSync } from "@/server/providers/types";

function fakeTellerProvider(): FinancialProvider {
  let calls = 0;
  return {
    descriptor: {
      kind: "teller",
      displayName: "Teller",
      capabilities: new Set(["accounts", "balances", "transactions"]),
    },
    async listAccounts() {
      return [{
        externalId: "acc-teller-1",
        institutionExternalId: "test-bank",
        name: "Everyday Checking",
        officialName: "Everyday Checking",
        type: "checking",
        subtype: "checking",
        mask: "1234",
        currency: "USD",
        currentBalanceMinor: 100_000,
        availableBalanceMinor: 95_000,
      }];
    },
    async syncTransactions(): Promise<ProviderTransactionSync> {
      calls++;
      return {
        added: [{
          externalId: "txn-teller-1",
          accountExternalId: "acc-teller-1",
          amountMinor: calls === 1 ? -1_200 : -1_350,
          currency: "USD",
          date: "2026-09-24",
          authorizedDate: null,
          name: "Whole Foods Market",
          merchant: "Whole Foods",
          pending: calls === 1,
          categoryHint: "groceries",
          categoryPath: "groceries",
          personalFinanceCategory: null,
        }],
        modified: [],
        removedExternalIds: [],
        nextCursor: { value: "2026-09-24" },
      };
    },
  };
}

describe("provider-neutral sync", () => {
  it("creates canonical accounts/transactions and updates them by provider reference", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "provider-sync");
    const provider = fakeTellerProvider();
    const connectionId = await ensureProviderConnection(db, {
      userId: user.id,
      provider,
      externalConnectionId: "enr_test_1",
      institutionExternalId: "test-bank",
      institutionName: "Test Bank",
      environment: "sandbox",
    });

    const first = await syncProviderConnection(db, {
      userId: user.id,
      connectionId,
      provider,
      connectionSecret: { token: "test" },
    });
    expect(first.ok).toBe(true);
    expect(first.added).toBe(1);

    const account = await db.get<{
      id: string;
      current_balance_cents: number;
      available_balance_cents: number;
      plaid_account_id: string | null;
    }>("SELECT id, current_balance_cents, available_balance_cents, plaid_account_id FROM accounts WHERE user_id = ?", user.id);
    expect(account).toMatchObject({
      current_balance_cents: 100_000,
      available_balance_cents: 95_000,
      plaid_account_id: null,
    });

    const ref = await db.get<{ provider: string; external_account_id: string }>(
      "SELECT provider, external_account_id FROM account_provider_refs WHERE account_id = ?",
      account!.id,
    );
    expect(ref).toEqual({ provider: "teller", external_account_id: "acc-teller-1" });

    let txn = await db.get<{
      id: string;
      amount_cents: number;
      pending: number;
      source: string;
      plaid_transaction_id: string | null;
    }>("SELECT id, amount_cents, pending, source, plaid_transaction_id FROM transactions");
    expect(txn).toMatchObject({
      amount_cents: -1_200,
      pending: 1,
      source: "teller",
      plaid_transaction_id: null,
    });

    const txnRef = await db.get<{ provider: string; external_transaction_id: string }>(
      "SELECT provider, external_transaction_id FROM transaction_provider_refs WHERE transaction_id = ?",
      txn!.id,
    );
    expect(txnRef).toEqual({ provider: "teller", external_transaction_id: "txn-teller-1" });

    const second = await syncProviderConnection(db, {
      userId: user.id,
      connectionId,
      provider,
      connectionSecret: { token: "test" },
    });
    expect(second.modified).toBe(1);

    const count = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions");
    expect(count?.n).toBe(1);
    txn = await db.get("SELECT id, amount_cents, pending, source, plaid_transaction_id FROM transactions");
    expect(txn).toMatchObject({
      amount_cents: -1_350,
      pending: 0,
      source: "teller",
    });

    const connection = await db.get<{ sync_cursor: string; status: string; last_error: string | null }>(
      "SELECT sync_cursor, status, last_error FROM provider_connections WHERE id = ?",
      connectionId,
    );
    expect(connection).toEqual({ sync_cursor: "2026-09-24", status: "active", last_error: null });
  });

  it("keeps a canonical transaction when another provider still references it", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "provider-history");
    const provider = fakeTellerProvider();
    const connectionId = await ensureProviderConnection(db, {
      userId: user.id,
      provider,
      externalConnectionId: "enr_test_2",
      institutionExternalId: "test-bank",
      institutionName: "Test Bank",
      environment: "sandbox",
    });
    await syncProviderConnection(db, {
      userId: user.id,
      connectionId,
      provider,
      connectionSecret: {},
    });
    const txn = await db.get<{ id: string; account_id: string }>("SELECT id, account_id FROM transactions");
    const plaidConnection = await ensureProviderConnection(db, {
      userId: user.id,
      provider: {
        descriptor: { kind: "plaid", displayName: "Plaid", capabilities: new Set(["transactions"]) },
        async listAccounts() { return []; },
      },
      externalConnectionId: "plaid-item-history",
      institutionExternalId: "ins_history",
      institutionName: "Other Provider",
      environment: "sandbox",
    });
    await db.run(
      `INSERT INTO transaction_provider_refs (
         id, user_id, transaction_id, account_id, connection_id, provider,
         external_transaction_id, created_at, updated_at
       ) VALUES ('other-ref', ?, ?, ?, ?, 'plaid', 'plaid-same-txn', ?, ?)`,
      user.id, txn!.id, txn!.account_id, plaidConnection,
      new Date().toISOString(), new Date().toISOString(),
    );

    const { createIngestService } = await import("@/server/domain/ingest");
    await createIngestService(db).remove("teller", "txn-teller-1");

    expect(await db.get("SELECT id FROM transactions WHERE id = ?", txn!.id)).toBeTruthy();
    expect(await db.get("SELECT id FROM transaction_provider_refs WHERE provider = 'plaid' AND transaction_id = ?", txn!.id)).toBeTruthy();
  });
});
