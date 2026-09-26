import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConnectionHealthService } from "@/server/domain/connection-health";
import { createTestDb, seedManualAccount, seedUser } from "./helpers";

async function connectAccount(
  db: ReturnType<typeof createTestDb>,
  userId: string,
  accountId: string,
  connectionId: string,
  provider: string,
  externalId: string,
) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO account_provider_refs
       (id, user_id, account_id, connection_id, provider, external_account_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), userId, accountId, connectionId, provider, externalId, now, now,
  );
}

describe("connection health", () => {
  it("normalizes provider status, sync history, capabilities, and linked accounts", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "connection-health");
    const checking = await seedManualAccount(db, user.id, "Checking", "depository");
    const savings = await seedManualAccount(db, user.id, "Savings", "depository");
    await seedManualAccount(db, user.id, "Cash", "cash");
    const plaidId = randomUUID();
    const tellerId = randomUUID();
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO provider_connections
         (id, user_id, provider, external_connection_id, institution_name, status,
          capabilities_json, environment, last_sync_at, last_error, created_at, updated_at)
       VALUES (?, ?, 'plaid', 'plaid-item', 'Primary Bank', 'active',
          '["transactions","accounts","refresh","reauth"]', 'production',
          '2026-09-26T14:00:00.000Z', NULL, ?, ?),
        (?, ?, 'teller', 'enrollment-1', 'Credit Union', 'error',
          '["accounts","balances","refresh","reauth"]', 'development',
          NULL, 'Login expired', ?, ?)`,
      plaidId, user.id, now, now,
      tellerId, user.id, now, now,
    );
    await connectAccount(db, user.id, checking, plaidId, "plaid", "checking-ext");
    await connectAccount(db, user.id, savings, tellerId, "teller", "savings-ext");

    const health = await createConnectionHealthService(db).get(user.id);

    expect(health.summary).toMatchObject({
      connectionCount: 2,
      healthyCount: 1,
      needsAttentionCount: 1,
      neverSyncedCount: 1,
      manualAccountCount: 1,
      lastSuccessfulSyncAt: "2026-09-26T14:00:00.000Z",
    });
    expect(health.connections.map((c) => c.institutionName)).toEqual(["Credit Union", "Primary Bank"]);
    expect(health.connections[0]).toMatchObject({
      provider: "teller",
      providerName: "Teller",
      state: "needs_attention",
      rawStatus: "error",
      lastError: "Login expired",
      supportsRefresh: true,
      supportsReauth: true,
      accountCount: 1,
      accountNames: ["Savings"],
    });
    expect(health.connections[1].capabilities).toEqual(["accounts", "reauth", "refresh", "transactions"]);
  });

  it("fails soft on malformed capability metadata and never leaks another user's connections", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "connection-health-owner");
    const other = await seedUser(db, "connection-health-other");
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO provider_connections
         (id, user_id, provider, external_connection_id, institution_name, status,
          capabilities_json, environment, last_sync_at, last_error, created_at, updated_at)
       VALUES (?, ?, 'simplefin', 'mine', NULL, 'active', 'not-json', 'simplefin', NULL, '   ', ?, ?),
              (?, ?, 'akoya', 'theirs', 'Other Bank', 'error', '["accounts"]', 'sandbox', NULL, 'Nope', ?, ?)`,
      randomUUID(), user.id, now, now,
      randomUUID(), other.id, now, now,
    );

    const health = await createConnectionHealthService(db).get(user.id);

    expect(health.summary.connectionCount).toBe(1);
    expect(health.summary.healthyCount).toBe(1);
    expect(health.summary.needsAttentionCount).toBe(0);
    expect(health.summary.neverSyncedCount).toBe(1);
    expect(health.connections[0]).toMatchObject({
      provider: "simplefin",
      providerName: "SimpleFIN",
      institutionName: "SimpleFIN connection",
      state: "healthy",
      capabilities: [],
      lastError: null,
    });
  });

  it("preserves internal or future provider identity instead of mislabeling it", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "connection-health-demo");
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO provider_connections
         (id, user_id, provider, external_connection_id, institution_name, status,
          capabilities_json, created_at, updated_at)
       VALUES (?, ?, 'demo', 'demo-connection', NULL, 'active', '[]', ?, ?)`,
      randomUUID(), user.id, now, now,
    );

    const health = await createConnectionHealthService(db).get(user.id);
    expect(health.connections[0]).toMatchObject({
      provider: "demo",
      providerName: "Aubrieta Demo",
      institutionName: "Aubrieta Demo connection",
      state: "healthy",
    });
  });
});
