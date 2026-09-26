import { randomUUID } from "node:crypto";
import type { Db } from "@/server/db/types";
import { createCategoriesService } from "@/server/domain/categories";
import { createIngestService } from "@/server/domain/ingest";
import { syncProviderLiabilities } from "@/server/domain/liabilities";
import { createBillIntelligenceService } from "@/server/domain/bill-intelligence";
import { markLinkedTransfers } from "@/server/domain/transfers";
import { getHouseholdContext } from "@/server/authz/household-access";
import { ensureAccountProviderRef } from "./connections";
import type {
  FinancialProvider,
  NormalizedAccountType,
  ProviderKind,
} from "./types";

function now(): string {
  return new Date().toISOString();
}

function today(): string {
  return now().slice(0, 10);
}

function legacyAccountType(type: NormalizedAccountType): string {
  switch (type) {
    case "checking":
    case "savings":
    case "cash":
      return "depository";
    case "credit_card":
      return "credit";
    case "mortgage":
    case "loan":
      return "loan";
    case "investment":
      return "investment";
    default:
      return "other";
  }
}

function balanceSign(type: NormalizedAccountType): 1 | -1 {
  return type === "credit_card" || type === "mortgage" || type === "loan" ? -1 : 1;
}

export interface ProviderSyncResult {
  connectionId: string;
  provider: ProviderKind;
  institutionName: string | null;
  added: number;
  modified: number;
  removed: number;
  ok: boolean;
  error?: string;
}

