import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb, seedManualAccount, seedUser } from "./helpers";
import {
  createBillIntelligenceService,
  normalizeRecurringMerchant,
} from "@/server/domain/bill-intelligence";
import { createPlanningService } from "@/server/domain/planning";
import { syncProviderLiabilities } from "@/server/domain/liabilities";
import { addDaysISO, addMonthsISO, todayISO } from "@/server/domain/dates";

async function seedExpense(
  db: ReturnType<typeof createTestDb>,
  accountId: string,
  input: {
    date: string;
    amountCents: number;
    name: string;
    merchant?: string | null;
    pending?: boolean;
    transfer?: boolean;
  },
) {
  await db.run(
    `INSERT INTO transactions (
       id, account_id, amount_cents, date, name, merchant_name,
       pending, is_transfer, source, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?)`,
    randomUUID(),
    accountId,
    input.amountCents,
    input.date,
    input.name,
    input.merchant ?? null,
    input.pending ? 1 : 0,
    input.transfer ? 1 : 0,
    new Date().toISOString(),
  );
}

async function seedProviderRef(
  db: ReturnType<typeof createTestDb>,
  userId: string,
  accountId: string,
  externalAccountId = "ext-account",
) {
  const ts = new Date().toISOString();
  await db.run(
    `INSERT INTO provider_connections (
       id, user_id, provider, external_connection_id, institution_name,
       status, capabilities_json, created_at, updated_at
     ) VALUES ('m2-conn', ?, 'plaid', 'm2-item', 'M2 Bank',
               'active', '["transactions","liabilities","recurring"]', ?, ?)`,
    userId,
    ts,
    ts,
  );
  await db.run(
    `INSERT INTO account_provider_refs (
       id, user_id, account_id, connection_id, provider,
       external_account_id, created_at, updated_at
     ) VALUES ('m2-ref', ?, ?, 'm2-conn', 'plaid', ?, ?, ?)`,
    userId,
    accountId,
    externalAccountId,
    ts,
    ts,
  );
}

function monthlyHistoryDates(): string[] {
  const today = todayISO();
  return [-3, -2, -1].map((offset) => addMonthsISO(today, offset));
}

