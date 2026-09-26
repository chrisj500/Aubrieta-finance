import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "./helpers";
import { ensureProviderConnection } from "@/server/providers/connections";
import { isolateProviderBatch } from "@/server/providers/batch-isolation";
import { safeSyncProviderConnection, syncProviderConnection, type ProviderSyncResult } from "@/server/providers/sync";
import type { FinancialProvider } from "@/server/providers/types";

function successfulResult(connectionId = "good"): ProviderSyncResult {
  return {
    connectionId,
    provider: "teller",
    institutionName: "Good Bank",
    added: 1,
    modified: 0,
    removed: 0,
    ok: true,
  };
}

function isolatableProvider(): FinancialProvider {
  return {
    descriptor: {
      kind: "teller",
      displayName: "Teller",
      capabilities: new Set(["accounts", "balances"]),
    },
    async listAccounts(secret) {
      if ((secret as { fail?: boolean }).fail) throw new Error("upstream enrollment unavailable");
      return [{
        externalId: "acct-good",
        institutionExternalId: "good-bank",
        name: "Good Checking",
        officialName: "Good Checking",
        type: "checking",
        subtype: "checking",
        mask: "1001",
        currency: "USD",
        currentBalanceMinor: 12_345,
        availableBalanceMinor: 12_000,
      }];
    },
  };
}

function optionalSnapshotProvider(state: { failOptional: boolean }): FinancialProvider {
  return {
    descriptor: {
      kind: "teller",
      displayName: "Teller",
      capabilities: new Set(["accounts", "balances", "liabilities", "investments", "recurring"]),
    },
    async listAccounts() {
      return [{
        externalId: "acct-snapshot",
        institutionExternalId: "snapshot-bank",
        name: "Snapshot Account",
        officialName: "Snapshot Account",
        type: "credit_card",
        subtype: "credit card",
        mask: "4444",
        currency: "USD",
        currentBalanceMinor: 50_000,
        availableBalanceMinor: null,
      }];
    },
    async getLiabilities() {
      if (state.failOptional) throw new Error("liabilities temporarily unavailable");
      return [{
        accountExternalId: "acct-snapshot",
        kind: "credit_card",
        nextPaymentDueDate: "2026-10-15",
        minimumPaymentMinor: 2_500,
        statementBalanceMinor: 48_765,
        statementDate: "2026-09-25",
        aprBps: 1999,
      }];
    },
    async getInvestments() {
      if (state.failOptional) throw new Error("holdings temporarily unavailable");
      return {
        securities: [{
          externalId: "sec-snapshot",
          name: "Snapshot Fund",
          ticker: "SNAP",
          type: "equity",
          currency: "USD",
        }],
        holdings: [{
          accountExternalId: "acct-snapshot",
          securityExternalId: "sec-snapshot",
          quantity: 2.5,
          institutionPriceMinor: 20_000,
          institutionValueMinor: 50_000,
          costBasisMinor: 40_000,
          currency: "USD",
        }],
      };
    },
    async getRecurringStreams() {
      if (state.failOptional) throw new Error("recurring temporarily unavailable");
      return [{
        externalId: "stream-snapshot",
        accountExternalId: "acct-snapshot",
        direction: "outflow",
        merchant: "Snapshot Streaming",
        description: "Snapshot Streaming",
        cadence: "monthly",
        averageAmountMinor: 1_599,
        lastAmountMinor: 1_599,
        lastDate: "2026-09-10",
        nextExpectedDate: "2026-10-10",
        active: true,
      }];
    },
  };
}

