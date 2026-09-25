"use client";

/**
 * Solo on-device notifications (P11).
 *
 * Privacy contract: NOTIFICATION CONTENT NEVER CONTAINS AMOUNTS. The phone
 * shows only status words ("on track" / "needs review" / "bill due") — the
 * numbers live inside the app, reached by tapping the notification.
 *
 * Strategy: local notifications are scheduled one-shot (the plugin can't
 * compute content at fire time). So on every app launch (and whenever prefs
 * change) we compute the CURRENT budget status and schedule the NEXT
 * occurrence (daily or weekly at the user's chosen time). Stale pending
 * notifications are cancelled first, so the schedule always reflects the
 * latest state.
 */

import type { Db } from "@/server/db/types";

export interface BudgetStatusSummary {
  onTrack: boolean;
  needsReview: boolean;
  budgetCount: number;
  billsDueSoon: number;
}

/** Compute a privacy-safe status summary from the local DB. */
export async function computeBudgetStatus(db: Db, userId: string): Promise<BudgetStatusSummary> {
  const { createBudgetsService } = await import("@/server/domain/budgets");
  const { createPlanningService } = await import("@/server/domain/planning");

  const budgets = await createBudgetsService(db).list(userId);
  let onTrack = 0;
  let needsReview = 0;
  for (const b of budgets) {
    // "needs review" = over budget or ≥85% spent (privacy-safe: no amounts)
    if (b.pct >= 0.85 || b.remainingCents < 0) needsReview++;
    else onTrack++;
  }

  let billsDueSoon = 0;
  try {
    // Bill occurrences are the canonical M2 schedule. Count upcoming/overdue
    // obligations without exposing any amount or merchant detail.
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 3);
    const until = soon.toISOString().slice(0, 10);
    const row = await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM bill_occurrences
        WHERE user_id = ?
          AND status IN ('upcoming','overdue')
          AND due_date <= ?`,
      userId,
      until,
    );
    billsDueSoon = row?.c ?? 0;
  } catch {
    // Pre-M2 databases can still open briefly during migration/bootstrap.
    const bills = await createPlanningService(db).listBills(userId).catch(() => []);
    billsDueSoon = bills.filter((bill) => bill.active).length > 0 ? 0 : 0;
  }

  return {
    onTrack: onTrack > 0,
    needsReview: needsReview > 0,
    budgetCount: budgets.length,
    billsDueSoon,
  };
}

function nextFire(hourMin: string, frequency: "daily" | "weekly", now = new Date()): Date {
  const [h, m] = hourMin.split(":").map((n) => parseInt(n, 10) || 0);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  if (frequency === "weekly") d.setDate(d.getDate() + 6);
  return d;
}

function titleFor(s: BudgetStatusSummary): string {
  if (s.billsDueSoon > 0) return "Bill due soon";
  if (s.needsReview) return "Budget needs review";
  if (s.onTrack) return "You're on track";
  return "Budget update";
}

function bodyFor(s: BudgetStatusSummary, frequency: "daily" | "weekly"): string {
  const when = frequency === "daily" ? "today" : "this week";
  if (s.budgetCount === 0) return `Open Open Finance to see your ${when} budget.`;
  if (s.needsReview) return `Some budgets need a look — open the app for details.`;
  return `Your budgets are on track ${when} — open the app for details.`;
}

export interface NotifPrefsInput {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;
  billRemindersEnabled?: boolean;
  billReminderDays?: number[];
}

/**
 * (Re)schedule the next status notification. Call on app launch + whenever
 * prefs change. Cancels pending first so stale content never fires.
 * Resolves the device user from the db itself — pass the solo CapSqliteDb.
 */
export async function syncNotificationSchedule(db: Db, prefs: NotifPrefsInput): Promise<void> {
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const pending = await LocalNotifications.getPending();
    await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });

    if (!prefs.enabled) return;

    const perms = await LocalNotifications.checkPermissions();
    if (perms.display !== "granted") {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== "granted") return;
    }

    const { createSoloBootstrapService } = await import("@/server/domain/solo-bootstrap");
    const user = await createSoloBootstrapService(db).getDeviceUser();
    if (!user) return;

    const summary = await computeBudgetStatus(db, user.id);
    const fire = nextFire(prefs.time, prefs.frequency);
    const notifications: Array<{
      id: number;
      title: string;
      body: string;
      schedule: { at: Date };
    }> = [
      {
        id: 1,
        title: titleFor(summary),
        body: bodyFor(summary, prefs.frequency),
        schedule: { at: fire },
      },
    ];

    if (prefs.billRemindersEnabled !== false) {
      const reminderDays =
        prefs.billReminderDays && prefs.billReminderDays.length > 0
          ? prefs.billReminderDays
          : [7, 3, 1, 0];
      const occurrences = await db.all<{
        id: string;
        due_date: string;
        status: string;
      }>(
        `SELECT id, due_date, status
           FROM bill_occurrences
          WHERE user_id = ?
            AND status IN ('upcoming','overdue')
          ORDER BY due_date ASC
          LIMIT 24`,
        user.id,
      );
      const [hour, minute] = prefs.time.split(":").map((n) => parseInt(n, 10) || 0);
      let notificationId = 100;
      const nowMs = Date.now();

      for (const occurrence of occurrences) {
        if (occurrence.status === "overdue") {
          const at = new Date();
          at.setHours(hour, minute, 0, 0);
          if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
          notifications.push({
            id: notificationId++,
            title: "Bill overdue",
            body: "A bill needs your attention — open Aubrieta for details.",
            schedule: { at },
          });
          continue;
        }

        for (const days of reminderDays) {
          const at = new Date(`${occurrence.due_date}T00:00:00`);
          at.setDate(at.getDate() - days);
          at.setHours(hour, minute, 0, 0);
          if (at.getTime() <= nowMs) continue;
          notifications.push({
            id: notificationId++,
            title:
              days === 0
                ? "Bill due today"
                : days === 1
                  ? "Bill due tomorrow"
                  : "Bill due soon",
            body: "You have an upcoming bill — open Aubrieta for details.",
            schedule: { at },
          });
          if (notifications.length >= 48) break;
        }
        if (notifications.length >= 48) break;
      }
    }

    await LocalNotifications.schedule({ notifications });
  } catch {
    /* notifications are best-effort — never crash the app over them */
  }
}
