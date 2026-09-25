import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import type { Db } from "@/server/db/types";
import { createTellerProvider, inspectTellerEnrollment, type TellerConfig, type TellerConnectionSecret, type TellerEnvironment } from "@/server/providers/teller";
import { ensureAccountProviderRef, ensureProviderConnection } from "@/server/providers/connections";
import { safeSyncProviderConnection, type ProviderSyncResult } from "@/server/providers/sync";

function now(): string { return new Date().toISOString(); }
function aad(userId: string, id: string): string { return `${userId}:provider:${id}`; }

function parseSigningKey(raw: string) {
  const value = raw.trim();
  if (value.includes("BEGIN PUBLIC KEY")) return createPublicKey(value);
  const bytes = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length !== 32) throw new Error("Teller Token Signing Key must be PEM, base64, or 32-byte hex.");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, bytes]), format: "der", type: "spki" });
}

function signatureBytes(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-f]{128}$/i.test(value)) return Buffer.from(value, "hex");
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyEnrollmentSignature(input: {
  tokenSigningKey: string;
  nonce: string;
  accessToken: string;
  userId: string;
  enrollmentId: string;
  environment: TellerEnvironment;
  signatures: string[];
}): boolean {
  const key = parseSigningKey(input.tokenSigningKey);
  const message = [
    input.nonce,
    input.accessToken,
    input.userId,
    input.enrollmentId,
    input.environment,
  ].join(".");
  const digest = createHash("sha256").update(message, "utf8").digest();
  return input.signatures.some((sig) => {
    try { return verify(null, digest, key, signatureBytes(sig)); } catch { return false; }
  });
}