describe("M5.4 provider failure isolation", () => {
  it("turns a provider-wide rejection into a failed result without suppressing another provider", async () => {
    const failure = (provider: "plaid" | "teller") => (error: string): ProviderSyncResult => ({
      connectionId: `${provider}:provider-batch`,
      provider,
      institutionName: null,
      added: 0,
      modified: 0,
      removed: 0,
      ok: false,
      error,
    });
    const [failed, successful] = await Promise.all([
      isolateProviderBatch("plaid", async () => {
        throw new Error("unexpected provider bootstrap failure");
      }, failure("plaid")),
      isolateProviderBatch("teller", async () => [successfulResult()], failure("teller")),
    ]);

    expect(failed).toEqual([{
      connectionId: "plaid:provider-batch",
      provider: "plaid",
      institutionName: null,
      added: 0,
      modified: 0,
      removed: 0,
      ok: false,
      error: "plaid sync failed before individual connections could be processed.",
    }]);
    expect(successful).toEqual([successfulResult()]);
  });

  it("wires the aggregate sync route through the provider-wide isolation boundary", () => {
    const route = readFileSync(
      path.resolve(__dirname, "../src/app/api/transactions/sync/route.ts"),
      "utf8",
    );
    for (const provider of ["plaid", "teller", "simplefin", "akoya"]) {
      expect(route).toMatch(new RegExp(`isolateProviderBatch\\(\\s*"${provider}"`));
    }
  });

  it("records a failed connection without corrupting another successful connection", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m54-connection-isolation");
    const provider = isolatableProvider();
    const goodId = await ensureProviderConnection(db, {
      userId: user.id,
      provider,
      externalConnectionId: "good-enrollment",
      institutionExternalId: "good-bank",
      institutionName: "Good Bank",
      environment: "sandbox",
    });
    const badId = await ensureProviderConnection(db, {
      userId: user.id,
      provider,
      externalConnectionId: "bad-enrollment",
      institutionExternalId: "bad-bank",
      institutionName: "Bad Bank",
      environment: "sandbox",
    });

    const good = await safeSyncProviderConnection(db, {
      userId: user.id,
      connectionId: goodId,
      provider,
      connectionSecret: { fail: false },
    });
    expect(good.ok).toBe(true);
    const before = await db.get<{ current_balance_cents: number; available_balance_cents: number }>(
      `SELECT a.current_balance_cents, a.available_balance_cents
         FROM accounts a
         JOIN account_provider_refs r ON r.account_id = a.id
        WHERE r.connection_id = ?`,
      goodId,
    );

    const bad = await safeSyncProviderConnection(db, {
      userId: user.id,
      connectionId: badId,
      provider,
      connectionSecret: { fail: true },
    });
    expect(bad.ok).toBe(false);

    const goodState = await db.get<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM provider_connections WHERE id = ?",
      goodId,
    );
    const badState = await db.get<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM provider_connections WHERE id = ?",
      badId,
    );
    const after = await db.get<{ current_balance_cents: number; available_balance_cents: number }>(
      `SELECT a.current_balance_cents, a.available_balance_cents
         FROM accounts a
         JOIN account_provider_refs r ON r.account_id = a.id
        WHERE r.connection_id = ?`,
      goodId,
    );

    expect(goodState).toEqual({ status: "active", last_error: null });
    expect(badState?.status).toBe("error");
    expect(badState?.last_error).toContain("upstream enrollment unavailable");
    expect(after).toEqual(before);
  });

  it("preserves liability, holding and recurring snapshots when optional refreshes temporarily fail", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m54-optional-snapshots");
    const state = { failOptional: false };
    const provider = optionalSnapshotProvider(state);
    const connectionId = await ensureProviderConnection(db, {
      userId: user.id,
      provider,
      externalConnectionId: "snapshot-connection",
      institutionExternalId: "snapshot-bank",
      institutionName: "Snapshot Bank",
      environment: "sandbox",
    });

    const first = await syncProviderConnection(db, {
      userId: user.id,
      connectionId,
      provider,
      connectionSecret: {},
    });
    expect(first.ok).toBe(true);

    const liabilityBefore = await db.get<{
      statement_balance_cents: number;
      minimum_payment_cents: number;
      active: number;
    }>(
      "SELECT statement_balance_cents, minimum_payment_cents, active FROM liabilities WHERE connection_id = ?",
      connectionId,
    );
    const holdingBefore = await db.get<{
      quantity: number;
      institution_value_cents: number;
      cost_basis_cents: number;
    }>(
      "SELECT quantity, institution_value_cents, cost_basis_cents FROM investment_holdings WHERE connection_id = ?",
      connectionId,
    );
    const recurringBefore = await db.get<{
      typical_amount_cents: number;
      next_expected_date: string;
      active: number;
    }>(
      "SELECT typical_amount_cents, next_expected_date, active FROM recurring_series WHERE source_provider = 'teller' AND source_external_id = 'stream-snapshot'",
    );

    expect(liabilityBefore).toEqual({ statement_balance_cents: 48_765, minimum_payment_cents: 2_500, active: 1 });
    expect(holdingBefore).toEqual({ quantity: 2.5, institution_value_cents: 50_000, cost_basis_cents: 40_000 });
    expect(recurringBefore).toEqual({ typical_amount_cents: 1_599, next_expected_date: "2026-10-10", active: 1 });

    state.failOptional = true;
    const second = await syncProviderConnection(db, {
      userId: user.id,
      connectionId,
      provider,
      connectionSecret: {},
    });
    expect(second.ok).toBe(true);

    expect(await db.get(
      "SELECT statement_balance_cents, minimum_payment_cents, active FROM liabilities WHERE connection_id = ?",
      connectionId,
    )).toEqual(liabilityBefore);
    expect(await db.get(
      "SELECT quantity, institution_value_cents, cost_basis_cents FROM investment_holdings WHERE connection_id = ?",
      connectionId,
    )).toEqual(holdingBefore);
    expect(await db.get(
      "SELECT typical_amount_cents, next_expected_date, active FROM recurring_series WHERE source_provider = 'teller' AND source_external_id = 'stream-snapshot'",
    )).toEqual(recurringBefore);

    const connection = await db.get<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM provider_connections WHERE id = ?",
      connectionId,
    );
    expect(connection).toEqual({ status: "active", last_error: null });
  });
});
