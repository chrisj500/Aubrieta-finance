import { createAccountsService, type AccountRow } from "@/server/domain/accounts";
import { createTransactionsService, type TransactionRow } from "@/server/domain/transactions";
import { assertAccountReadable } from "@/server/authz/household-access";
import { getDb, type Db } from "@/server/db/registry";

export interface AccountBalancePoint {
  date: string;
  balanceCents: number;
}

export interface AccountLiabilityDetail {
  kind: string;
  nextPaymentDueDate: string | null;
  minimumPaymentCents: number | null;
  statementBalanceCents: number | null;
  statementDate: string | null;
  nextMonthlyPaymentCents: number | null;
  aprBps: number | null;
  lastPaymentAmountCents: number | null;
  lastPaymentDate: string | null;
  rawStatus: string | null;
  syncedAt: string;
}

export interface AccountHoldingDetail {
  id: string;
  securityName: string;
  ticker: string | null;
  securityType: string | null;
  quantity: number;
  priceCents: number | null;
  valueCents: number;
  costBasisCents: number | null;
  gainCents: number | null;
  gainPct: number | null;
  currency: string;
}

function monthStartIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export function createAccountDetailService(db: Db = getDb()) {
  return {
    async get(userId: string, accountId: string): Promise<{
      account: AccountRow;
      history: AccountBalancePoint[];
      recentActivity: TransactionRow[];
      activityTotal: number;
      monthIncomeCents: number;
      monthExpenseCents: number;
      monthNetCents: number;
      liability: AccountLiabilityDetail | null;
      holdings: AccountHoldingDetail[];
    }> {
      await assertAccountReadable(db, userId, accountId);
      const base = await createAccountsService(db).get(userId, accountId);
      const pending = await db.get<{ pending_cents: number | null }>(
        `SELECT SUM(amount_cents) AS pending_cents
           FROM transactions
          WHERE account_id = ? AND pending = 1`,
        accountId,
      );
      const pendingBalanceCents = pending?.pending_cents ?? 0;
      const account: AccountRow = {
        ...base,
        pending_balance_cents: pendingBalanceCents,
        balance_with_pending_cents: (base.current_balance_cents ?? 0) + pendingBalanceCents,
      };

      const history = await db.all<{ date: string; balance_cents: number }>(
        `SELECT date, balance_cents
           FROM (
             SELECT date, balance_cents
               FROM balance_history
              WHERE account_id = ?
              ORDER BY date DESC
              LIMIT 366
           )
          ORDER BY date`,
        accountId,
      );

      const activity = await createTransactionsService(db).list(userId, {
        accountId,
        limit: 8,
        offset: 0,
      });

      const month = await db.get<{
        income_cents: number | null;
        expense_cents: number | null;
      }>(
        `SELECT
           SUM(CASE WHEN amount_cents > 0 AND is_transfer = 0 THEN amount_cents ELSE 0 END) AS income_cents,
           SUM(CASE WHEN amount_cents < 0 AND is_transfer = 0 THEN -amount_cents ELSE 0 END) AS expense_cents
           FROM transactions
          WHERE account_id = ? AND date >= ? AND pending = 0`,
        accountId,
        monthStartIso(),
      );
      const monthIncomeCents = month?.income_cents ?? 0;
      const monthExpenseCents = month?.expense_cents ?? 0;

      const liability = await db.get<{
        kind: string;
        next_payment_due_date: string | null;
        minimum_payment_cents: number | null;
        statement_balance_cents: number | null;
        statement_date: string | null;
        next_monthly_payment_cents: number | null;
        apr_bps: number | null;
        last_payment_amount_cents: number | null;
        last_payment_date: string | null;
        raw_status: string | null;
        synced_at: string;
      }>(
        `SELECT kind, next_payment_due_date, minimum_payment_cents,
                statement_balance_cents, statement_date, next_monthly_payment_cents,
                apr_bps, last_payment_amount_cents, last_payment_date,
                raw_status, synced_at
           FROM liabilities
          WHERE account_id = ? AND active = 1
          ORDER BY synced_at DESC
          LIMIT 1`,
        accountId,
      );

      const rawHoldings = await db.all<{
        id: string;
        name: string;
        ticker: string | null;
        security_type: string | null;
        quantity: number;
        institution_price_cents: number | null;
        institution_value_cents: number | null;
        cost_basis_cents: number | null;
        currency: string;
      }>(
        `SELECT h.id, s.name, s.ticker, s.security_type, h.quantity,
                h.institution_price_cents, h.institution_value_cents,
                h.cost_basis_cents, h.currency
           FROM investment_holdings h
           JOIN investment_securities s ON s.id = h.security_id
          WHERE h.account_id = ?
          ORDER BY COALESCE(h.institution_value_cents, 0) DESC, s.name`,
        accountId,
      );
      const holdings = rawHoldings.map((h): AccountHoldingDetail => {
        const valueCents =
          h.institution_value_cents ??
          (h.institution_price_cents == null ? 0 : Math.round(h.quantity * h.institution_price_cents));
        const gainCents = h.cost_basis_cents == null ? null : valueCents - h.cost_basis_cents;
        const gainPct =
          h.cost_basis_cents == null || h.cost_basis_cents === 0
            ? null
            : (gainCents! / Math.abs(h.cost_basis_cents)) * 100;
        return {
          id: h.id,
          securityName: h.name,
          ticker: h.ticker,
          securityType: h.security_type,
          quantity: h.quantity,
          priceCents: h.institution_price_cents,
          valueCents,
          costBasisCents: h.cost_basis_cents,
          gainCents,
          gainPct,
          currency: h.currency,
        };
      });

      return {
        account,
        history: history.map((p) => ({ date: p.date, balanceCents: p.balance_cents })),
        recentActivity: activity.rows,
        activityTotal: activity.total,
        monthIncomeCents,
        monthExpenseCents,
        monthNetCents: monthIncomeCents - monthExpenseCents,
        liability: liability
          ? {
              kind: liability.kind,
              nextPaymentDueDate: liability.next_payment_due_date,
              minimumPaymentCents: liability.minimum_payment_cents,
              statementBalanceCents: liability.statement_balance_cents,
              statementDate: liability.statement_date,
              nextMonthlyPaymentCents: liability.next_monthly_payment_cents,
              aprBps: liability.apr_bps,
              lastPaymentAmountCents: liability.last_payment_amount_cents,
              lastPaymentDate: liability.last_payment_date,
              rawStatus: liability.raw_status,
              syncedAt: liability.synced_at,
            }
          : null,
        holdings,
      };
    },
  };
}

export type AccountDetailService = ReturnType<typeof createAccountDetailService>;
