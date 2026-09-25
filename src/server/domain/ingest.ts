import { randomUUID } from "node:crypto";
import { getDb, type Db } from "@/server/db/adapter";
import { findImportedDuplicate } from "@/server/domain/txn-dedupe";
import type { ProviderKind } from "@/server/providers/types";

/**
 * Provider-neutral transaction ingest.
 *
 * Canonical amount sign used by Aubrieta:
 *   positive = money in
 *   negative = money out
 *
 * plaid_transaction_id remains populated for Plaid rows during the migration
 * period because older APIs, exports, and phone sync still use it. New code
 * identifies provider transactions through transaction_provider_refs.
 */
export interface IngestTxn {
  provider?: ProviderKind;
  connectionId?: string;
  externalId?: string;
  /** Legacy Plaid alias retained for direct ingest callers during M1 migration. */
  plaidId?: string;
  accountRowId: string;
  amountCents: number;
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  categoryPath: string | null;
  personalFinanceCategory: string | null;
  pending: boolean;
  isTransfer?: boolean;
}

export function createIngestService(db: Db = getDb()) {
  function now(): string {
    return new Date().toISOString();
  }

  async function ensureProviderRef(
    userId: string,
    txnId: string,
    txn: IngestTxn & { provider: ProviderKind; externalId: string; connectionId: string },
  ): Promise<void> {
    const ts = now();
    const existing = await db.get<{ id: string }>(
      "SELECT id FROM transaction_provider_refs WHERE provider = ? AND external_transaction_id = ?",
      txn.provider,
      txn.externalId,
    );
    if (existing) {
      await db.run(
        `UPDATE transaction_provider_refs
            SET user_id = ?, transaction_id = ?, account_id = ?, connection_id = ?, updated_at = ?
          WHERE id = ?`,
        userId,
        txnId,
        txn.accountRowId,
        txn.connectionId,
        ts,
        existing.id,
      );
      return;
    }
    await db.run(
      `INSERT INTO transaction_provider_refs (
         id, user_id, transaction_id, account_id, connection_id, provider,
         external_transaction_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      userId,
      txnId,
      txn.accountRowId,
      txn.connectionId,
      txn.provider,
      txn.externalId,
      ts,
      ts,
    );
  }

  return {
    /**
     * Upsert a normalized provider transaction. Pending -> posted updates the
     * same canonical row. CSV/phone-import duplicates are adopted instead of
     * duplicated, preserving user categories and notes.
     */
    async upsert(
      userIdOrTxn: string | IngestTxn,
      txnOrCategory: IngestTxn | string | null,
      maybeCategoryId?: string | null,
    ): Promise<void> {
      const legacyCall = typeof userIdOrTxn !== "string";
      const rawTxn = (legacyCall ? userIdOrTxn : txnOrCategory) as IngestTxn;
      const categoryId = legacyCall
        ? (txnOrCategory as string | null)
        : (maybeCategoryId ?? null);
      const accountOwner = legacyCall
        ? await db.get<{ user_id: string }>("SELECT user_id FROM accounts WHERE id = ?", rawTxn.accountRowId)
        : undefined;
      const userId = legacyCall ? accountOwner?.user_id : userIdOrTxn;
      if (!userId) throw new Error("Transaction account owner not found.");

      const provider = rawTxn.provider ?? "plaid";
      const externalId = rawTxn.externalId ?? rawTxn.plaidId;
      if (!externalId) throw new Error("Provider transaction id is required.");
      let connectionId = rawTxn.connectionId;
      if (!connectionId) {
        const ref = await db.get<{ connection_id: string }>(
          "SELECT connection_id FROM account_provider_refs WHERE account_id = ? AND provider = ? LIMIT 1",
          rawTxn.accountRowId,
          provider,
        );
        connectionId = ref?.connection_id;
      }
      const txn = { ...rawTxn, provider, externalId, connectionId };

      const providerRef = await db.get<{ transaction_id: string }>(
        "SELECT transaction_id FROM transaction_provider_refs WHERE provider = ? AND external_transaction_id = ?",
        provider,
        externalId,
      );

      // Compatibility fallback for pre-024 Plaid rows if a database is caught
      // between schema migration and reference backfill.
      const legacyPlaid = !providerRef && provider === "plaid"
        ? await db.get<{ id: string }>(
            "SELECT id FROM transactions WHERE plaid_transaction_id = ?",
            externalId,
          )
        : undefined;

      const existingId = providerRef?.transaction_id ?? legacyPlaid?.id;
      if (existingId) {
        await db.run(
          `UPDATE transactions
              SET account_id = ?, amount_cents = ?, date = ?, authorized_date = ?, name = ?,
                  merchant_name = ?, category_path = ?, personal_finance_category = ?, pending = ?,
                  user_category_id = COALESCE(user_category_id, ?), is_transfer = ?, source = ?,
                  plaid_transaction_id = CASE WHEN ? = 'plaid' THEN ? ELSE plaid_transaction_id END
            WHERE id = ?`,
          txn.accountRowId,
          txn.amountCents,
          txn.date,
          txn.authorizedDate,
          txn.name,
          txn.merchantName,
          txn.categoryPath,
          txn.personalFinanceCategory,
          txn.pending ? 1 : 0,
          categoryId,
          txn.isTransfer ? 1 : 0,
          txn.provider,
          txn.provider,
          txn.externalId,
          existingId,
        );
        if (txn.connectionId) {
          await ensureProviderRef(userId, existingId, txn as IngestTxn & { provider: ProviderKind; externalId: string; connectionId: string });
        }
        return;
      }

      const imported = await findImportedDuplicate(db, txn.accountRowId, txn);
      if (imported) {
        await db.run(
          `UPDATE transactions
              SET plaid_transaction_id = CASE WHEN ? = 'plaid' THEN ? ELSE plaid_transaction_id END,
                  amount_cents = ?, date = ?, authorized_date = ?, name = ?,
                  merchant_name = ?, category_path = ?, personal_finance_category = ?, pending = ?,
                  user_category_id = COALESCE(user_category_id, ?), is_transfer = ?, source = ?
            WHERE id = ?`,
          txn.provider,
          txn.externalId,
          txn.amountCents,
          txn.date,
          txn.authorizedDate,
          txn.name,
          txn.merchantName,
          txn.categoryPath,
          txn.personalFinanceCategory,
          txn.pending ? 1 : 0,
          categoryId,
          txn.isTransfer ? 1 : 0,
          txn.provider,
          imported.id,
        );
        if (txn.connectionId) {
          await ensureProviderRef(userId, imported.id, txn as IngestTxn & { provider: ProviderKind; externalId: string; connectionId: string });
        }
        return;
      }

      const id = randomUUID();
      await db.run(
        `INSERT INTO transactions
           (id, account_id, plaid_transaction_id, amount_cents, date, authorized_date, name,
            merchant_name, category_path, personal_finance_category, pending, user_category_id,
            is_transfer, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        txn.accountRowId,
        txn.provider === "plaid" ? txn.externalId : null,
        txn.amountCents,
        txn.date,
        txn.authorizedDate,
        txn.name,
        txn.merchantName,
        txn.categoryPath,
        txn.personalFinanceCategory,
        txn.pending ? 1 : 0,
        categoryId,
        txn.isTransfer ? 1 : 0,
        txn.provider,
        now(),
      );
      if (txn.connectionId) {
        await ensureProviderRef(userId, id, txn as IngestTxn & { provider: ProviderKind; externalId: string; connectionId: string });
      }
    },

    /**
     * Remove a provider's reference to a transaction. Delete the canonical row
     * only when no other aggregation provider references it; this is what lets
     * history survive provider changes.
     */
    async remove(providerOrExternalId: ProviderKind | string, maybeExternalId?: string): Promise<void> {
      const provider: ProviderKind = maybeExternalId ? providerOrExternalId as ProviderKind : "plaid";
      const externalId = maybeExternalId ?? providerOrExternalId;
      const ref = await db.get<{ id: string; transaction_id: string }>(
        "SELECT id, transaction_id FROM transaction_provider_refs WHERE provider = ? AND external_transaction_id = ?",
        provider,
        externalId,
      );
      if (!ref) {
        if (provider === "plaid") {
          await db.run("DELETE FROM transactions WHERE plaid_transaction_id = ?", externalId);
        }
        return;
      }
      await db.run("DELETE FROM transaction_provider_refs WHERE id = ?", ref.id);
      const remaining = await db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM transaction_provider_refs WHERE transaction_id = ?",
        ref.transaction_id,
      );
      if ((remaining?.n ?? 0) === 0) {
        await db.run("DELETE FROM transactions WHERE id = ?", ref.transaction_id);
      }
    },
  };
}

export type IngestService = ReturnType<typeof createIngestService>;
