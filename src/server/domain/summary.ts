import { getDb, type Db } from "@/server/db/registry";
import { createBudgetsService, frameBounds, monthBounds, type BudgetFrame } from "@/server/domain/budgets";
import { withAllowlist, type AllowlistCtx } from "@/server/db/allowlist";
import { markLinkedTransfers } from "@/server/domain/transfers";
import { createBillIntelligenceService } from "@/server/domain/bill-intelligence";
import { addDaysISO, todayISO } from "@/server/domain/dates";

/** Dashboard one-call briefing. */
export interface Summary {
  totalBalanceCents: number;
  byType: Record<string, number>;
  monthIncomeCents: number;
  monthExpenseCents: number;
  monthNetCents: number;
  budgetOverview: Array<{ id: string; name: string; spentCents: number; amountCents: number; pct: number }>;
  upcomingBills: Array<{
    occurrenceId: string;
    billId: string;
    name: string;
    dueDate: string;
    amountCents: number;
    status: string;
    source: string;
    sourceConfidence: string;
  }>;
  overdueBillCount: number;
  upcomingBillsTotalCents: number;
  recentTransactions: Array<{
    id: string;
    accountName: string;
    amountCents: number;
    date: string;
    name: string;
    categoryName: string | null;
    categoryColor: string | null;
  }>;
  /** Diagnostic: why the review queue reads what it does. Breaks the raw
   *  uncategorized total into transfers / pending / real "needs a category". */
  reviewDebug?: {
    rawUncategorized: number;
    transfers: number;
    pending: number;
    needsCategory: number;
  };
}

export function createSummaryService(db: Db = getDb()) {
  return {
    /**
     * @param allowlist BYOA account allowlist (null = all accounts). Every
     * account-derived figure flows through withAllowlist — the single choke point.
     */
    async get(
      userId: string,
      referenceDate: string = new Date().toISOString().slice(0, 10),
      allowlist?: AllowlistCtx | null,
      frame: BudgetFrame = { kind: "month" },
      includeExcluded = false,
      includePending = true
    ): Promise<Summary> {
      // Backfill linked card-payment transfers before calculating totals. This
      // also corrects transactions imported before transfer detection existed.
      await markLinkedTransfers(db, userId);
      const { start, end } = frame.kind === "period" ? monthBounds(referenceDate) : frameBounds(frame, referenceDate);
      const allowAccounts = withAllowlist(allowlist ?? null, "id");
      const allowTxns = withAllowlist(allowlist ?? null, "a.id");
      const accountHistoryClause = includeExcluded ? "" : " AND a.deleted_at IS NULL";

      // Net worth: each account's stored balance, plus any pending transactions
      // (pending amounts are sign-aware income/expense). Excluded by default and
      // toggled on via includePending (defaults true).
      const pendingClause = includePending
        ? " + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = accounts.id AND t.pending = 1 AND t.exclude_from_budgets = 0 AND t.is_transfer = 0), 0)"
        : "";
      const totals = await db.all<{ type: string | null; balance: number }>(
        `SELECT type,
                  COALESCE(SUM(CASE WHEN type IN ('credit', 'loan') THEN -ABS(COALESCE(current_balance_cents, 0))
                                   ELSE COALESCE(current_balance_cents, 0) END${pendingClause}), 0) AS balance
          FROM accounts WHERE user_id = ? AND hidden = 0 AND deleted_at IS NULL AND include_in_net_worth = 1${allowAccounts.clause} GROUP BY type`,
        userId,
        ...allowAccounts.params
      );
      const byType: Record<string, number> = {};
      let totalBalanceCents = 0;
      for (const t of totals) {
        // Accumulate: NULL-type and 'other'-type rows are distinct GROUP BY
        // groups that both map to the "other" bucket.
        const key = t.type ?? "other";
        byType[key] = (byType[key] ?? 0) + t.balance;
        totalBalanceCents += t.balance;
      }

      const monthPendingClause = includePending ? "" : " AND t.pending = 0";
      const month = await db.get<{ income: number; expense: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0) AS expense
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE a.user_id = ?${accountHistoryClause} AND t.date >= ? AND t.date < ? AND t.exclude_from_budgets = 0 AND t.is_transfer = 0${monthPendingClause}
            ${allowTxns.clause}`,
        userId,
        start,
        end,
        ...allowTxns.params
      );
      const monthIncomeCents = month?.income ?? 0;
      const monthExpenseCents = month?.expense ?? 0;

      const budgets = await createBudgetsService(db).list(userId, referenceDate, frame);
      const budgetOverview = budgets.map((b) => ({
        id: b.id,
        name: b.name,
        spentCents: b.spentCents,
        amountCents: b.amount_cents,
        pct: b.pct,
      }));

      const billIntelligence = createBillIntelligenceService(db);
      await billIntelligence.ensureOccurrences(userId);
      await billIntelligence.matchPayments(userId);
      const billOccurrences = await billIntelligence.listOccurrences(
        userId,
        addDaysISO(todayISO(), -365),
        addDaysISO(todayISO(), 30),
      );
      const upcomingBills = billOccurrences
        .filter((o) => o.status === "upcoming" && o.due_date >= todayISO())
        .slice(0, 5)
        .map((o) => ({
          occurrenceId: o.id,
          billId: o.bill_id,
          name: o.bill_name ?? "Bill",
          dueDate: o.due_date,
          amountCents: o.expected_amount_cents,
          status: o.status,
          source: o.source,
          sourceConfidence: o.source_confidence,
        }));
      const overdueBillCount = billOccurrences.filter(
        (o) => o.status === "overdue",
      ).length;
      const upcomingBillsTotalCents = billOccurrences
        .filter((o) => o.status === "upcoming" && o.due_date >= todayISO())
        .reduce((sum, o) => sum + o.expected_amount_cents, 0);

      const recent = await db.all<Summary["recentTransactions"][number]>(
        `SELECT t.id, a.name AS accountName, t.amount_cents AS amountCents, t.date,
                t.name, c.name AS categoryName, c.color AS categoryColor
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN categories c ON c.id = t.user_category_id
          WHERE a.user_id = ?${accountHistoryClause}${allowTxns.clause}
          ORDER BY t.date DESC, t.created_at DESC
          LIMIT 8`,
        userId,
        ...allowTxns.params
      );

      return {
        totalBalanceCents,
        byType,
        monthIncomeCents,
        monthExpenseCents,
        monthNetCents: monthIncomeCents - monthExpenseCents,
        budgetOverview,
        upcomingBills,
        overdueBillCount,
        upcomingBillsTotalCents,
        recentTransactions: recent,
        reviewDebug: await (async () => {
          const raw = await db.get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE a.user_id = ? AND a.deleted_at IS NULL AND t.user_category_id IS NULL AND t.source != 'manual'`,
            userId
          );
          const transfers = await db.get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE a.user_id = ? AND a.deleted_at IS NULL AND t.user_category_id IS NULL AND t.source != 'manual' AND t.is_transfer = 1`,
            userId
          );
          const pending = await db.get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE a.user_id = ? AND a.deleted_at IS NULL AND t.user_category_id IS NULL AND t.source != 'manual' AND t.is_transfer = 0 AND t.pending = 1`,
            userId
          );
          const rawC = raw?.c ?? 0;
          const txC = transfers?.c ?? 0;
          const pdC = pending?.c ?? 0;
          return {
            rawUncategorized: rawC,
            transfers: txC,
            pending: pdC,
            needsCategory: rawC - txC - pdC,
          };
        })(),
      };
    },
  };
}

export type SummaryService = ReturnType<typeof createSummaryService>;