describe("M2 recurring bill intelligence", () => {
  it("detects a stable monthly outflow and ignores pending/transfers", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-detect");
    const accountId = await seedManualAccount(db, user.id, "Checking");
    const [d1, d2, d3] = monthlyHistoryDates();

    await seedExpense(db, accountId, {
      date: d1,
      amountCents: -1499,
      name: "NETFLIX.COM 12345",
      merchant: "Netflix",
    });
    await seedExpense(db, accountId, {
      date: d2,
      amountCents: -1549,
      name: "NETFLIX.COM 77777",
      merchant: "Netflix",
    });
    await seedExpense(db, accountId, {
      date: d3,
      amountCents: -1599,
      name: "Netflix recurring",
      merchant: "Netflix",
    });
    await seedExpense(db, accountId, {
      date: addDaysISO(d3, 2),
      amountCents: -1599,
      name: "Netflix pending",
      merchant: "Netflix",
      pending: true,
    });
    await seedExpense(db, accountId, {
      date: addDaysISO(d3, 3),
      amountCents: -1599,
      name: "Netflix transfer",
      merchant: "Netflix",
      transfer: true,
    });

    const svc = createBillIntelligenceService(db);
    const result = await svc.detectRecurring(user.id);
    expect(result.detected).toBe(1);

    const series = await db.get<{
      frequency: string;
      occurrence_count: number;
      typical_amount_cents: number;
      source: string;
      confidence_bps: number;
      active: number;
    }>("SELECT frequency, occurrence_count, typical_amount_cents, source, confidence_bps, active FROM recurring_series");
    expect(series).toMatchObject({
      frequency: "monthly",
      occurrence_count: 3,
      typical_amount_cents: 1549,
      source: "detected",
      active: 1,
    });
    expect(series!.confidence_bps).toBeGreaterThanOrEqual(6500);

    const bill = await db.get<{
      name: string;
      amount_cents: number;
      source: string;
      source_confidence: string;
    }>("SELECT name, amount_cents, source, source_confidence FROM bills");
    expect(bill).toEqual({
      name: "Netflix",
      amount_cents: 1549,
      source: "detected",
      source_confidence: "predicted",
    });
  });

  it("does not promote irregular one-off spending into a recurring bill", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-irregular");
    const accountId = await seedManualAccount(db, user.id);
    const today = todayISO();

    for (const [offset, amount] of [
      [-140, -2500],
      [-93, -7100],
      [-17, -1900],
    ] as const) {
      await seedExpense(db, accountId, {
        date: addDaysISO(today, offset),
        amountCents: amount,
        name: "Random Shop",
        merchant: "Random Shop",
      });
    }

    const result = await createBillIntelligenceService(db).detectRecurring(user.id);
    expect(result.detected).toBe(0);
    expect(await db.get("SELECT id FROM bills")).toBeUndefined();
  });


  it("associates a matching manual bill instead of creating a duplicate detected obligation", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-manual-dedupe");
    const accountId = await seedManualAccount(db, user.id, "Checking");
    const planning = createPlanningService(db);

    const manual = await planning.createBill(user.id, {
      name: "Rent",
      amountCents: 145000,
      frequency: "monthly",
      dueDay: 1,
      nextDueDate: addMonthsISO(todayISO(), 1).slice(0, 8) + "01",
      accountId,
    });

    for (const date of monthlyHistoryDates()) {
      await seedExpense(db, accountId, {
        date: date.slice(0, 8) + "01",
        amountCents: -145000,
        name: "Maple Ridge Apartments",
        merchant: "Maple Ridge Apartments",
      });
    }

    const svc = createBillIntelligenceService(db);
    const first = await svc.detectRecurring(user.id);
    const second = await svc.detectRecurring(user.id);
    expect(first.detected).toBe(1);
    expect(second.detected).toBe(1);

    const bills = await db.all<{ id: string; source: string; recurring_series_id: string | null; active: number }>(
      "SELECT id, source, recurring_series_id, active FROM bills WHERE user_id = ? ORDER BY created_at",
      user.id,
    );
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      id: manual.id,
      source: "manual",
      active: 1,
    });
    expect(bills[0].recurring_series_id).toBeTruthy();

    const before = await createPlanningService(db).digest(user.id, 30);
    await svc.detectRecurring(user.id);
    const after = await createPlanningService(db).digest(user.id, 30);
    expect(after.totalUpcomingCents).toBe(before.totalUpcomingCents);
  });

  it("suppresses common discretionary monthly spending from becoming bills", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-discretionary");
    const accountId = await seedManualAccount(db, user.id, "Checking");
    const ts = new Date().toISOString();
    const categoryId = randomUUID();
    await db.run(
      "INSERT INTO categories (id, user_id, name, is_system, created_at) VALUES (?, ?, 'Groceries', 1, ?)",
      categoryId,
      user.id,
      ts,
    );

    for (const date of monthlyHistoryDates()) {
      await db.run(
        `INSERT INTO transactions (
           id, account_id, amount_cents, date, name, merchant_name,
           pending, is_transfer, source, user_category_id, created_at
         ) VALUES (?, ?, -6800, ?, 'Whole Foods Market', 'Whole Foods Market',
                   0, 0, 'test', ?, ?)`,
        randomUUID(),
        accountId,
        date.slice(0, 8) + "11",
        categoryId,
        ts,
      );
    }

    const result = await createBillIntelligenceService(db).detectRecurring(user.id);
    expect(result.detected).toBe(1);
    expect(result.billsUpserted).toBe(0);
    expect(await db.get("SELECT id FROM bills WHERE user_id = ?", user.id)).toBeUndefined();
  });

  it("still detects an unrelated non-discretionary recurring bill", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-utility-detect");
    const accountId = await seedManualAccount(db, user.id, "Checking");
    const ts = new Date().toISOString();
    const categoryId = randomUUID();
    await db.run(
      "INSERT INTO categories (id, user_id, name, is_system, created_at) VALUES (?, ?, 'Utilities', 1, ?)",
      categoryId,
      user.id,
      ts,
    );

    for (const date of monthlyHistoryDates()) {
      await db.run(
        `INSERT INTO transactions (
           id, account_id, amount_cents, date, name, merchant_name,
           pending, is_transfer, source, user_category_id, created_at
         ) VALUES (?, ?, -9400, ?, 'City Power & Light', 'City Power & Light',
                   0, 0, 'test', ?, ?)`,
        randomUUID(),
        accountId,
        date.slice(0, 8) + "07",
        categoryId,
        ts,
      );
    }

    const result = await createBillIntelligenceService(db).detectRecurring(user.id);
    expect(result.billsUpserted).toBe(1);
    const bill = await db.get<{ name: string; source: string }>(
      "SELECT name, source FROM bills WHERE user_id = ?",
      user.id,
    );
    expect(bill).toEqual({ name: "City Power & Light", source: "detected" });
  });

  it("lets a provider recurring stream outrank an equivalent local prediction", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-provider-recurring");
    const accountId = await seedManualAccount(db, user.id, "Rewards Card", "credit");
    await seedProviderRef(db, user.id, accountId, "card-ext");

    const svc = createBillIntelligenceService(db);
    await svc.syncProviderStreams(user.id, "m2-conn", "plaid", [
      {
        externalId: "stream-netflix",
        accountExternalId: "card-ext",
        direction: "outflow",
        merchant: "Netflix",
        description: "Netflix",
        cadence: "monthly",
        averageAmountMinor: 1599,
        lastAmountMinor: 1599,
        lastDate: addMonthsISO(todayISO(), -1),
        nextExpectedDate: addDaysISO(todayISO(), 8),
        active: true,
      },
    ]);

    for (const date of monthlyHistoryDates()) {
      await seedExpense(db, accountId, {
        date,
        amountCents: -1599,
        name: "Netflix",
        merchant: "Netflix",
      });
    }
    await svc.detectRecurring(user.id);

    const bills = await db.all<{ source: string; name: string }>(
      "SELECT source, name FROM bills ORDER BY source",
    );
    expect(bills).toEqual([{ source: "provider_recurring", name: "Netflix" }]);
    const series = await db.all<{ source: string }>(
      "SELECT source FROM recurring_series WHERE active = 1",
    );
    expect(series).toEqual([{ source: "provider" }]);
  });

  it("allows subscriptions on a credit card to coexist with the card payment bill", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-card-coexist");
    const accountId = await seedManualAccount(db, user.id, "Travel Visa", "credit");
    await seedProviderRef(db, user.id, accountId, "visa-ext");

    await syncProviderLiabilities(db, user.id, "m2-conn", "plaid", [
      {
        accountExternalId: "visa-ext",
        kind: "credit_card",
        nextPaymentDueDate: addDaysISO(todayISO(), 12),
        minimumPaymentMinor: 4500,
        statementBalanceMinor: 100000,
      },
    ]);

    for (const date of monthlyHistoryDates()) {
      await seedExpense(db, accountId, {
        date,
        amountCents: -1999,
        name: "Streaming Service",
        merchant: "Streaming Service",
      });
    }
    await createBillIntelligenceService(db).detectRecurring(user.id);

    const bills = await db.all<{ source: string; name: string }>(
      "SELECT source, name FROM bills ORDER BY source",
    );
    expect(bills).toHaveLength(2);
    expect(bills.map((b) => b.source).sort()).toEqual(["detected", "provider"]);
  });

  it("dismisses detected series permanently until the user chooses otherwise", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-dismiss");
    const accountId = await seedManualAccount(db, user.id);
    for (const date of monthlyHistoryDates()) {
      await seedExpense(db, accountId, {
        date,
        amountCents: -1200,
        name: "Cloud Storage",
        merchant: "Cloud Storage",
      });
    }

    const intelligence = createBillIntelligenceService(db);
    await intelligence.detectRecurring(user.id);
    const bill = await db.get<{ id: string }>("SELECT id FROM bills");
    await createPlanningService(db).removeBill(user.id, bill!.id);

    await intelligence.detectRecurring(user.id);
    expect(await db.get("SELECT id FROM bills")).toBeUndefined();
    const series = await db.get<{ user_dismissed: number; active: number }>(
      "SELECT user_dismissed, active FROM recurring_series",
    );
    expect(series).toEqual({ user_dismissed: 1, active: 0 });
  });

  it("preserves user overrides when provider liability data refreshes", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-override");
    const accountId = await seedManualAccount(db, user.id, "Everyday Visa", "credit");
    await seedProviderRef(db, user.id, accountId, "card-ext");

    await syncProviderLiabilities(db, user.id, "m2-conn", "plaid", [
      {
        accountExternalId: "card-ext",
        kind: "credit_card",
        nextPaymentDueDate: addDaysISO(todayISO(), 10),
        minimumPaymentMinor: 5000,
        statementBalanceMinor: 90000,
      },
    ]);
    const planning = createPlanningService(db);
    const [bill] = await planning.listBills(user.id);
    const customDate = addDaysISO(todayISO(), 15);
    await planning.updateBill(user.id, bill.id, {
      amountCents: 12345,
      nextDueDate: customDate,
    });

    await syncProviderLiabilities(db, user.id, "m2-conn", "plaid", [
      {
        accountExternalId: "card-ext",
        kind: "credit_card",
        nextPaymentDueDate: addDaysISO(todayISO(), 20),
        minimumPaymentMinor: 7000,
        statementBalanceMinor: 120000,
      },
    ]);

    const updated = await planning.getBill(user.id, bill.id);
    expect(updated.amount_cents).toBe(12345);
    expect(updated.next_due_date).toBe(customDate);
    expect(updated.user_overridden).toBe(true);
    expect(updated.source_confidence).toBe("user");
    expect(updated.minimum_payment_cents).toBe(7000);
    expect(updated.statement_balance_cents).toBe(120000);
  });
});

