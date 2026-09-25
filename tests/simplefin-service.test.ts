import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "./helpers";
import { createSimpleFinService } from "@/server/simplefin/service";
import type {
  SimpleFinConnectionDescriptor,
  SimpleFinProvider,
} from "@/server/providers/simplefin";
import type {
  ProviderAccount,
  ProviderTransactionSync,
} from "@/server/providers/types";

function fakeProvider(): {
  provider: SimpleFinProvider;
  setDiscoverHealthy(value: boolean): void;
} {
  let discoverHealthy = false;

  const provider: SimpleFinProvider = {
    descriptor: {
      kind: "simplefin",
      displayName: "SimpleFIN",
      capabilities: new Set(["accounts", "balances", "transactions", "refresh", "reauth"]),
    },

    async claimSetupToken() {
      return "https://demo-user:demo-pass@bridge.example/simplefin";
    },

    async discoverConnections(): Promise<SimpleFinConnectionDescriptor[]> {
      if (!discoverHealthy) throw new Error("Temporary Bridge failure.");
      return [{
        remoteConnectionId: "conn-1",
        externalConnectionId: "sf:scope-1",
        scopeKey: "sf:scope-1",
        institutionExternalId: "bank-1",
        institutionName: "Test Bank",
        accountCount: 1,
      }];
    },

    async listAccounts(): Promise<ProviderAccount[]> {
      return [{
        externalId: "sf:scope-1:a:acct-1",
        institutionExternalId: "bank-1",
        name: "Checking",
        officialName: null,
        type: "checking",
        subtype: null,
        mask: null,
        currency: "USD",
        currentBalanceMinor: 100_000,
        availableBalanceMinor: 95_000,
      }];
    },

    async syncTransactions(): Promise<ProviderTransactionSync> {
      return {
        added: [{
          externalId: "sf:scope-1:a:acct-1:t:txn-1",
          accountExternalId: "sf:scope-1:a:acct-1",
          amountMinor: -1_250,
          currency: "USD",
          date: "2026-09-24",
          authorizedDate: null,
          name: "Coffee",
          merchant: "Coffee",
          pending: false,
          categoryHint: null,
          categoryPath: null,
          personalFinanceCategory: null,
        }],
        modified: [],
        removedExternalIds: [],
        nextCursor: { value: "sf1:123" },
      };
    },
  };

  return {
    provider,
    setDiscoverHealthy(value: boolean) {
      discoverHealthy = value;
    },
  };
}

describe("SimpleFIN service", () => {
  it("persists the claimed Access URL before discovery and can retry without another token", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "simplefin-retry");
    const fake = fakeProvider();
    const service = createSimpleFinService(db, fake.provider);

    const first = await service.connectSetupToken(user.id, "setup-token");
    expect(first.connected).toBe(false);
    if (first.connected) throw new Error("expected pending grant");

    const grant = await db.get<{
      id: string;
      config_enc: string;
      public_config_json: string;
    }>(
      "SELECT id, config_enc, public_config_json FROM provider_credentials WHERE user_id = ? AND provider = 'simplefin'",
      user.id,
    );
    expect(grant?.id).toBe(first.pendingGrantId);
    expect(grant?.config_enc).not.toContain("demo-pass");
    expect(grant?.public_config_json).not.toContain("demo-pass");
    expect(grant?.public_config_json).toContain("bridge.example");

    fake.setDiscoverHealthy(true);
    const second = await service.retryGrant(user.id, first.pendingGrantId);
    expect(second.connected).toBe(true);
    if (!second.connected) throw new Error("expected completed setup");
    expect(second.connectionCount).toBe(1);
    expect(second.accountCount).toBe(1);
    expect(second.synced).toBe(1);

    expect(
      await db.get(
        "SELECT id FROM provider_credentials WHERE id = ?",
        first.pendingGrantId,
      ),
    ).toBeUndefined();

    const connection = await db.get<{
      id: string;
      provider: string;
      external_connection_id: string;
      institution_name: string;
      sync_cursor: string;
      status: string;
    }>(
      "SELECT id, provider, external_connection_id, institution_name, sync_cursor, status FROM provider_connections WHERE user_id = ?",
      user.id,
    );
    expect(connection).toMatchObject({
      provider: "simplefin",
      external_connection_id: "sf:scope-1",
      institution_name: "Test Bank",
      sync_cursor: "sf1:123",
      status: "active",
    });

    const account = await db.get<{
      id: string;
      current_balance_cents: number;
      available_balance_cents: number;
    }>(
      "SELECT id, current_balance_cents, available_balance_cents FROM accounts WHERE user_id = ?",
      user.id,
    );
    expect(account).toMatchObject({
      current_balance_cents: 100_000,
      available_balance_cents: 95_000,
    });

    const txn = await db.get<{
      amount_cents: number;
      source: string;
      plaid_transaction_id: string | null;
    }>(
      "SELECT amount_cents, source, plaid_transaction_id FROM transactions WHERE account_id = ?",
      account!.id,
    );
    expect(txn).toEqual({
      amount_cents: -1_250,
      source: "simplefin",
      plaid_transaction_id: null,
    });

    const secret = await db.get<{ secret_enc: string }>(
      "SELECT secret_enc FROM provider_connection_secrets WHERE connection_id = ?",
      connection!.id,
    );
    expect(secret?.secret_enc).not.toContain("demo-pass");
  });

  it("overlapping sync deliveries update the same canonical transaction", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "simplefin-overlap");
    const fake = fakeProvider();
    fake.setDiscoverHealthy(true);
    const service = createSimpleFinService(db, fake.provider);

    const connected = await service.connectSetupToken(user.id, "setup-token");
    expect(connected.connected).toBe(true);

    const second = await service.syncAll(user.id);
    expect(second).toHaveLength(1);
    expect(second[0].added).toBe(0);
    expect(second[0].modified).toBe(1);

    const count = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions",
    );
    expect(count?.n).toBe(1);
  });

  it("removes the provider connection without deleting canonical history", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "simplefin-remove");
    const fake = fakeProvider();
    fake.setDiscoverHealthy(true);
    const service = createSimpleFinService(db, fake.provider);

    const connected = await service.connectSetupToken(user.id, "setup-token");
    expect(connected.connected).toBe(true);

    const connection = await db.get<{ id: string }>(
      "SELECT id FROM provider_connections WHERE user_id = ? AND provider = 'simplefin'",
      user.id,
    );
    await service.removeConnection(user.id, connection!.id);

    expect(
      await db.get(
        "SELECT id FROM provider_connections WHERE id = ?",
        connection!.id,
      ),
    ).toBeUndefined();
    expect(
      await db.get("SELECT id FROM transactions LIMIT 1"),
    ).toBeTruthy();
  });
});