export async function syncProviderConnection(
  db: Db,
  input: {
    userId: string;
    connectionId: string;
    provider: FinancialProvider;
    connectionSecret: unknown;
  },
): Promise<ProviderSyncResult> {
  const household = await getHouseholdContext(db, input.userId);
  const connection = await db.get<{
    id: string;
    provider: ProviderKind;
    institution_name: string | null;
    sync_cursor: string | null;
    household_id: string | null;
  }>(
    `SELECT id, provider, institution_name, sync_cursor, household_id
       FROM provider_connections
      WHERE id = ? AND user_id = ?`,
    input.connectionId,
    input.userId,
  );
  if (!connection) throw new Error("Provider connection not found.");
  if (connection.provider !== input.provider.descriptor.kind) {
    throw new Error(`Provider mismatch for connection ${connection.id}.`);
  }
  if (connection.household_id && household && connection.household_id !== household.householdId) {
    throw new Error("Provider connection tenant mismatch.");
  }

  const providerKind = input.provider.descriptor.kind;
  const freshAccounts = await input.provider.listAccounts(input.connectionSecret);
  const refs = await db.all<{
    account_id: string;
    external_account_id: string;
  }>(
    `SELECT account_id, external_account_id
       FROM account_provider_refs
      WHERE user_id = ? AND connection_id = ? AND provider = ?`,
    input.userId,
    input.connectionId,
    providerKind,
  );
  const rowByExternal = new Map(refs.map((r) => [r.external_account_id, r.account_id]));

  for (const account of freshAccounts) {
    let accountId = rowByExternal.get(account.externalId);
    const type = legacyAccountType(account.type);
    const sign = balanceSign(account.type);

    if (!accountId) {
      accountId = randomUUID();
      await db.run(
        `INSERT INTO accounts (
           id, user_id, household_id, owner_user_id, visibility,
           item_id, plaid_account_id, name, official_name, type,
           subtype, mask, current_balance_cents, available_balance_cents,
           currency, created_at
         ) VALUES (?, ?, ?, ?, 'shared', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        accountId,
        input.userId,
        household?.householdId ?? null,
        input.userId,
        account.name,
        account.officialName ?? null,
        type,
        account.subtype ?? null,
        account.mask ?? null,
        account.currentBalanceMinor == null ? null : account.currentBalanceMinor * sign,
        account.availableBalanceMinor == null ? null : account.availableBalanceMinor * sign,
        account.currency,
        now(),
      );
      await ensureAccountProviderRef(db, {
        userId: input.userId,
        accountId,
        connectionId: input.connectionId,
        provider: providerKind,
        externalAccountId: account.externalId,
      });
      rowByExternal.set(account.externalId, accountId);
    } else {
      const row = await db.get<{
        name_override: string | null;
        type_override: number;
      }>(
        "SELECT name_override, type_override FROM accounts WHERE id = ? AND user_id = ?",
        accountId,
        input.userId,
      );
      await db.run(
        `UPDATE accounts SET
           name = CASE WHEN ? IS NULL THEN ? ELSE name END,
           official_name = ?,
           type = CASE WHEN ? = 0 THEN ? ELSE type END,
           subtype = ?,
           mask = ?,
           current_balance_cents = ?,
           available_balance_cents = ?,
           currency = ?,
           deleted_at = NULL
         WHERE id = ? AND user_id = ?`,
        row?.name_override ?? null,
        account.name,
        account.officialName ?? null,
        row?.type_override ?? 0,
        type,
        account.subtype ?? null,
        account.mask ?? null,
        account.currentBalanceMinor == null ? null : account.currentBalanceMinor * sign,
        account.availableBalanceMinor == null ? null : account.availableBalanceMinor * sign,
        account.currency,
        accountId,
        input.userId,
      );
    }

    const balance = account.currentBalanceMinor ?? account.availableBalanceMinor;
    if (balance != null) {
      await db.run(
        `INSERT INTO balance_history (id, account_id, date, balance_cents)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, date)
         DO UPDATE SET balance_cents = excluded.balance_cents`,
        randomUUID(),
        accountId,
        today(),
        balance * sign,
      );
    }
  }

  let added = 0;
  let modified = 0;
  let removed = 0;
  let nextCursor = connection.sync_cursor;

  if (input.provider.syncTransactions) {
    const categories = createCategoriesService(db);
    const ingest = createIngestService(db);
    await categories.ensureSystem(input.userId);

    const res = await input.provider.syncTransactions(
      input.connectionSecret,
      { value: connection.sync_cursor },
    );
    nextCursor = res.nextCursor.value;

    const ingestRows = async (rows: typeof res.added) => {
      for (const txn of rows) {
        const accountId = rowByExternal.get(txn.accountExternalId);
        if (!accountId) continue;
        const existingRef = await db.get<{ transaction_id: string }>(
          "SELECT transaction_id FROM transaction_provider_refs WHERE provider = ? AND external_transaction_id = ?",
          providerKind,
          txn.externalId,
        );
        const category =
          (await categories.match(
            input.userId,
            txn.categoryPath ?? txn.categoryHint ?? null,
            txn.personalFinanceCategory ?? null,
          )) ??
          (await categories.matchByName(input.userId, txn.merchant ?? txn.name));

        await ingest.upsert(
          input.userId,
          {
            provider: providerKind,
            connectionId: input.connectionId,
            externalId: txn.externalId,
            accountRowId: accountId,
            amountCents: txn.amountMinor,
            date: txn.date,
            authorizedDate: txn.authorizedDate ?? null,
            name: txn.name,
            merchantName: txn.merchant ?? null,
            categoryPath: txn.categoryPath ?? txn.categoryHint ?? null,
            personalFinanceCategory: txn.personalFinanceCategory ?? null,
            pending: txn.pending,
          },
          category?.id ?? null,
        );
        if (existingRef) modified++;
        else added++;
      }
    };

    await ingestRows(res.added);
    await ingestRows(res.modified);

    for (const externalId of res.removedExternalIds) {
      await ingest.remove(providerKind, externalId);
      removed++;
    }
  }

  if (input.provider.getLiabilities) {
    try {
      const liabilities = await input.provider.getLiabilities(input.connectionSecret);
      await syncProviderLiabilities(
        db,
        input.userId,
        input.connectionId,
        providerKind,
        liabilities,
      );
    } catch {
      // Keep last known liability snapshot if a provider temporarily cannot
      // refresh this optional capability.
    }
  }

  if (input.provider.getInvestments) {
    try {
      const investments = await input.provider.getInvestments(input.connectionSecret);
      const securityIdByExternal = new Map<string, string>();
      const syncedAt = now();

      for (const security of investments.securities) {
        const existing = await db.get<{ id: string }>(
          `SELECT id FROM investment_securities
            WHERE connection_id = ? AND provider = ? AND external_security_id = ?`,
          input.connectionId,
          providerKind,
          security.externalId,
        );
        const securityId = existing?.id ?? randomUUID();
        await db.run(
          `INSERT INTO investment_securities (
             id, user_id, connection_id, provider, external_security_id,
             name, ticker, isin, cusip, security_type, currency, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(connection_id, provider, external_security_id)
           DO UPDATE SET
             name = excluded.name,
             ticker = excluded.ticker,
             isin = excluded.isin,
             cusip = excluded.cusip,
             security_type = excluded.security_type,
             currency = excluded.currency,
             updated_at = excluded.updated_at`,
          securityId,
          input.userId,
          input.connectionId,
          providerKind,
          security.externalId,
          security.name,
          security.ticker ?? null,
          security.isin ?? null,
          security.cusip ?? null,
          security.type ?? null,
          security.currency,
          syncedAt,
        );
        securityIdByExternal.set(security.externalId, securityId);
      }

      await db.run(
        "DELETE FROM investment_holdings WHERE connection_id = ? AND user_id = ?",
        input.connectionId,
        input.userId,
      );

      for (const holding of investments.holdings) {
        const accountId = rowByExternal.get(holding.accountExternalId);
        const securityId = securityIdByExternal.get(holding.securityExternalId);
        if (!accountId || !securityId) continue;
        await db.run(
          `INSERT INTO investment_holdings (
             id, user_id, account_id, security_id, connection_id, provider,
             quantity, institution_price_cents, institution_value_cents,
             cost_basis_cents, currency, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, security_id)
           DO UPDATE SET
             quantity = excluded.quantity,
             institution_price_cents = excluded.institution_price_cents,
             institution_value_cents = excluded.institution_value_cents,
             cost_basis_cents = excluded.cost_basis_cents,
             currency = excluded.currency,
             updated_at = excluded.updated_at`,
          randomUUID(),
          input.userId,
          accountId,
          securityId,
          input.connectionId,
          providerKind,
          holding.quantity,
          holding.institutionPriceMinor ?? null,
          holding.institutionValueMinor ?? null,
          holding.costBasisMinor ?? null,
          holding.currency,
          syncedAt,
        );
      }
    } catch {
      // Holdings are additive; keep the last known snapshot if refresh fails.
    }
  }

  if (input.provider.getRecurringStreams) {
    try {
      const streams = await input.provider.getRecurringStreams(input.connectionSecret);
      await createBillIntelligenceService(db).syncProviderStreams(
        input.userId,
        input.connectionId,
        providerKind,
        streams,
      );
    } catch {
      // Provider recurring insights are additive. Local detection remains the
      // fallback when the add-on is unavailable or temporarily fails.
    }
  }

  await markLinkedTransfers(db, input.userId);

  const syncedAt = now();
  await db.run(
    `UPDATE provider_connections
        SET sync_cursor = ?, last_sync_at = ?, last_error = NULL,
            status = 'active', updated_at = ?
      WHERE id = ? AND user_id = ?`,
    nextCursor,
    syncedAt,
    syncedAt,
    input.connectionId,
    input.userId,
  );

  return {
    connectionId: input.connectionId,
    provider: providerKind,
    institutionName: connection.institution_name,
    added,
    modified,
    removed,
    ok: true,
  };
}

export async function safeSyncProviderConnection(
  db: Db,
  input: Parameters<typeof syncProviderConnection>[1],
): Promise<ProviderSyncResult> {
  try {
    return await syncProviderConnection(db, input);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed.";
    await db.run(
      `UPDATE provider_connections
          SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
      message,
      now(),
      input.connectionId,
      input.userId,
    ).catch(() => undefined);
    return {
      connectionId: input.connectionId,
      provider: input.provider.descriptor.kind,
      institutionName: null,
      added: 0,
      modified: 0,
      removed: 0,
      ok: false,
      error: message,
    };
  }
}