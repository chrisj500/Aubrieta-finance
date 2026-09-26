import { randomUUID } from "@/lib/uuid";
import type { Db } from "@/server/db/types";
import type { ProviderKind, ProviderLiability } from "@/server/providers/types";

function now(): string {
  return new Date().toISOString();
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isInteger(value) && value > 0 ? value : null;
}

function billAmount(liability: ProviderLiability): number | null {
  switch (liability.kind) {
    case "credit_card":
      return positive(liability.minimumPaymentMinor) ?? positive(liability.statementBalanceMinor);
    case "mortgage":
      return positive(liability.nextMonthlyPaymentMinor);
    case "student_loan":
    case "loan":
      return positive(liability.minimumPaymentMinor) ?? positive(liability.nextMonthlyPaymentMinor);
    default:
      return positive(liability.minimumPaymentMinor) ?? positive(liability.nextMonthlyPaymentMinor);
  }
}

function billNotes(liability: ProviderLiability): string {
  if (liability.kind === "credit_card" && positive(liability.minimumPaymentMinor) != null) {
    return "Provider-confirmed minimum payment. Statement balance is retained separately.";
  }
  if (liability.kind === "mortgage") {
    return "Provider-confirmed next mortgage payment.";
  }
  return "Provider-confirmed liability payment.";
}

export interface LiabilitySyncResult {
  synced: number;
  billsUpserted: number;
  skippedWithoutAccount: number;
}

/**
 * Persist normalized provider liabilities and project actionable obligations
 * into the existing Bills model. Provider-backed bills remain derived records:
 * the liability table is authoritative and subsequent syncs update the bill.
 */
