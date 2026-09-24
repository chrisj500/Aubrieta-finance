import { randomUUID } from "@/lib/uuid";
import type { Db } from "@/server/db/types";
import type { FinancialProvider, ProviderKind } from "./types";

function now(): string {
  return new Date().toISOString();
}

export async function ensureProviderConnection(
  db: Db,
  input: {
    userId: string;
    provider: FinancialProvider;
    externalConnectionId: string | null;
    institutionExternalId: string | null;
    institutionName: string | null;
    status?: string;
    legacyPlaidItemId?: string | null;
  },
): Promise<string> {
  const existing = input.legacyPlaidItemId
    ? await db.get<{ id: string }>(
        "SELECT id FROM provider_connections WHERE legacy_plaid_item_id = ? AND user_id = ?",
        input.legacyPlaidItemId,
        input.userId,
      )
    : input.externalConnectionId
      ? await db.get<{ id: string }>(
          "SELECT id FROM provider_connections WHERE user_id = ? AND provider = ? AND external_connection_id = ?",
          input.userId,
          input.provider.descriptor.kind,
          input.externalConnectionId,
        )
      : undefined;
  const id = existing?.id ?? randomUUID();
  const ts = now();
  const capabilities = JSON.stringify([...input.provider.descriptor.capabilities].sort());

  if (existing) {
    await db.run(
      `UPDATE provider_connections SET
         external_connection_id = ?, institution_external_id = ?, institution_name = ?,
         status = ?, capabilities_json = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      input.externalConnectionId,
      input.institutionExternalId,
      input.institutionName,
      input.status ?? "active",
      capabilities,
      ts,
      id,
      input.userId,
    );
  } else {
    await db.run(
      `INSERT INTO provider_connections (
         id, user_id, provider, external_connection_id, institution_external_id,
         institution_name, status, capabilities_json, legacy_plaid_item_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.provider.descriptor.kind,
      input.externalConnectionId,
      input.institutionExternalId,
      input.institutionName,
      input.status ?? "active",
      capabilities,
      input.legacyPlaidItemId ?? null,
      ts,
      ts,
    );
  }
  return id;
}

export async function ensureAccountProviderRef(
  db: Db,
  input: {
    userId: string;
    accountId: string;
    connectionId: string;
    provider: ProviderKind;
    externalAccountId: string;
  },
): Promise<void> {
  const ts = now();
  const existing = await db.get<{ id: string }>(
    "SELECT id FROM account_provider_refs WHERE provider = ? AND external_account_id = ?",
    input.provider,
    input.externalAccountId,
  );
  if (existing) {
    await db.run(
      `UPDATE account_provider_refs SET
         user_id = ?, account_id = ?, connection_id = ?, updated_at = ?
       WHERE id = ?`,
      input.userId,
      input.accountId,
      input.connectionId,
      ts,
      existing.id,
    );
  } else {
    await db.run(
      `INSERT INTO account_provider_refs (
         id, user_id, account_id, connection_id, provider, external_account_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      input.userId,
      input.accountId,
      input.connectionId,
      input.provider,
      input.externalAccountId,
      ts,
      ts,
    );
  }
}
