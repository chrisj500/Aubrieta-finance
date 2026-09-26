import { randomUUID } from "@/lib/uuid";
import type { Db } from "@/server/db/types";
import { addDaysISO, addMonthsISO, daysBetween, todayISO } from "@/server/domain/dates";
import type { BillFrequency } from "@/server/domain/planning";
import type { ProviderKind, ProviderRecurringStream } from "@/server/providers/types";

const DETECTION_LOOKBACK_DAYS = 550;
const OCCURRENCE_HORIZON_DAYS = 120;

export type OccurrenceStatus = "upcoming" | "overdue" | "paid" | "skipped";

export interface BillOccurrence {
  id: string;
  user_id: string;
  bill_id: string;
  due_date: string;
  expected_amount_cents: number;
  actual_amount_cents: number | null;
  status: OccurrenceStatus;
  paid_transaction_id: string | null;
  paid_evidence: string | null;
  matched_at: string | null;
  source: string;
  source_confidence: string;
  created_at: string;
  updated_at: string;
  bill_name?: string;
  frequency?: string;
  account_name?: string | null;
  statement_balance_cents?: number | null;
  minimum_payment_cents?: number | null;
}

interface DetectionTxn {
  id: string;
  account_id: string;
  amount_cents: number;
  date: string;
  name: string;
  merchant_name: string | null;
  user_category_id: string | null;
  category_name: string | null;
}

interface SeriesCandidate {
  seriesKey: string;
  merchantKey: string;
  displayName: string;
  accountId: string;
  categoryId: string | null;
  categoryName: string | null;
  frequency: BillFrequency;
  intervalDays: number;
  typicalAmountCents: number;
  amountVarianceBps: number;
  occurrenceCount: number;
  lastAmountCents: number;
  lastSeenDate: string;
  nextExpectedDate: string;
  confidenceBps: number;
}

function now(): string {
  return new Date().toISOString();
}

