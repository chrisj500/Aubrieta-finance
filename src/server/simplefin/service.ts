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

function now(): string {
  return new Date().toISOString();
}

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
      }>(
        `SELECT id, external_connection_id, institution_name, institution_external_id,
                environment, status, last_sync_at, last_error
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
        connections.push({ ...row, accounts });
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