describe("M2 occurrences, paid matching, and reminders", () => {
  it("generates future occurrences and marks a matched recurring transaction paid once", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-paid-match");
    const accountId = await seedManualAccount(db, user.id);
    for (const date of monthlyHistoryDates()) {
      await seedExpense(db, accountId, {
        date,
        amountCents: -2500,
        name: "Gym Membership",
        merchant: "Gym Membership",
      });
    }

    const svc = createBillIntelligenceService(db);
    await svc.detectRecurring(user.id);
    await svc.ensureOccurrences(user.id);
    const bill = await db.get<{ id: string; next_due_date: string }>(
      "SELECT id, next_due_date FROM bills",
    );

    await seedExpense(db, accountId, {
      date: bill!.next_due_date,
      amountCents: -2500,
      name: "Gym Membership",
      merchant: "Gym Membership",
    });
    expect(await svc.matchPayments(user.id)).toBe(1);
    expect(await svc.matchPayments(user.id)).toBe(0);

    const paid = await db.get<{
      status: string;
      actual_amount_cents: number;
      paid_evidence: string;
      paid_transaction_id: string | null;
    }>(
      "SELECT status, actual_amount_cents, paid_evidence, paid_transaction_id FROM bill_occurrences WHERE bill_id = ? AND due_date = ?",
      bill!.id,
      bill!.next_due_date,
    );
    expect(paid).toMatchObject({
      status: "paid",
      actual_amount_cents: 2500,
      paid_evidence: "transaction_match",
    });
    expect(paid?.paid_transaction_id).toBeTruthy();
  });

  it("uses provider-reported liability payments as stronger paid evidence", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-provider-paid");
    const accountId = await seedManualAccount(db, user.id, "Mortgage", "loan");
    await seedProviderRef(db, user.id, accountId, "mortgage-ext");
    const due = addDaysISO(todayISO(), 5);

    await syncProviderLiabilities(db, user.id, "m2-conn", "plaid", [
      {
        accountExternalId: "mortgage-ext",
        kind: "mortgage",
        nextPaymentDueDate: due,
        nextMonthlyPaymentMinor: 314154,
        lastPaymentAmountMinor: 314154,
        lastPaymentDate: addDaysISO(due, -1),
      },
    ]);

    const svc = createBillIntelligenceService(db);
    await svc.ensureOccurrences(user.id);
    expect(await svc.matchPayments(user.id)).toBe(1);
    const occ = await db.get<{
      status: string;
      actual_amount_cents: number;
      paid_evidence: string;
    }>("SELECT status, actual_amount_cents, paid_evidence FROM bill_occurrences");
    expect(occ).toEqual({
      status: "paid",
      actual_amount_cents: 314154,
      paid_evidence: "provider_liability",
    });
  });

  it("creates configured reminders once and skips stale reminder offsets", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-reminders");
    const planning = createPlanningService(db);
    await planning.createBill(user.id, {
      name: "Insurance",
      amountCents: 10000,
      frequency: "monthly",
      nextDueDate: addDaysISO(todayISO(), 3),
    });
    await db.run(
      "UPDATE user_settings SET bill_reminders_enabled = 1, bill_reminder_days = '[7,3,1,0]', notif_time = '07:30' WHERE user_id = ?",
      user.id,
    );

    const svc = createBillIntelligenceService(db);
    await svc.ensureOccurrences(user.id);
    const first = await svc.scheduleReminders(user.id);
    const second = await svc.scheduleReminders(user.id);
    expect(first).toBe(3); // 7-days-before is already stale; 3, 1 and 0 remain.
    expect(second).toBe(0);

    const events = await db.all<{
      event_type: string;
      scheduled_for: string;
    }>(
      "SELECT event_type, scheduled_for FROM notification_events ORDER BY scheduled_for",
    );
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.scheduled_for.includes("T07:30:00.000Z"))).toBe(true);
  });

  it("manual Paid records the exact occurrence before advancing the parent bill", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "m2-manual-paid");
    const planning = createPlanningService(db);
    const due = addDaysISO(todayISO(), 2);
    const bill = await planning.createBill(user.id, {
      name: "Water",
      amountCents: 8000,
      frequency: "monthly",
      nextDueDate: due,
    });

    const updated = await planning.payBill(user.id, bill.id, 9123);
    expect(updated.next_due_date).toBe(addMonthsISO(due, 1));

    const paid = await db.get<{
      status: string;
      actual_amount_cents: number;
      paid_evidence: string;
    }>(
      "SELECT status, actual_amount_cents, paid_evidence FROM bill_occurrences WHERE bill_id = ? AND due_date = ?",
      bill.id,
      due,
    );
    expect(paid).toEqual({
      status: "paid",
      actual_amount_cents: 9123,
      paid_evidence: "manual",
    });
  });
});

describe("recurring merchant normalization", () => {
  it("removes unstable transaction boilerplate and long numeric ids", () => {
    expect(normalizeRecurringMerchant("NETFLIX PAYMENT 123456")).toBe("netflix");
    expect(normalizeRecurringMerchant("ACH   Electric-Co 987654")).toBe("electric co");
  });
});