export async function syncProviderLiabilities(
  db: Db,
  userId: string,
  connectionId: string,
  provider: ProviderKind,
  liabilities: ProviderLiability[],
): Promise<LiabilitySyncResult> {
  const ts = now();
  const refs = await db.all<{
    account_id: string;
    external_account_id: string;
    name: string;
    household_id: string | null;
    owner_user_id: string | null;
    account_user_id: string;
    visibility: "shared" | "private";
  }>(
    `SELECT r.account_id, r.external_account_id, a.name, a.household_id,
            a.owner_user_id, a.user_id AS account_user_id, a.visibility
       FROM account_provider_refs r
       JOIN accounts a ON a.id = r.account_id
      WHERE r.user_id = ? AND r.connection_id = ? AND r.provider = ?`,
    userId,
    connectionId,
    provider,
  );
  const byExternal = new Map(refs.map((r) => [r.external_account_id, r]));

  let synced = 0;
  let billsUpserted = 0;
  let skippedWithoutAccount = 0;
  const seen: string[] = [];

  await db.transaction(async () => {
    for (const liability of liabilities) {
      const account = byExternal.get(liability.accountExternalId);
      if (!account) {
        skippedWithoutAccount++;
        continue;
      }
      seen.push(liability.accountExternalId);

      const existing = await db.get<{ id: string }>(
        "SELECT id FROM liabilities WHERE provider = ? AND provider_external_account_id = ?",
        provider,
        liability.accountExternalId,
      );
      const id = existing?.id ?? randomUUID();

      if (existing) {
        await db.run(
          `UPDATE liabilities SET
             user_id = ?, account_id = ?, connection_id = ?, kind = ?,
             next_payment_due_date = ?, minimum_payment_cents = ?,
             statement_balance_cents = ?, statement_date = ?,
             next_monthly_payment_cents = ?, apr_bps = ?,
             last_payment_amount_cents = ?, last_payment_date = ?,
             raw_status = ?, active = 1, synced_at = ?, updated_at = ?
           WHERE id = ?`,
          userId,
          account.account_id,
          connectionId,
          liability.kind,
          liability.nextPaymentDueDate ?? null,
          liability.minimumPaymentMinor ?? null,
          liability.statementBalanceMinor ?? null,
          liability.statementDate ?? null,
          liability.nextMonthlyPaymentMinor ?? null,
          liability.aprBps ?? null,
          liability.lastPaymentAmountMinor ?? null,
          liability.lastPaymentDate ?? null,
          liability.rawStatus ?? null,
          ts,
          ts,
          id,
        );
      } else {
        await db.run(
          `INSERT INTO liabilities (
             id, user_id, account_id, connection_id, provider, provider_external_account_id,
             kind, next_payment_due_date, minimum_payment_cents, statement_balance_cents,
             statement_date, next_monthly_payment_cents, apr_bps,
             last_payment_amount_cents, last_payment_date, raw_status,
             active, synced_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          id,
          userId,
          account.account_id,
          connectionId,
          provider,
          liability.accountExternalId,
          liability.kind,
          liability.nextPaymentDueDate ?? null,
          liability.minimumPaymentMinor ?? null,
          liability.statementBalanceMinor ?? null,
          liability.statementDate ?? null,
          liability.nextMonthlyPaymentMinor ?? null,
          liability.aprBps ?? null,
          liability.lastPaymentAmountMinor ?? null,
          liability.lastPaymentDate ?? null,
          liability.rawStatus ?? null,
          ts,
          ts,
          ts,
        );
      }
      synced++;

      const amount = billAmount(liability);
      const dueDate = liability.nextPaymentDueDate ?? null;
      const dueDay = dueDate ? Number(dueDate.slice(8, 10)) : null;
      const existingBill = await db.get<{ id: string; user_overridden: number }>(
        "SELECT id, user_overridden FROM bills WHERE provider_liability_id = ?",
        id,
      );

      if (!amount || !dueDate) {
        if (existingBill && !existingBill.user_overridden) {
          await db.run("UPDATE bills SET active = 0, updated_at = ? WHERE id = ?", ts, existingBill.id);
        }
        continue;
      }

      const name =
        liability.kind === "mortgage"
          ? `${account.name} mortgage`
          : liability.kind === "credit_card"
            ? `${account.name} payment`
            : `${account.name} loan payment`;

      if (existingBill) {
        if (!existingBill.user_overridden) {
          await db.run(
            `UPDATE bills SET
               name = ?, amount_cents = ?, frequency = 'monthly',
               due_day = ?, next_due_date = ?, account_id = ?,
               household_id = ?, owner_user_id = ?, visibility = ?, active = 1,
               notes = ?, source = 'provider', source_confidence = 'confirmed',
               updated_at = ?
             WHERE id = ?`,
            name,
            amount,
            dueDay,
            dueDate,
            account.account_id,
            account.household_id,
            account.owner_user_id ?? account.account_user_id,
            account.visibility,
            billNotes(liability),
            ts,
            existingBill.id,
          );
        } else {
          // A user override outranks provider projection, but the liability
          // record itself still refreshes so statement/minimum metadata remains
          // visible beside the overridden schedule.
          await db.run(
            "UPDATE bills SET active = 1, updated_at = ? WHERE id = ?",
            ts,
            existingBill.id,
          );
        }
      } else {
        await db.run(
          `INSERT INTO bills (
             id, user_id, household_id, owner_user_id, visibility,
             name, amount_cents, frequency, due_day, next_due_date,
             last_paid_amount_cents, category_id, account_id, active, notes,
             created_at, updated_at, provider_liability_id, source, source_confidence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'monthly', ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, 'provider', 'confirmed')`,
          randomUUID(),
          userId,
          account.household_id,
          account.owner_user_id ?? account.account_user_id,
          account.visibility,
          name,
          amount,
          dueDay,
          dueDate,
          liability.lastPaymentAmountMinor ?? null,
          account.account_id,
          billNotes(liability),
          ts,
          ts,
          id,
        );
      }
      billsUpserted++;
    }

    const activeRows = await db.all<{ id: string; provider_external_account_id: string }>(
      "SELECT id, provider_external_account_id FROM liabilities WHERE connection_id = ? AND provider = ? AND active = 1",
      connectionId,
      provider,
    );
    for (const row of activeRows) {
      if (!seen.includes(row.provider_external_account_id)) {
        await db.run("UPDATE liabilities SET active = 0, updated_at = ? WHERE id = ?", ts, row.id);
        await db.run(
          "UPDATE bills SET active = CASE WHEN user_overridden = 1 THEN active ELSE 0 END, updated_at = ? WHERE provider_liability_id = ?",
          ts,
          row.id,
        );
      }
    }
  });

  return { synced, billsUpserted, skippedWithoutAccount };
}