export function createTellerService(db: Db) {
  async function getConfig(userId: string, environment: TellerEnvironment): Promise<{ id: string; config: TellerConfig }> {
    const row = await db.get<{ id: string; config_enc: string }>(
      "SELECT id, config_enc FROM provider_credentials WHERE user_id = ? AND provider = 'teller' AND environment = ?",
      userId,
      environment,
    );
    if (!row) throw new Error("Teller credentials are not configured for this environment.");
    return { id: row.id, config: JSON.parse(decrypt(row.config_enc, aad(userId, row.id))) as TellerConfig };
  }

  async function getConnectionSecret(userId: string, connectionId: string): Promise<TellerConnectionSecret> {
    const connection = await db.get<{ environment: TellerEnvironment | null }>(
      "SELECT environment FROM provider_connections WHERE id = ? AND user_id = ? AND provider = 'teller'",
      connectionId, userId,
    );
    if (!connection?.environment) throw new Error("Teller connection environment is missing.");
    const { config } = await getConfig(userId, connection.environment);
    const row = await db.get<{ secret_enc: string }>(
      "SELECT secret_enc FROM provider_connection_secrets WHERE connection_id = ? AND user_id = ?",
      connectionId, userId,
    );
    if (!row) throw new Error("Teller connection secret is missing.");
    const secret = JSON.parse(decrypt(row.secret_enc, aad(userId, connectionId))) as { accessToken: string };
    return { config, accessToken: secret.accessToken };
  }

  return {
    async listCredentialStatus(userId: string) {
      return {
        environments: await db.all<{ environment: string; updated_at: string; public_config_json: string }>(
          "SELECT environment, updated_at, public_config_json FROM provider_credentials WHERE user_id = ? AND provider = 'teller' ORDER BY environment",
          userId,
        ).then((rows) => rows.map((r) => ({
          environment: r.environment,
          hasKeys: true,
          updatedAt: r.updated_at,
          publicConfig: JSON.parse(r.public_config_json),
        }))),
      };
    },

    async saveCredentials(userId: string, input: TellerConfig) {
      if (!input.applicationId.trim()) throw new Error("Teller Application ID is required.");
      if (!input.tokenSigningKey.trim()) throw new Error("Teller Token Signing Key is required.");
      parseSigningKey(input.tokenSigningKey);
      if (input.environment !== "sandbox" && (!input.certificatePem?.trim() || !input.privateKeyPem?.trim())) {
        throw new Error("Teller development/production requires the client certificate and private key.");
      }
      const existing = await db.get<{ id: string }>(
        "SELECT id FROM provider_credentials WHERE user_id = ? AND provider = 'teller' AND environment = ?",
        userId, input.environment,
      );
      const id = existing?.id ?? randomUUID();
      const ts = now();
      const normalized: TellerConfig = {
        environment: input.environment,
        applicationId: input.applicationId.trim(),
        certificatePem: input.certificatePem?.trim() || null,
        privateKeyPem: input.privateKeyPem?.trim() || null,
        tokenSigningKey: input.tokenSigningKey.trim(),
      };
      const encrypted = encrypt(JSON.stringify(normalized), aad(userId, id));
      const publicJson = JSON.stringify({ applicationId: normalized.applicationId });
      if (existing) {
        await db.run("UPDATE provider_credentials SET config_enc = ?, public_config_json = ?, updated_at = ? WHERE id = ?", encrypted, publicJson, ts, id);
      } else {
        await db.run(
          "INSERT INTO provider_credentials (id, user_id, provider, environment, config_enc, public_config_json, updated_at) VALUES (?, ?, 'teller', ?, ?, ?, ?)",
          id, userId, input.environment, encrypted, publicJson, ts,
        );
      }
      return { environment: input.environment, applicationId: normalized.applicationId, updatedAt: ts };
    },

    async createConnectConfig(userId: string, environment: TellerEnvironment, enrollmentId?: string) {
      const { config } = await getConfig(userId, environment);
      const id = randomUUID();
      const nonce = randomBytes(32).toString("base64url");
      const ts = now();
      const expires = new Date(Date.now() + 10 * 60_000).toISOString();
      await db.run(
        "INSERT INTO provider_connect_nonces (id, user_id, provider, environment, nonce, expires_at, created_at) VALUES (?, ?, 'teller', ?, ?, ?, ?)",
        id, userId, environment, nonce, expires, ts,
      );
      return {
        applicationId: config.applicationId,
        environment,
        nonce,
        products: ["balance", "transactions"],
        enrollmentId: enrollmentId ?? null,
      };
    },

    async acceptEnrollment(userId: string, input: {
      environment: TellerEnvironment;
      nonce: string;
      accessToken: string;
      tellerUserId: string;
      enrollmentId: string;
      institutionName: string | null;
      signatures: string[];
    }) {
      const nonceRow = await db.get<{ id: string; expires_at: string; used_at: string | null }>(
        "SELECT id, expires_at, used_at FROM provider_connect_nonces WHERE user_id = ? AND provider = 'teller' AND environment = ? AND nonce = ?",
        userId, input.environment, input.nonce,
      );
      if (!nonceRow || nonceRow.used_at || Date.parse(nonceRow.expires_at) < Date.now()) {
        throw new Error("Teller connection session expired. Start the connection again.");
      }
      const { config } = await getConfig(userId, input.environment);
      if (!verifyEnrollmentSignature({
        tokenSigningKey: config.tokenSigningKey,
        nonce: input.nonce,
        accessToken: input.accessToken,
        userId: input.tellerUserId,
        enrollmentId: input.enrollmentId,
        environment: input.environment,
        signatures: input.signatures,
      })) {
        throw new Error("Teller enrollment signature verification failed.");
      }

      const provider = createTellerProvider();
      const connectionId = await ensureProviderConnection(db, {
        userId,
        provider,
        externalConnectionId: input.enrollmentId,
        institutionExternalId: null,
        institutionName: input.institutionName,
        status: "active",
        environment: input.environment,
      });
      const secret: TellerConnectionSecret = { config, accessToken: input.accessToken };
      const inspected = await inspectTellerEnrollment(secret);
      const ts = now();
      await db.run(
        "UPDATE provider_connections SET institution_external_id = COALESCE(?, institution_external_id), institution_name = COALESCE(?, institution_name), updated_at = ? WHERE id = ?",
        inspected.institutionExternalId, inspected.institutionName, ts, connectionId,
      );
      await db.run(
        `INSERT INTO provider_connection_secrets (connection_id, user_id, secret_enc, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET secret_enc = excluded.secret_enc, updated_at = excluded.updated_at`,
        connectionId, userId, encrypt(JSON.stringify({ accessToken: input.accessToken }), aad(userId, connectionId)), ts,
      );
      for (const account of inspected.accounts) {
        // The shared sync engine creates the canonical account row; run it once
        // immediately so linking returns with populated accounts/transactions.
        void account;
      }
      await db.run("UPDATE provider_connect_nonces SET used_at = ? WHERE id = ?", ts, nonceRow.id);
      const sync = await safeSyncProviderConnection(db, { userId, connectionId, provider, connectionSecret: secret });
      return { connectionId, accountCount: inspected.accounts.length, synced: sync.added + sync.modified };
    },

    async listConnections(userId: string) {
      const rows = await db.all<{
        id: string; external_connection_id: string | null; institution_name: string | null;
        environment: string | null; status: string; last_sync_at: string | null; last_error: string | null;
      }>(
        "SELECT id, external_connection_id, institution_name, environment, status, last_sync_at, last_error FROM provider_connections WHERE user_id = ? AND provider = 'teller' ORDER BY created_at DESC",
        userId,
      );
      const out = [];
      for (const row of rows) {
        const accounts = await db.all<{ id: string; name: string }>(
          `SELECT a.id, a.name FROM accounts a
           JOIN account_provider_refs r ON r.account_id = a.id
           WHERE r.connection_id = ? AND r.provider = 'teller'
           ORDER BY a.name`,
          row.id,
        );
        out.push({ ...row, accounts });
      }
      return out;
    },

    async syncAll(userId: string): Promise<ProviderSyncResult[]> {
      const provider = createTellerProvider();
      const rows = await db.all<{ id: string }>(
        "SELECT id FROM provider_connections WHERE user_id = ? AND provider = 'teller'",
        userId,
      );
      const results: ProviderSyncResult[] = [];
      for (const row of rows) {
        try {
          const secret = await getConnectionSecret(userId, row.id);
          results.push(await safeSyncProviderConnection(db, { userId, connectionId: row.id, provider, connectionSecret: secret }));
        } catch (err) {
          results.push({ connectionId: row.id, provider: "teller", institutionName: null, added: 0, modified: 0, removed: 0, ok: false, error: err instanceof Error ? err.message : "Sync failed." });
        }
      }
      return results;
    },

    async removeConnection(userId: string, connectionId: string) {
      try {
        const secret = await getConnectionSecret(userId, connectionId);
        await createTellerProvider().revoke?.(secret);
      } catch {
        // Local removal must still work if Teller is temporarily unreachable.
      }
      await db.transaction(async () => {
        await db.run("DELETE FROM provider_connections WHERE id = ? AND user_id = ? AND provider = 'teller'", connectionId, userId);
      });
    },
  };
}
