import { randomBytes, randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import type { Db } from "@/server/db/types";
import {
  akoyaAuthorizationUrl,
  createAkoyaProvider,
  exchangeAkoyaCode,
  refreshAkoyaTokens,
  revokeAkoyaRefreshToken,
  type AkoyaConfig,
  type AkoyaConnectionSecret,
  type AkoyaEnvironment,
  type AkoyaInteractionType,
  type AkoyaTokens,
} from "@/server/providers/akoya";
import { ensureProviderConnection } from "@/server/providers/connections";
import { safeSyncProviderConnection, type ProviderSyncResult } from "@/server/providers/sync";

function now(): string {
  return new Date().toISOString();
}

function aad(userId: string, id: string): string {
  return `${userId}:provider:${id}`;
}

function encodeState(providerId: string): string {
  return `${Buffer.from(providerId, "utf8").toString("base64url")}.${randomBytes(32).toString("base64url")}`;
}

function providerIdFromState(state: string): string {
  const encoded = state.split(".")[0];
  if (!encoded) throw new Error("Akoya authorization state is invalid.");
  const providerId = Buffer.from(encoded, "base64url").toString("utf8").trim();
  if (!providerId || providerId.length > 120 || !/^[A-Za-z0-9._-]+$/.test(providerId)) {
    throw new Error("Akoya provider identifier is invalid.");
  }
  return providerId;
}

export function createAkoyaService(db: Db) {
  async function getConfig(
    userId: string,
    environment: AkoyaEnvironment,
  ): Promise<{ id: string; config: AkoyaConfig }> {
    const row = await db.get<{ id: string; config_enc: string }>(
      `SELECT id, config_enc FROM provider_credentials
        WHERE user_id = ? AND provider = 'akoya' AND environment = ?`,
      userId,
      environment,
    );
    if (!row) throw new Error("Akoya credentials are not configured for this environment.");
    return {
      id: row.id,
      config: JSON.parse(decrypt(row.config_enc, aad(userId, row.id))) as AkoyaConfig,
    };
  }

  async function storeConnectionSecret(
    userId: string,
    connectionId: string,
    secret: AkoyaConnectionSecret,
  ): Promise<void> {
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
  }

  async function loadStoredSecret(
    userId: string,
    connectionId: string,
  ): Promise<AkoyaConnectionSecret> {
    const row = await db.get<{ secret_enc: string }>(
      `SELECT pcs.secret_enc
         FROM provider_connection_secrets pcs
         JOIN provider_connections pc ON pc.id = pcs.connection_id
        WHERE pcs.connection_id = ? AND pcs.user_id = ?
          AND pc.user_id = ? AND pc.provider = 'akoya'`,
      connectionId,
      userId,
      userId,
    );
    if (!row) throw new Error("Akoya connection secret is missing.");
    const secret = JSON.parse(
      decrypt(row.secret_enc, aad(userId, connectionId)),
    ) as AkoyaConnectionSecret;
    if (!secret.config || !secret.providerId || !secret.tokens?.refreshToken) {
      throw new Error("Akoya connection secret is invalid.");
    }
    return secret;
  }

  async function readySecret(
    userId: string,
    connectionId: string,
    interactionType: AkoyaInteractionType,
  ): Promise<AkoyaConnectionSecret> {
    let secret = await loadStoredSecret(userId, connectionId);
    const lastAccessAt =
      interactionType === "USER"
        ? now()
        : secret.lastAccessAt ?? now();

    if (Date.parse(secret.tokens.expiresAt) <= Date.now() + 120_000) {
      const tokens = await refreshAkoyaTokens({
        config: secret.config,
        refreshToken: secret.tokens.refreshToken,
        previousGrantId: secret.tokens.grantId,
      });
      secret = { ...secret, tokens };
    }
    secret = { ...secret, interactionType, lastAccessAt };
    // Persist rotating refresh tokens. For BATCH access, lastAccessAt remains
    // the timestamp of the most recent real end-user access.
    await storeConnectionSecret(userId, connectionId, secret);
    return secret;
  }

  return {
    async listCredentialStatus(userId: string) {
      const rows = await db.all<{
        environment: string;
        public_config_json: string;
        updated_at: string;
      }>(
        `SELECT environment, public_config_json, updated_at
           FROM provider_credentials
          WHERE user_id = ? AND provider = 'akoya'
          ORDER BY environment`,
        userId,
      );
      return {
        environments: rows.map((row) => ({
          environment: row.environment,
          publicConfig: JSON.parse(row.public_config_json) as {
            clientId?: string;
            redirectUri?: string;
          },
          updatedAt: row.updated_at,
        })),
      };
    },

    async saveCredentials(userId: string, input: AkoyaConfig) {
      const clientId = input.clientId.trim();
      const clientSecret = input.clientSecret.trim();
      const redirectUri = input.redirectUri.trim();
      if (!clientId || !clientSecret) throw new Error("Akoya client ID and secret are required.");
      const parsed = new URL(redirectUri);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
        throw new Error("Akoya redirect URI must use HTTPS (localhost is allowed for development).");
      }

      const existing = await db.get<{ id: string }>(
        `SELECT id FROM provider_credentials
          WHERE user_id = ? AND provider = 'akoya' AND environment = ?`,
        userId,
        input.environment,
      );
      const id = existing?.id ?? randomUUID();
      const config: AkoyaConfig = {
        environment: input.environment,
        clientId,
        clientSecret,
        redirectUri: parsed.toString(),
      };
      const ts = now();
      const configEnc = encrypt(JSON.stringify(config), aad(userId, id));
      const publicJson = JSON.stringify({ clientId, redirectUri: config.redirectUri });
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
           VALUES (?, ?, 'akoya', ?, ?, ?, ?)`,
          id,
          userId,
          input.environment,
          configEnc,
          publicJson,
          ts,
        );
      }
      return { environment: input.environment, clientId, redirectUri: config.redirectUri, updatedAt: ts };
    },

    async startAuthorization(
      userId: string,
      environment: AkoyaEnvironment,
      providerId: string,
    ) {
      const normalizedProviderId = providerId.trim();
      if (!normalizedProviderId || !/^[A-Za-z0-9._-]+$/.test(normalizedProviderId)) {
        throw new Error("Enter a valid Akoya provider/connector ID.");
      }
      const { config } = await getConfig(userId, environment);
      const state = encodeState(normalizedProviderId);
      const ts = now();
      await db.run(
        `INSERT INTO provider_connect_nonces
           (id, user_id, provider, environment, nonce, expires_at, created_at)
         VALUES (?, ?, 'akoya', ?, ?, ?, ?)`,
        randomUUID(),
        userId,
        environment,
        state,
        new Date(Date.now() + 10 * 60_000).toISOString(),
        ts,
      );
      return {
        authorizationUrl: akoyaAuthorizationUrl({
          config,
          providerId: normalizedProviderId,
          state,
        }),
      };
    },

    async completeAuthorization(
      userId: string,
      state: string,
      code: string,
    ) {
      const nonce = await db.get<{
        id: string;
        environment: AkoyaEnvironment;
        expires_at: string;
        used_at: string | null;
      }>(
        `SELECT id, environment, expires_at, used_at
           FROM provider_connect_nonces
          WHERE user_id = ? AND provider = 'akoya' AND nonce = ?`,
        userId,
        state,
      );
      if (!nonce || nonce.used_at || Date.parse(nonce.expires_at) < Date.now()) {
        throw new Error("Akoya authorization session expired. Start the connection again.");
      }
      const providerId = providerIdFromState(state);
      const { config } = await getConfig(userId, nonce.environment);
      const tokens = await exchangeAkoyaCode({ config, code });
      const provider = createAkoyaProvider();
      const connectionId = await ensureProviderConnection(db, {
        userId,
        provider,
        externalConnectionId: tokens.grantId,
        institutionExternalId: providerId,
        institutionName: providerId,
        status: "active",
        environment: nonce.environment,
      });
      const secret: AkoyaConnectionSecret = {
        config,
        providerId,
        tokens,
        interactionType: "USER",
        lastAccessAt: now(),
      };
      await storeConnectionSecret(userId, connectionId, secret);
      await db.run(
        "UPDATE provider_connect_nonces SET used_at = ? WHERE id = ?",
        now(),
        nonce.id,
      );
      const sync = await safeSyncProviderConnection(db, {
        userId,
        connectionId,
        provider,
        connectionSecret: secret,
      });
      return { connectionId, sync };
    },

    async listConnections(userId: string) {
      const rows = await db.all<{
        id: string;
        external_connection_id: string | null;
        institution_external_id: string | null;
        institution_name: string | null;
        environment: string | null;
        status: string;
        last_sync_at: string | null;
        last_error: string | null;
      }>(
        `SELECT id, external_connection_id, institution_external_id, institution_name,
                environment, status, last_sync_at, last_error
           FROM provider_connections
          WHERE user_id = ? AND provider = 'akoya'
          ORDER BY created_at DESC`,
        userId,
      );
      const connections = [];
      for (const row of rows) {
        const accounts = await db.all<{ id: string; name: string }>(
          `SELECT a.id, a.name
             FROM accounts a
             JOIN account_provider_refs r ON r.account_id = a.id
            WHERE r.connection_id = ? AND r.provider = 'akoya'
            ORDER BY a.name COLLATE NOCASE`,
          row.id,
        );
        connections.push({ ...row, accounts });
      }
      return { connections };
    },

    async syncAll(
      userId: string,
      interactionType: AkoyaInteractionType = "BATCH",
    ): Promise<ProviderSyncResult[]> {
      const provider = createAkoyaProvider();
      const rows = await db.all<{ id: string }>(
        "SELECT id FROM provider_connections WHERE user_id = ? AND provider = 'akoya'",
        userId,
      );
      const results: ProviderSyncResult[] = [];
      for (const row of rows) {
        try {
          const secret = await readySecret(userId, row.id, interactionType);
          results.push(
            await safeSyncProviderConnection(db, {
              userId,
              connectionId: row.id,
              provider,
              connectionSecret: secret,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Akoya sync failed.";
          await db.run(
            "UPDATE provider_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            message,
            now(),
            row.id,
            userId,
          ).catch(() => undefined);
          results.push({
            connectionId: row.id,
            provider: "akoya",
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

    async removeConnection(userId: string, connectionId: string) {
      try {
        const secret = await loadStoredSecret(userId, connectionId);
        await revokeAkoyaRefreshToken({
          config: secret.config,
          refreshToken: secret.tokens.refreshToken,
        });
      } catch {
        // Local removal still succeeds if the remote grant is already gone.
      }
      await db.run(
        "DELETE FROM provider_connections WHERE id = ? AND user_id = ? AND provider = 'akoya'",
        connectionId,
        userId,
      );
    },
  };
}
