import { createHash, randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import type { Db } from "@/server/db/types";
import {
  createSimpleFinProvider,
  splitSimpleFinAccessUrl,
  type SimpleFinConnectionSecret,
  type SimpleFinProvider,
} from "@/server/providers/simplefin";
import { ensureProviderConnection } from "@/server/providers/connections";
import { safeSyncProviderConnection, type ProviderSyncResult } from "@/server/providers/sync";
import { createCategoriesService } from "@/server/domain/categories";
import { createIngestService } from "@/server/domain/ingest";
import { markLinkedTransfers } from "@/server/domain/transfers";

function now(): string {
  return new Date().toISOString();
}

const DAY_SECONDS = 86_400;
const BACKFILL_WINDOW_DAYS = 45;
const BACKFILL_OVERLAP_DAYS = 5;
const BACKFILL_PREFIX = "sfb1:";
const FORWARD_CURSOR_PREFIX = "sf1:";

function aad(userId: string, id: string): string {
  return `${userId}:provider:${id}`;
}

function grantEnvironment(accessUrl: string): string {
  return `grant:${createHash("sha256").update(accessUrl).digest("hex").slice(0, 24)}`;
}

function publicGrantInfo(accessUrl: string): { host: string } {
  const { baseUrl } = splitSimpleFinAccessUrl(accessUrl);
  const url = new URL(baseUrl);
  return { host: url.host };
}

export function createSimpleFinService(
  db: Db,
  provider: SimpleFinProvider = createSimpleFinProvider(),
) {
  async function saveClaimedGrant(userId: string, accessUrl: string): Promise<string> {
    const environment = grantEnvironment(accessUrl);
    const existing = await db.get<{ id: string }>(
      "SELECT id FROM provider_credentials WHERE user_id = ? AND provider = 'simplefin' AND environment = ?",
      userId,
      environment,
    );
    const id = existing?.id ?? randomUUID();
    const ts = now();
    const configEnc = encrypt(JSON.stringify({ accessUrl }), aad(userId, id));
    const publicJson = JSON.stringify({
      ...publicGrantInfo(accessUrl),
      claimedAt: ts,
    });
    if (existing) {
      await db.run(
        "UPDATE provider_credentials SET config_enc = ?, public_config_json = ?, updated_at = ? WHERE id = ?",
        configEnc,
        publicJson,
        ts,
        id,
      );
    } else {
      await db.run(
        `INSERT INTO provider_credentials
           (id, user_id, provider, environment, config_enc, public_config_json, updated_at)
         VALUES (?, ?, 'simplefin', ?, ?, ?, ?)`,
        id,
        userId,
        environment,
        configEnc,
        publicJson,
        ts,
      );
    }
    return id;
  }

  async function loadGrant(userId: string, grantId: string): Promise<{ accessUrl: string }> {
    const row = await db.get<{ id: string; config_enc: string }>(
      `SELECT id, config_enc FROM provider_credentials
        WHERE id = ? AND user_id = ? AND provider = 'simplefin' AND environment LIKE 'grant:%'`,
      grantId,
      userId,
    );
    if (!row) throw new Error("Saved SimpleFIN claim was not found.");
    return JSON.parse(decrypt(row.config_enc, aad(userId, row.id))) as { accessUrl: string };
  }

  async function getConnectionSecret(userId: string, connectionId: string): Promise<SimpleFinConnectionSecret> {
    const row = await db.get<{ secret_enc: string }>(
      `SELECT pcs.secret_enc
         FROM provider_connection_secrets pcs
         JOIN provider_connections pc ON pc.id = pcs.connection_id
        WHERE pcs.connection_id = ? AND pcs.user_id = ?
          AND pc.user_id = ? AND pc.provider = 'simplefin'`,
      connectionId,
      userId,
      userId,
    );
    if (!row) throw new Error("SimpleFIN connection secret is missing.");
    const secret = JSON.parse(decrypt(row.secret_enc, aad(userId, connectionId))) as SimpleFinConnectionSecret;
    if (!secret.accessUrl || !secret.remoteConnectionId || !secret.scopeKey) {
      throw new Error("SimpleFIN connection secret is invalid.");
    }
    return secret;
  }

  async function finalizeGrant(userId: string, grantId: string) {
    const { accessUrl } = await loadGrant(userId, grantId);
    const discovered = await provider.discoverConnections(accessUrl);
    if (discovered.length === 0) {
      throw new Error("SimpleFIN did not return any bank connections.");
    }

    const results: ProviderSyncResult[] = [];
    let accountCount = 0;
    for (const connection of discovered) {
      const connectionId = await ensureProviderConnection(db, {
        userId,
        provider,
        externalConnectionId: connection.externalConnectionId,
        institutionExternalId: connection.institutionExternalId,
        institutionName: connection.institutionName,
        status: "active",
        environment: "simplefin",
      });
      const secret: SimpleFinConnectionSecret = {
        accessUrl,
        remoteConnectionId: connection.remoteConnectionId,
        scopeKey: connection.scopeKey,
      };
      const ts = now();
      await db.run(
        `INSERT INTO provider_connection_secrets
           (connection_id, user_id, secret_enc, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id)
         DO UPDATE SET secret_enc = excluded.secret_enc, updated_at = excluded.updated_at`,
        connectionId,
        userId,
        encrypt(JSON.stringify(secret), aad(userId, connectionId)),
        ts,
      );
      accountCount += connection.accountCount;
      results.push(
        await safeSyncProviderConnection(db, {
          userId,
          connectionId,
          provider,
          connectionSecret: secret,
        }),
      );
    }

    await db.run(
      "DELETE FROM provider_credentials WHERE id = ? AND user_id = ? AND provider = 'simplefin'",
      grantId,
      userId,
    );

    return {
      connected: true as const,
      connectionCount: discovered.length,
      accountCount,
      synced: results.reduce((n, r) => n + r.added + r.modified, 0),
      results,
    };
  }

  return {
    async connectSetupToken(userId: string, setupToken: string) {
      const accessUrl = await provider.claimSetupToken(setupToken);
      const grantId = await saveClaimedGrant(userId, accessUrl);
      try {
        return await finalizeGrant(userId, grantId);
      } catch (err) {
        return {
          connected: false as const,
          pendingGrantId: grantId,
          error: err instanceof Error ? err.message : "Could not finish SimpleFIN setup.",
        };
      }
    },

    async retryGrant(userId: string, grantId: string) {
      try {
        return await finalizeGrant(userId, grantId);
      } catch (err) {
        return {
          connected: false as const,
          pendingGrantId: grantId,
          error: err instanceof Error ? err.message : "Could not finish SimpleFIN setup.",
        };
      }
    },

    async discardGrant(userId: string, grantId: string): Promise<void> {
      await db.run(
        `DELETE FROM provider_credentials
          WHERE id = ? AND user_id = ? AND provider = 'simplefin' AND environment LIKE 'grant:%'`,
        grantId,
        userId,
      );
    },

    async listConnections(userId: string) {
      const rows = await db.all<{
        id: string;
        external_connection_id: string | null;
        institution_name: string | null;
        institution_external_id: string | null;
        environment: string | null;
        status: string;
        last_sync_at: string | null;
        last_error: string | null;
        backfill_cursor: string | null;
      }>(
        `SELECT id, external_connection_id, institution_name, institution_external_id,
                environment, status, last_sync_at, last_error, backfill_cursor
           FROM provider_connections
          WHERE user_id = ? AND provider = 'simplefin'
          ORDER BY institution_name COLLATE NOCASE, created_at DESC`,
        userId,
      );
      const connections = [];
      for (const row of rows) {
        const accounts = await db.all<{ id: string; name: string }>(
          `SELECT a.id, a.name
             FROM accounts a
             JOIN account_provider_refs r ON r.account_id = a.id
            WHERE r.connection_id = ? AND r.provider = 'simplefin'
            ORDER BY a.name COLLATE NOCASE`,
          row.id,
        );
        const backfillSeconds = row.backfill_cursor?.startsWith(BACKFILL_PREFIX)
          ? Number.parseInt(row.backfill_cursor.slice(BACKFILL_PREFIX.length), 10)
          : NaN;
        connections.push({
          ...row,
          backfillBefore: Number.isFinite(backfillSeconds)
            ? new Date(backfillSeconds * 1000).toISOString().slice(0, 10)
            : null,
          accounts,
        });
      }

      const pendingGrants = await db.all<{
        id: string;
        public_config_json: string;
        updated_at: string;
      }>(
        `SELECT id, public_config_json, updated_at
           FROM provider_credentials
          WHERE user_id = ? AND provider = 'simplefin' AND environment LIKE 'grant:%'
          ORDER BY updated_at DESC`,
        userId,
      ).then((items) =>
        items.map((item) => {
          let publicConfig: { host?: string; claimedAt?: string } = {};
          try {
            publicConfig = JSON.parse(item.public_config_json);
          } catch {
            // Public metadata is optional; never decrypt the Access URL for UI.
          }
          return {
            id: item.id,
            host: publicConfig.host ?? "SimpleFIN server",
            claimedAt: publicConfig.claimedAt ?? item.updated_at,
          };
        }),
      );

      return { connections, pendingGrants };
    },

    async backfillConnection(userId: string, connectionId: string, windows = 3) {
      const count = Math.max(1, Math.min(3, Math.floor(windows)));
      const secret = await getConnectionSecret(userId, connectionId);
      const connection = await db.get<{ backfill_cursor: string | null }>(
        "SELECT backfill_cursor FROM provider_connections WHERE id = ? AND user_id = ? AND provider = 'simplefin'",
        connectionId,
        userId,
      );
      if (!connection) throw new Error("SimpleFIN connection not found.");

      const refs = await db.all<{ account_id: string; external_account_id: string }>(
        `SELECT account_id, external_account_id FROM account_provider_refs
          WHERE user_id = ? AND connection_id = ? AND provider = 'simplefin'`,
        userId, connectionId,
      );
      const rowByExternal = new Map(refs.map((r) => [r.external_account_id, r.account_id]));
      if (rowByExternal.size === 0) throw new Error("SimpleFIN connection has no linked accounts.");

      let endSeconds = connection.backfill_cursor?.startsWith(BACKFILL_PREFIX)
        ? Number.parseInt(connection.backfill_cursor.slice(BACKFILL_PREFIX.length), 10)
        : NaN;
      if (!Number.isFinite(endSeconds)) {
        const oldest = await db.get<{ oldest: string | null }>(
          `SELECT MIN(t.date) AS oldest
             FROM transactions t
             JOIN account_provider_refs r ON r.account_id = t.account_id
            WHERE r.connection_id = ? AND r.provider = 'simplefin' AND t.source = 'simplefin'`,
          connectionId,
        );
        const anchor = oldest?.oldest
          ? Math.floor(new Date(`${oldest.oldest}T00:00:00Z`).getTime() / 1000)
          : Math.floor(Date.now() / 1000);
        endSeconds = anchor + BACKFILL_OVERLAP_DAYS * DAY_SECONDS;
      }

      const categories = createCategoriesService(db);
      const ingest = createIngestService(db);
      await categories.ensureSystem(userId);
      let added = 0;
      let modified = 0;
      let oldestFetched = endSeconds;

      for (let i = 0; i < count; i++) {
        const startSeconds = Math.max(0, endSeconds - BACKFILL_WINDOW_DAYS * DAY_SECONDS);
        const res = await provider.syncTransactions?.(secret, { value: `${FORWARD_CURSOR_PREFIX}${startSeconds}` });
        if (!res) throw new Error("SimpleFIN transaction sync is unavailable.");

        const ingestRows = async (rows: typeof res.added) => {
          for (const txn of rows) {
            const accountId = rowByExternal.get(txn.accountExternalId);
            if (!accountId) continue;
            const existing = await db.get<{ transaction_id: string }>(
              "SELECT transaction_id FROM transaction_provider_refs WHERE provider = 'simplefin' AND external_transaction_id = ?",
              txn.externalId,
            );
            const category =
              (await categories.matchLearned(userId, txn.merchant ?? txn.name)) ??
              (await categories.match(userId, txn.categoryPath ?? txn.categoryHint ?? null, txn.personalFinanceCategory ?? null)) ??
              (await categories.matchMcc(userId, txn.merchantCategoryCode)) ??
              (await categories.matchByName(userId, txn.merchant ?? txn.name));
            await ingest.upsert(userId, {
              provider: "simplefin",
              connectionId,
              externalId: txn.externalId,
              accountRowId: accountId,
              amountCents: txn.amountMinor,
              date: txn.date,
              authorizedDate: txn.authorizedDate ?? null,
              name: txn.name,
              merchantName: txn.merchant ?? null,
              categoryPath: txn.categoryPath ?? txn.categoryHint ?? null,
              personalFinanceCategory: txn.personalFinanceCategory ?? null,
              merchantCategoryCode: txn.merchantCategoryCode ?? null,
              pending: txn.pending,
              isTransfer: txn.isTransfer === true,
            }, category?.id ?? null);
            if (existing) modified++; else added++;
          }
        };
        await ingestRows(res.added);
        await ingestRows(res.modified);

        oldestFetched = startSeconds;
        endSeconds = Math.max(0, startSeconds + BACKFILL_OVERLAP_DAYS * DAY_SECONDS);
        await db.run(
          "UPDATE provider_connections SET backfill_cursor = ?, updated_at = ? WHERE id = ? AND user_id = ?",
          `${BACKFILL_PREFIX}${endSeconds}`, now(), connectionId, userId,
        );
        if (startSeconds === 0) break;
      }

      await markLinkedTransfers(db, userId);
      return {
        added,
        modified,
        windows: count,
        oldestFetchedDate: new Date(oldestFetched * 1000).toISOString().slice(0, 10),
        nextBackfillBefore: new Date(endSeconds * 1000).toISOString().slice(0, 10),
      };
    },

    async syncAll(userId: string): Promise<ProviderSyncResult[]> {
      const rows = await db.all<{ id: string }>(
        "SELECT id FROM provider_connections WHERE user_id = ? AND provider = 'simplefin'",
        userId,
      );
      const results: ProviderSyncResult[] = [];
      for (const row of rows) {
        try {
          const secret = await getConnectionSecret(userId, row.id);
          results.push(
            await safeSyncProviderConnection(db, {
              userId,
              connectionId: row.id,
              provider,
              connectionSecret: secret,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Sync failed.";
          await db.run(
            "UPDATE provider_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            message,
            now(),
            row.id,
            userId,
          ).catch(() => undefined);
          results.push({
            connectionId: row.id,
            provider: "simplefin",
            institutionName: null,
            added: 0,
            modified: 0,
            removed: 0,
            ok: false,
            error: message,
          });
        }
      }
      return results;
    },

    async removeConnection(userId: string, connectionId: string): Promise<void> {
      await db.run(
        "DELETE FROM provider_connections WHERE id = ? AND user_id = ? AND provider = 'simplefin'",
        connectionId,
        userId,
      );
    },
  };
}