export function normalizeRecurringMerchant(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(pending|purchase|payment|debit|card|pos|ach|online|recurring)\b/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

const DISCRETIONARY_CATEGORY_HINTS = [
  "grocery",
  "groceries",
  "food",
  "dining",
  "restaurant",
  "shopping",
  "transportation",
  "travel",
  "gas",
  "fuel",
];

function isLikelyDiscretionaryCategory(name: string | null): boolean {
  if (!name) return false;
  const normalized = normalizeRecurringMerchant(name);
  return DISCRETIONARY_CATEGORY_HINTS.some((hint) =>
    normalized.split(" ").some((token) => token === hint || token.startsWith(hint)),
  );
}

function meaningfulNameTokens(raw: string): Set<string> {
  const ignored = new Set(["bill", "payment", "monthly", "service", "services", "subscription"]);
  return new Set(
    normalizeRecurringMerchant(raw)
      .split(" ")
      .filter((token) => token.length >= 4 && !ignored.has(token)),
  );
}

function namesRelated(a: string, b: string): boolean {
  const na = normalizeRecurringMerchant(a);
  const nb = normalizeRecurringMerchant(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const left = meaningfulNameTokens(a);
  const right = meaningfulNameTokens(b);
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}

function dueDayDistance(a: number, b: number): number {
  const delta = Math.abs(a - b);
  return Math.min(delta, 31 - delta);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function cadenceFor(intervalDays: number): { frequency: BillFrequency; nominal: number } | null {
  if (intervalDays >= 5 && intervalDays <= 9) return { frequency: "weekly", nominal: 7 };
  if (intervalDays >= 12 && intervalDays <= 17) return { frequency: "biweekly", nominal: 14 };
  if (intervalDays >= 25 && intervalDays <= 36) return { frequency: "monthly", nominal: 30 };
  if (intervalDays >= 75 && intervalDays <= 105) return { frequency: "quarterly", nominal: 91 };
  if (intervalDays >= 330 && intervalDays <= 400) return { frequency: "yearly", nominal: 365 };
  return null;
}

function advanceByFrequency(date: string, frequency: BillFrequency): string | null {
  switch (frequency) {
    case "weekly":
      return addDaysISO(date, 7);
    case "biweekly":
      return addDaysISO(date, 14);
    case "monthly":
      return addMonthsISO(date, 1);
    case "quarterly":
      return addMonthsISO(date, 3);
    case "yearly":
      return addMonthsISO(date, 12);
    case "one-time":
      return null;
  }
}

function confidenceFor(
  occurrenceCount: number,
  intervals: number[],
  nominalDays: number,
  amountVarianceBps: number,
): number {
  const countScore = Math.min(2500, 800 + Math.max(0, occurrenceCount - 3) * 450);
  const cadenceError =
    intervals.length === 0
      ? nominalDays
      : intervals.reduce((sum, n) => sum + Math.abs(n - nominalDays), 0) / intervals.length;
  const cadenceScore = Math.max(0, 4500 - Math.round((cadenceError / nominalDays) * 9000));
  const amountScore = Math.max(0, 3000 - Math.min(3000, amountVarianceBps));
  return Math.max(0, Math.min(10_000, countScore + cadenceScore + amountScore));
}

function buildCandidate(rows: DetectionTxn[]): SeriesCandidate | null {
  if (rows.length < 3) return null;
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const intervals: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    intervals.push(daysBetween(ordered[i - 1].date, ordered[i].date));
  }
  const intervalDays = median(intervals);
  const cadence = cadenceFor(intervalDays);
  if (!cadence) return null;

  const amounts = ordered.map((row) => Math.abs(row.amount_cents)).filter((n) => n > 0);
  const typicalAmountCents = median(amounts);
  if (!typicalAmountCents) return null;
  const amountVarianceBps = Math.round(
    (median(amounts.map((n) => Math.abs(n - typicalAmountCents))) / typicalAmountCents) * 10_000,
  );
  const confidenceBps = confidenceFor(
    ordered.length,
    intervals,
    cadence.nominal,
    amountVarianceBps,
  );
  if (confidenceBps < 6500) return null;

  const last = ordered[ordered.length - 1];
  const merchantKey = normalizeRecurringMerchant(last.merchant_name ?? last.name);
  if (merchantKey.length < 3) return null;
  const nextExpectedDate = advanceByFrequency(last.date, cadence.frequency);
  if (!nextExpectedDate) return null;

  return {
    seriesKey: `detected:${last.account_id}:${merchantKey}:${cadence.frequency}`,
    merchantKey,
    displayName: (last.merchant_name ?? last.name).trim().slice(0, 100),
    accountId: last.account_id,
    categoryId: last.user_category_id,
    categoryName: last.category_name,
    frequency: cadence.frequency,
    intervalDays,
    typicalAmountCents,
    amountVarianceBps,
    occurrenceCount: ordered.length,
    lastAmountCents: Math.abs(last.amount_cents),
    lastSeenDate: last.date,
    nextExpectedDate,
    confidenceBps,
  };
}

async function upsertOccurrence(
  db: Db,
  input: {
    userId: string;
    billId: string;
    dueDate: string;
    amountCents: number;
    source: string;
    confidence: string;
  },
): Promise<void> {
  const ts = now();
  await db.run(
    `INSERT INTO bill_occurrences (
       id, user_id, bill_id, due_date, expected_amount_cents, actual_amount_cents,
       status, paid_transaction_id, paid_evidence, matched_at,
       source, source_confidence, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?)
     ON CONFLICT(bill_id, due_date) DO UPDATE SET
       expected_amount_cents = CASE
         WHEN bill_occurrences.status = 'paid' THEN bill_occurrences.expected_amount_cents
         ELSE excluded.expected_amount_cents
       END,
       source = excluded.source,
       source_confidence = excluded.source_confidence,
       updated_at = excluded.updated_at`,
    randomUUID(),
    input.userId,
    input.billId,
    input.dueDate,
    input.amountCents,
    input.dueDate < todayISO() ? "overdue" : "upcoming",
    input.source,
    input.confidence,
    ts,
    ts,
  );
}

export function createBillIntelligenceService(db: Db) {
  type ExistingBillMatch = {
    id: string;
    name: string;
    amount_cents: number;
    frequency: BillFrequency;
    due_day: number | null;
    next_due_date: string | null;
    category_id: string | null;
    account_id: string | null;
    source: string;
    recurring_series_id: string | null;
    provider_liability_id: string | null;
    user_overridden: number;
  };

  async function findEquivalentExistingBill(
    userId: string,
    seriesId: string,
    candidate: SeriesCandidate,
  ): Promise<ExistingBillMatch | null> {
    const bills = await db.all<ExistingBillMatch>(
      `SELECT id, name, amount_cents, frequency, due_day, next_due_date,
              category_id, account_id, source, recurring_series_id,
              provider_liability_id, user_overridden
         FROM bills
        WHERE user_id = ? AND active = 1
          AND provider_liability_id IS NULL
          AND (source = 'manual' OR user_overridden = 1)
          AND (recurring_series_id IS NULL OR recurring_series_id = ?)`,
      userId,
      seriesId,
    );

    const candidateDueDay = Number(candidate.nextExpectedDate.slice(8, 10));
    for (const bill of bills) {
      if (bill.frequency !== candidate.frequency) continue;
      if (bill.account_id && bill.account_id !== candidate.accountId) continue;

      const amountDelta = Math.abs(bill.amount_cents - candidate.typicalAmountCents);
      const amountTolerance = Math.max(500, Math.round(bill.amount_cents * 0.25));
      if (amountDelta > amountTolerance) continue;

      const billDueDay =
        bill.due_day ??
        (bill.next_due_date ? Number(bill.next_due_date.slice(8, 10)) : null);
      if (billDueDay === null || dueDayDistance(billDueDay, candidateDueDay) > 3) continue;

      const sameAccount = bill.account_id === candidate.accountId;
      const sameCategory =
        bill.category_id !== null &&
        candidate.categoryId !== null &&
        bill.category_id === candidate.categoryId;
      const tightAmount =
        amountDelta <= Math.max(200, Math.round(bill.amount_cents * 0.05));
      const nearExactDue = dueDayDistance(billDueDay, candidateDueDay) <= 1;
      const relatedName = namesRelated(bill.name, candidate.displayName);

      // Require either recognizable naming, matching account+category, or a
      // very strong schedule/amount fingerprint on the same account. This
      // deliberately avoids broad fuzzy-name merging.
      if (
        relatedName ||
        (sameAccount && sameCategory) ||
        (sameAccount && tightAmount && nearExactDue)
      ) {
        return bill;
      }
    }
    return null;
  }

  async function suppressDerivedBill(
    billId: string,
    userId: string,
    detachSeries: boolean,
  ): Promise<void> {
    const ts = now();
    await db.run(
      `UPDATE bill_occurrences
          SET status = 'skipped', updated_at = ?
        WHERE user_id = ? AND bill_id = ? AND status IN ('upcoming','overdue')`,
      ts,
      userId,
      billId,
    );
    await db.run(
      `UPDATE notification_events
          SET status = 'cancelled', updated_at = ?
        WHERE user_id = ? AND status = 'pending'
          AND bill_occurrence_id IN (
            SELECT id FROM bill_occurrences WHERE user_id = ? AND bill_id = ?
          )`,
      ts,
      userId,
      userId,
      billId,
    );
    await db.run(
      `UPDATE bills
          SET active = 0,
              recurring_series_id = CASE WHEN ? THEN NULL ELSE recurring_series_id END,
              updated_at = ?
        WHERE id = ? AND user_id = ?`,
      detachSeries ? 1 : 0,
      ts,
      billId,
      userId,
    );
  }

  async function upsertDetectedCandidate(userId: string, c: SeriesCandidate): Promise<string | null> {
    const ts = now();

    const providerSeries = await db.get<{ id: string }>(
      `SELECT id FROM recurring_series
        WHERE user_id = ? AND account_id = ? AND merchant_key = ?
          AND source = 'provider' AND active = 1 AND user_dismissed = 0
        LIMIT 1`,
      userId,
      c.accountId,
      c.merchantKey,
    );
    if (providerSeries) {
      const providerBill = await db.get<{ id: string }>(
        "SELECT id FROM bills WHERE recurring_series_id = ? AND active = 1",
        providerSeries.id,
      );
      return providerBill?.id ?? null;
    }

    const existingSeries = await db.get<{ id: string; user_dismissed: number }>(
      "SELECT id, user_dismissed FROM recurring_series WHERE user_id = ? AND series_key = ?",
      userId,
      c.seriesKey,
    );
    if (existingSeries?.user_dismissed) return null;
    const seriesId = existingSeries?.id ?? randomUUID();

    if (existingSeries) {
      await db.run(
        `UPDATE recurring_series SET
           direction = 'outflow', merchant_key = ?, display_name = ?,
           frequency = ?, interval_days = ?, typical_amount_cents = ?,
           amount_variance_bps = ?, occurrence_count = ?, last_amount_cents = ?,
           last_seen_date = ?, next_expected_date = ?, account_id = ?,
           category_id = ?, source = 'detected', source_provider = NULL,
           source_external_id = NULL, confidence_bps = ?, active = 1,
           user_dismissed = 0, updated_at = ?
         WHERE id = ?`,
        c.merchantKey,
        c.displayName,
        c.frequency,
        c.intervalDays,
        c.typicalAmountCents,
        c.amountVarianceBps,
        c.occurrenceCount,
        c.lastAmountCents,
        c.lastSeenDate,
        c.nextExpectedDate,
        c.accountId,
        c.categoryId,
        c.confidenceBps,
        ts,
        seriesId,
      );
    } else {
      await db.run(
        `INSERT INTO recurring_series (
           id, user_id, series_key, direction, merchant_key, display_name,
           frequency, interval_days, typical_amount_cents, amount_variance_bps,
           occurrence_count, last_amount_cents, last_seen_date, next_expected_date,
           account_id, category_id, source, source_provider, source_external_id,
           confidence_bps, active, user_dismissed, created_at, updated_at
         ) VALUES (?, ?, ?, 'outflow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   'detected', NULL, NULL, ?, 1, 0, ?, ?)`,
        seriesId,
        userId,
        c.seriesKey,
        c.merchantKey,
        c.displayName,
        c.frequency,
        c.intervalDays,
        c.typicalAmountCents,
        c.amountVarianceBps,
        c.occurrenceCount,
        c.lastAmountCents,
        c.lastSeenDate,
        c.nextExpectedDate,
        c.accountId,
        c.categoryId,
        c.confidenceBps,
        ts,
        ts,
      );
    }

    let bill = await db.get<{
      id: string;
      source: string;
      user_overridden: number;
      provider_liability_id: string | null;
    }>(
      "SELECT id, source, user_overridden, provider_liability_id FROM bills WHERE recurring_series_id = ?",
      seriesId,
    );

    const equivalent = await findEquivalentExistingBill(userId, seriesId, c);
    if (equivalent && equivalent.id !== bill?.id) {
      // A manual/user-owned bill is the obligation of record. Attach the
      // detected series to it so transaction history can enrich the bill
      // without creating a second cash obligation.
      if (bill && !bill.user_overridden && !bill.provider_liability_id) {
        await suppressDerivedBill(bill.id, userId, true);
      }
      await db.run(
        `UPDATE bills SET recurring_series_id = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`,
        seriesId,
        ts,
        equivalent.id,
        userId,
      );
      return equivalent.id;
    }

    // Transaction cadence alone is not enough to turn common discretionary
    // shopping/dining/travel activity into a bill. A matching manual bill can
    // still opt such a series into the Bills model through the branch above.
    if (isLikelyDiscretionaryCategory(c.categoryName)) {
      if (bill?.user_overridden) return bill.id;
      if (bill && !bill.provider_liability_id) {
        await suppressDerivedBill(bill.id, userId, false);
      }
      return null;
    }

    if (!bill) {
      const id = randomUUID();
      await db.run(
        `INSERT INTO bills (
           id, user_id, name, amount_cents, frequency, due_day, next_due_date,
           last_paid_amount_cents, category_id, account_id, active, notes,
           created_at, updated_at, provider_liability_id, source, source_confidence,
           recurring_series_id, user_overridden
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, NULL,
                   'detected', 'predicted', ?, 0)`,
        id,
        userId,
        c.displayName,
        c.typicalAmountCents,
        c.frequency,
        Number(c.nextExpectedDate.slice(8, 10)),
        c.nextExpectedDate,
        c.categoryId,
        c.accountId,
        `Detected from ${c.occurrenceCount} recurring transactions · confidence ${Math.round(c.confidenceBps / 100)}%.`,
        ts,
        ts,
        seriesId,
      );
      bill = { id, source: "detected", user_overridden: 0, provider_liability_id: null };
    } else if (bill.source === "manual" || bill.user_overridden) {
      // The recurring series may enrich a user-owned bill, but detection must
      // never take ownership of its name/schedule/source on later passes.
      return bill.id;
    } else if (!bill.provider_liability_id) {
      await db.run(
        `UPDATE bills SET
           name = ?, amount_cents = ?, frequency = ?, due_day = ?,
           next_due_date = ?, category_id = COALESCE(?, category_id),
           account_id = ?, active = 1, source = 'detected',
           source_confidence = 'predicted', notes = ?, updated_at = ?
         WHERE id = ?`,
        c.displayName,
        c.typicalAmountCents,
        c.frequency,
        Number(c.nextExpectedDate.slice(8, 10)),
        c.nextExpectedDate,
        c.categoryId,
        c.accountId,
        `Detected from ${c.occurrenceCount} recurring transactions · confidence ${Math.round(c.confidenceBps / 100)}%.`,
        ts,
        bill.id,
      );
    }

    return bill.id;
  }

  async function syncProviderStreams(
    userId: string,
    connectionId: string,
    provider: ProviderKind,
    streams: ProviderRecurringStream[],
  ): Promise<number> {
    const refs = await db.all<{ account_id: string; external_account_id: string }>(
      `SELECT account_id, external_account_id
         FROM account_provider_refs
        WHERE user_id = ? AND connection_id = ? AND provider = ?`,
      userId,
      connectionId,
      provider,
    );
    const accountByExternal = new Map(refs.map((r) => [r.external_account_id, r.account_id]));
    let count = 0;
    const ts = now();

    for (const stream of streams) {
      if (stream.direction !== "outflow") continue;
      const accountId = accountByExternal.get(stream.accountExternalId);
      if (!accountId || !stream.nextExpectedDate || !stream.active) continue;
      const frequency =
        stream.cadence && stream.cadence !== "unknown"
          ? stream.cadence
          : "monthly";
      const amount = Math.abs(stream.averageAmountMinor ?? stream.lastAmountMinor ?? 0);
      if (!amount) continue;
      const merchantKey = normalizeRecurringMerchant(stream.merchant ?? stream.description);
      const seriesKey = `provider:${provider}:${stream.externalId}`;
      const existing = await db.get<{ id: string; user_dismissed: number }>(
        "SELECT id, user_dismissed FROM recurring_series WHERE user_id = ? AND series_key = ?",
        userId,
        seriesKey,
      );
      const seriesId = existing?.id ?? randomUUID();

      const common = [
        merchantKey,
        (stream.merchant ?? stream.description).slice(0, 100),
        frequency,
        frequency === "weekly" ? 7 : frequency === "biweekly" ? 14 : frequency === "quarterly" ? 91 : frequency === "yearly" ? 365 : 30,
        amount,
        stream.lastAmountMinor ? Math.abs(stream.lastAmountMinor) : amount,
        stream.lastDate ?? null,
        stream.nextExpectedDate,
        accountId,
        provider,
        stream.externalId,
        ts,
      ] as const;

      if (existing) {
        await db.run(
          `UPDATE recurring_series SET
             merchant_key = ?, display_name = ?, frequency = ?, interval_days = ?,
             typical_amount_cents = ?, last_amount_cents = ?, last_seen_date = ?,
             next_expected_date = ?, account_id = ?, source = 'provider',
             source_provider = ?, source_external_id = ?, confidence_bps = 9000,
             active = CASE WHEN user_dismissed = 1 THEN 0 ELSE 1 END,
             updated_at = ?
           WHERE id = ?`,
          ...common,
          seriesId,
        );
      } else {
        await db.run(
          `INSERT INTO recurring_series (
             id, user_id, series_key, direction, merchant_key, display_name,
             frequency, interval_days, typical_amount_cents, amount_variance_bps,
             occurrence_count, last_amount_cents, last_seen_date, next_expected_date,
             account_id, category_id, source, source_provider, source_external_id,
             confidence_bps, active, user_dismissed, created_at, updated_at
           ) VALUES (?, ?, ?, 'outflow', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, NULL,
                     'provider', ?, ?, 9000, 1, 0, ?, ?)`,
          seriesId,
          userId,
          seriesKey,
          merchantKey,
          (stream.merchant ?? stream.description).slice(0, 100),
          frequency,
          frequency === "weekly" ? 7 : frequency === "biweekly" ? 14 : frequency === "quarterly" ? 91 : frequency === "yearly" ? 365 : 30,
          amount,
          stream.lastAmountMinor ? Math.abs(stream.lastAmountMinor) : amount,
          stream.lastDate ?? null,
          stream.nextExpectedDate,
          accountId,
          provider,
          stream.externalId,
          ts,
          ts,
        );
      }

      if (existing?.user_dismissed) {
        await db.run(
          "UPDATE bills SET active = 0, updated_at = ? WHERE recurring_series_id = ?",
          ts,
          seriesId,
        );
        count++;
        continue;
      }

      let bill = await db.get<{ id: string; user_overridden: number }>(
        "SELECT id, user_overridden FROM bills WHERE recurring_series_id = ?",
        seriesId,
      );
      if (!bill) {
        const id = randomUUID();
        await db.run(
          `INSERT INTO bills (
             id, user_id, name, amount_cents, frequency, due_day, next_due_date,
             last_paid_amount_cents, category_id, account_id, active, notes,
             created_at, updated_at, provider_liability_id, source, source_confidence,
             recurring_series_id, user_overridden
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?,
                     ?, ?, NULL, 'provider_recurring', 'provider', ?, 0)`,
          id,
          userId,
          (stream.merchant ?? stream.description).slice(0, 100),
          amount,
          frequency,
          Number(stream.nextExpectedDate.slice(8, 10)),
          stream.nextExpectedDate,
          accountId,
          "Provider-identified recurring transaction stream.",
          ts,
          ts,
          seriesId,
        );
        bill = { id, user_overridden: 0 };
      } else if (!bill.user_overridden) {
        await db.run(
          `UPDATE bills SET name = ?, amount_cents = ?, frequency = ?,
             due_day = ?, next_due_date = ?, account_id = ?, active = 1,
             source = 'provider_recurring', source_confidence = 'provider',
             updated_at = ? WHERE id = ?`,
          (stream.merchant ?? stream.description).slice(0, 100),
          amount,
          frequency,
          Number(stream.nextExpectedDate.slice(8, 10)),
          stream.nextExpectedDate,
          accountId,
          ts,
          bill.id,
        );
      }
      count++;
    }
    return count;
  }

  async function detectRecurring(userId: string): Promise<{
    detected: number;
    billsUpserted: number;
  }> {
    const from = addDaysISO(todayISO(), -DETECTION_LOOKBACK_DAYS);
    const rows = await db.all<DetectionTxn>(
      `SELECT t.id, t.account_id, t.amount_cents, t.date, t.name, t.merchant_name,
              t.user_category_id, c.name AS category_name
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.user_category_id
        WHERE a.user_id = ? AND a.deleted_at IS NULL
          AND t.date >= ? AND t.amount_cents < 0
          AND t.pending = 0 AND t.is_transfer = 0
        ORDER BY t.date ASC`,
      userId,
      from,
    );

    const groups = new Map<string, DetectionTxn[]>();
    for (const row of rows) {
      const merchantKey = normalizeRecurringMerchant(row.merchant_name ?? row.name);
      if (merchantKey.length < 3) continue;
      const key = `${row.account_id}|${merchantKey}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    let detected = 0;
    let billsUpserted = 0;
    const activeKeys = new Set<string>();
    for (const group of groups.values()) {
      const candidate = buildCandidate(group);
      if (!candidate) continue;
      activeKeys.add(candidate.seriesKey);
      detected++;
      const billId = await upsertDetectedCandidate(userId, candidate);
      if (billId) billsUpserted++;
    }

    const existing = await db.all<{ id: string; series_key: string }>(
      "SELECT id, series_key FROM recurring_series WHERE user_id = ? AND source = 'detected' AND active = 1 AND user_dismissed = 0",
      userId,
    );
    for (const row of existing) {
      if (!activeKeys.has(row.series_key)) {
        await db.run("UPDATE recurring_series SET active = 0, updated_at = ? WHERE id = ?", now(), row.id);
        await db.run(
          "UPDATE bills SET active = CASE WHEN user_overridden = 1 THEN active ELSE 0 END, updated_at = ? WHERE recurring_series_id = ?",
          now(),
          row.id,
        );
      }
    }

    return { detected, billsUpserted };
  }

  async function ensureOccurrences(userId: string, horizonDays = OCCURRENCE_HORIZON_DAYS): Promise<number> {
    const horizon = addDaysISO(todayISO(), horizonDays);
    const bills = await db.all<{
      id: string;
      amount_cents: number;
      frequency: BillFrequency;
      next_due_date: string | null;
      source: string;
      source_confidence: string;
      active: number;
    }>(
      `SELECT id, amount_cents, frequency, next_due_date, source, source_confidence, active
         FROM bills WHERE user_id = ? AND active = 1 AND next_due_date IS NOT NULL`,
      userId,
    );

    let count = 0;
    for (const bill of bills) {
      let due = bill.next_due_date;
      let guard = 0;
      while (due && due <= horizon && guard < 64) {
        guard++;
        await upsertOccurrence(db, {
          userId,
          billId: bill.id,
          dueDate: due,
          amountCents: bill.amount_cents,
          source: bill.source,
          confidence: bill.source_confidence,
        });
        count++;
        due = advanceByFrequency(due, bill.frequency);
      }
    }

    await db.run(
      `UPDATE bill_occurrences SET status = 'overdue', updated_at = ?
        WHERE user_id = ? AND status = 'upcoming' AND due_date < ?`,
      now(),
      userId,
      todayISO(),
    );
    return count;
  }

  async function matchPayments(userId: string): Promise<number> {
    const open = await db.all<{
      id: string;
      bill_id: string;
      due_date: string;
      expected_amount_cents: number;
      bill_name: string;
      bill_account_id: string | null;
      recurring_series_id: string | null;
      provider_liability_id: string | null;
      merchant_key: string | null;
    }>(
      `SELECT o.id, o.bill_id, o.due_date, o.expected_amount_cents,
              b.name AS bill_name, b.account_id AS bill_account_id,
              b.recurring_series_id, b.provider_liability_id,
              rs.merchant_key
         FROM bill_occurrences o
         JOIN bills b ON b.id = o.bill_id
         LEFT JOIN recurring_series rs ON rs.id = b.recurring_series_id
        WHERE o.user_id = ? AND o.status IN ('upcoming','overdue')`,
      userId,
    );

    let matched = 0;
    for (const occ of open) {
      const from = addDaysISO(occ.due_date, -10);
      const to = addDaysISO(occ.due_date, 10);

      if (occ.provider_liability_id) {
        const liability = await db.get<{
          last_payment_amount_cents: number | null;
          last_payment_date: string | null;
        }>(
          "SELECT last_payment_amount_cents, last_payment_date FROM liabilities WHERE id = ? AND active = 1",
          occ.provider_liability_id,
        );
        if (
          liability?.last_payment_date &&
          liability.last_payment_date >= from &&
          liability.last_payment_date <= to &&
          (liability.last_payment_amount_cents ?? 0) > 0
        ) {
          await db.run(
            `UPDATE bill_occurrences SET status = 'paid', actual_amount_cents = ?,
               paid_evidence = 'provider_liability', matched_at = ?, updated_at = ?
             WHERE id = ?`,
            liability.last_payment_amount_cents,
            now(),
            now(),
            occ.id,
          );
          await db.run(
            "UPDATE bills SET last_paid_amount_cents = ?, updated_at = ? WHERE id = ?",
            liability.last_payment_amount_cents,
            now(),
            occ.bill_id,
          );
          matched++;
          continue;
        }
      }

      const merchantKey = occ.merchant_key;
      const candidates = await db.all<{
        id: string;
        amount_cents: number;
        date: string;
        name: string;
        merchant_name: string | null;
        account_id: string;
      }>(
        `SELECT t.id, t.amount_cents, t.date, t.name, t.merchant_name, t.account_id
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE a.user_id = ? AND a.deleted_at IS NULL
            AND t.pending = 0 AND t.is_transfer = 0
            AND t.amount_cents < 0 AND t.date BETWEEN ? AND ?
            AND NOT EXISTS (
              SELECT 1 FROM bill_occurrences x WHERE x.paid_transaction_id = t.id
            )`,
        userId,
        from,
        to,
      );

      let best:
        | {
            id: string;
            amount_cents: number;
            score: number;
          }
        | null = null;
      for (const txn of candidates) {
        const actual = Math.abs(txn.amount_cents);
        const amountDelta = Math.abs(actual - occ.expected_amount_cents);
        const amountTolerance = Math.max(500, Math.round(occ.expected_amount_cents * 0.25));
        if (amountDelta > amountTolerance) continue;
        const txnMerchant = normalizeRecurringMerchant(txn.merchant_name ?? txn.name);
        const merchantMatch = merchantKey && txnMerchant === merchantKey;
        const accountMatch = occ.bill_account_id && txn.account_id === occ.bill_account_id;
        if (!merchantMatch && !accountMatch) continue;
        const dateDistance = Math.abs(daysBetween(txn.date, occ.due_date));
        const score =
          (merchantMatch ? 10_000 : 0) +
          (accountMatch ? 3000 : 0) -
          Math.min(2500, Math.round((amountDelta / Math.max(1, occ.expected_amount_cents)) * 5000)) -
          dateDistance * 100;
        if (!best || score > best.score) {
          best = { id: txn.id, amount_cents: actual, score };
        }
      }

      if (best && best.score >= 7000) {
        await db.run(
          `UPDATE bill_occurrences SET status = 'paid', actual_amount_cents = ?,
             paid_transaction_id = ?, paid_evidence = 'transaction_match',
             matched_at = ?, updated_at = ? WHERE id = ?`,
          best.amount_cents,
          best.id,
          now(),
          now(),
          occ.id,
        );
        await db.run(
          "UPDATE bills SET last_paid_amount_cents = ?, updated_at = ? WHERE id = ?",
          best.amount_cents,
          now(),
          occ.bill_id,
        );
        matched++;
      }
    }
    return matched;
  }

  async function scheduleReminders(userId: string): Promise<number> {
    const prefs = await db.get<{
      bill_reminders_enabled: number;
      bill_reminder_days: string;
      notif_time: string;
    }>(
      "SELECT bill_reminders_enabled, bill_reminder_days, notif_time FROM user_settings WHERE user_id = ?",
      userId,
    );
    if (prefs && prefs.bill_reminders_enabled === 0) return 0;
    let offsets = [7, 3, 1, 0];
    if (prefs?.bill_reminder_days) {
      try {
        const parsed = JSON.parse(prefs.bill_reminder_days);
        if (Array.isArray(parsed)) {
          offsets = parsed
            .filter((n) => Number.isInteger(n) && n >= 0 && n <= 30)
            .slice(0, 8);
        }
      } catch {
        // defaults
      }
    }

    const reminderTime =
      prefs?.notif_time && /^\d{2}:\d{2}$/.test(prefs.notif_time)
        ? prefs.notif_time
        : "09:00";
    const reminderHorizon = addDaysISO(todayISO(), 30);
    const occurrences = await db.all<{ id: string; due_date: string; status: string }>(
      `SELECT id, due_date, status FROM bill_occurrences
        WHERE user_id = ?
          AND status IN ('upcoming','overdue')
          AND (status = 'overdue' OR due_date <= ?)`,
      userId,
      reminderHorizon,
    );
    let inserted = 0;
    const ts = now();
    for (const occ of occurrences) {
      if (occ.status === "overdue") {
        const dedupe = `${occ.id}:overdue`;
        const res = await db.run(
          `INSERT INTO notification_events (
             id, user_id, bill_occurrence_id, event_type, dedupe_key,
             scheduled_for, status, created_at, updated_at
           ) VALUES (?, ?, ?, 'bill_overdue', ?, ?, 'pending', ?, ?)
           ON CONFLICT(user_id, dedupe_key) DO NOTHING`,
          randomUUID(),
          userId,
          occ.id,
          dedupe,
          `${todayISO()}T${reminderTime}:00.000Z`,
          ts,
          ts,
        );
        inserted += res.changes ?? 0;
        continue;
      }
      for (const days of offsets) {
        const scheduledDate = addDaysISO(occ.due_date, -days);
        if (scheduledDate < todayISO()) continue;
        const eventType =
          days === 0
            ? "bill_due_today"
            : days === 1
              ? "bill_due_tomorrow"
              : "bill_due_soon";
        const dedupe = `${occ.id}:${eventType}:${days}`;
        const res = await db.run(
          `INSERT INTO notification_events (
             id, user_id, bill_occurrence_id, event_type, dedupe_key,
             scheduled_for, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(user_id, dedupe_key) DO NOTHING`,
          randomUUID(),
          userId,
          occ.id,
          eventType,
          dedupe,
          `${scheduledDate}T${reminderTime}:00.000Z`,
          ts,
          ts,
        );
        inserted += res.changes ?? 0;
      }
    }
    return inserted;
  }

  return {
    detectRecurring,
    syncProviderStreams,
    ensureOccurrences,
    matchPayments,
    scheduleReminders,

    async refresh(userId: string) {
      const detection = await detectRecurring(userId);
      const occurrences = await ensureOccurrences(userId);
      const matched = await matchPayments(userId);
      const reminders = await scheduleReminders(userId);
      return {
        ...detection,
        occurrences,
        matched,
        reminders,
      };
    },

    async listOccurrences(
      userId: string,
      from = addDaysISO(todayISO(), -31),
      to = addDaysISO(todayISO(), 120),
    ): Promise<BillOccurrence[]> {
      return db.all<BillOccurrence>(
        `SELECT o.*, b.name AS bill_name, b.frequency, a.name AS account_name,
                l.statement_balance_cents, l.minimum_payment_cents
           FROM bill_occurrences o
           JOIN bills b ON b.id = o.bill_id
           LEFT JOIN accounts a ON a.id = b.account_id
           LEFT JOIN liabilities l ON l.id = b.provider_liability_id
          WHERE o.user_id = ? AND o.due_date BETWEEN ? AND ?
          ORDER BY o.due_date ASC, b.name COLLATE NOCASE ASC`,
        userId,
        from,
        to,
      );
    },

    async markOccurrencePaid(
      userId: string,
      occurrenceId: string,
      actualAmountCents?: number,
    ): Promise<void> {
      const occ = await db.get<{
        id: string;
        bill_id: string;
        expected_amount_cents: number;
      }>(
        "SELECT id, bill_id, expected_amount_cents FROM bill_occurrences WHERE id = ? AND user_id = ?",
        occurrenceId,
        userId,
      );
      if (!occ) throw new Error("Bill occurrence not found.");
      const amount = actualAmountCents ?? occ.expected_amount_cents;
      await db.run(
        `UPDATE bill_occurrences SET status = 'paid', actual_amount_cents = ?,
           paid_evidence = 'manual', matched_at = ?, updated_at = ? WHERE id = ?`,
        amount,
        now(),
        now(),
        occurrenceId,
      );
      await db.run(
        "UPDATE bills SET last_paid_amount_cents = ?, updated_at = ? WHERE id = ?",
        amount,
        now(),
        occ.bill_id,
      );
    },
  };
}

export type BillIntelligenceService = ReturnType<typeof createBillIntelligenceService>;
