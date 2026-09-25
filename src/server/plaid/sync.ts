import { decrypt } from "@/lib/crypto";
import { apiErrors } from "@/lib/api";
import { getDb, type Db } from "@/server/db/adapter";
import type { PlaidClient, PlaidCreds, PlaidEnvironment } from "./adapter";
import { realPlaidClient } from "./real";
import { createPlaidProvider, type PlaidConnectionSecret } from "@/server/providers/plaid";
import { ensureAccountProviderRef, ensureProviderConnection } from "@/server/providers/connections";
import { safeSyncProviderConnection } from "@/server/providers/sync";

export interface SyncResult {
  itemId: string;
  institutionName: string | null;
  added: number;
  modified: number;
  removed: number;
  ok: boolean;
  error?: string;
}

export function createSyncService(
  db: Db = getDb(),
  clientFactory: (creds: PlaidCreds) => PlaidClient = () => realPlaidClient,
) {
  function aad(userId: string, recordId: string): string {
    return `${userId}:plaid:${recordId}`;
  }

  async function syncItem(userId: string, itemRowId: string): Promise<SyncResult> {
    const item = await db.get<{
      id: string;
      plaid_item_id: string | null;
      access_token_enc: string;
      cursor: string | null;
      environment: PlaidEnvironment;
      institution_id: string | null;
      institution_name: string | null;
    }>(
      `SELECT id, plaid_item_id, access_token_enc, cursor, environment,
              institution_id, institution_name
         FROM plaid_items
        WHERE id = ? AND user_id = ?`,
      itemRowId,
      userId,
    );
    if (!item) throw apiErrors.notFound("Item");

    const credsRow = await db.get<{
      id: string;
      client_id_enc: string;
      secret_enc: string;
    }>(
      "SELECT id, client_id_enc, secret_enc FROM plaid_credentials WHERE user_id = ? AND environment = ?",
      userId,
      item.environment,
    );
    if (!credsRow) throw apiErrors.notFound("Plaid credentials");

    const creds: PlaidCreds = {
      clientId: decrypt(credsRow.client_id_enc, aad(userId, credsRow.id)),
      secret: decrypt(credsRow.secret_enc, aad(userId, credsRow.id)),
      environment: item.environment,
    };
    const client = clientFactory(creds);
    const provider = createPlaidProvider(client);
    const accessToken = decrypt(item.access_token_enc, aad(userId, item.id));
    const connectionId = await ensureProviderConnection(db, {
      userId,
      provider,
      externalConnectionId: item.plaid_item_id,
      institutionExternalId: item.institution_id,
      institutionName: item.institution_name,
      status: "active",
      environment: item.environment,
      legacyPlaidItemId: item.id,
    });

    // Preserve a legacy cursor that predates migration 024.
    const connection = await db.get<{ sync_cursor: string | null }>(
      "SELECT sync_cursor FROM provider_connections WHERE id = ?",
      connectionId,
    );
    if (!connection?.sync_cursor && item.cursor) {
      await db.run(
        "UPDATE provider_connections SET sync_cursor = ? WHERE id = ?",
        item.cursor,
        connectionId,
      );
    }

    // Legacy Plaid accounts can be created after migration 023 (tests,
    // imports, older clients). Repair their provider refs before shared sync.
    const legacyAccounts = await db.all<{ id: string; plaid_account_id: string | null }>(
      "SELECT id, plaid_account_id FROM accounts WHERE item_id = ? AND user_id = ?",
      itemRowId,
      userId,
    );
    for (const account of legacyAccounts) {
      if (!account.plaid_account_id) continue;
      await ensureAccountProviderRef(db, {
        userId,
        accountId: account.id,
        connectionId,
        provider: "plaid",
        externalAccountId: account.plaid_account_id,
      });
    }

    const secret: PlaidConnectionSecret = { creds, accessToken };
    const result = await safeSyncProviderConnection(db, {
      userId,
      connectionId,
      provider,
      connectionSecret: secret,
    });

    const state = await db.get<{
      sync_cursor: string | null;
      last_sync_at: string | null;
      status: string;
    }>(
      "SELECT sync_cursor, last_sync_at, status FROM provider_connections WHERE id = ?",
      connectionId,
    );
    await db.run(
      "UPDATE plaid_items SET cursor = ?, last_sync_at = ?, status = ? WHERE id = ?",
      state?.sync_cursor ?? item.cursor,
      state?.last_sync_at ?? null,
      state?.status ?? (result.ok ? "active" : "error"),
      itemRowId,
    );

    return {
      itemId: itemRowId,
      institutionName: result.institutionName ?? item.institution_name,
      added: result.added,
      modified: result.modified,
      removed: result.removed,
      ok: result.ok,
      error: result.error,
    };
  }

  return {
    async syncOne(userId: string, itemRowId: string): Promise<SyncResult> {
      try {
        return await syncItem(userId, itemRowId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Sync failed.";
        await db.run(
          "UPDATE plaid_items SET status = 'error' WHERE id = ?",
          itemRowId,
        ).catch(() => undefined);
        return {
          itemId: itemRowId,
          institutionName: null,
          added: 0,
          modified: 0,
          removed: 0,
          ok: false,
          error: message,
        };
      }
    },

    async syncAll(userId: string): Promise<SyncResult[]> {
      const items = await db.all<{ id: string }>(
        "SELECT id FROM plaid_items WHERE user_id = ?",
        userId,
      );
      const results: SyncResult[] = [];
      for (const item of items) {
        results.push(await this.syncOne(userId, item.id));
      }
      return results;
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
