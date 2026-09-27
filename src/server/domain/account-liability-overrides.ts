import { assertAccountManageable } from "@/server/authz/household-access";
import { getDb, type Db } from "@/server/db/registry";

export interface AccountLiabilityOverride {
  account_id: string;
  user_id: string;
  due_day: number | null;
  apr_bps: number | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export function nextDueDateForDay(dueDay: number, base = new Date()): string {
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const today = Date.UTC(y, m, base.getUTCDate());

  const dateFor = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(dueDay, last)));
  };

  let candidate = dateFor(y, m);
  if (candidate.getTime() < today) candidate = dateFor(y, m + 1);
  return candidate.toISOString().slice(0, 10);
}

export function createAccountLiabilityOverrideService(db: Db = getDb()) {
  return {
    async get(userId: string, accountId: string): Promise<AccountLiabilityOverride | null> {
      return (await db.get<AccountLiabilityOverride>(
        "SELECT * FROM account_liability_overrides WHERE account_id = ? AND user_id = ?",
        accountId,
        userId,
      )) ?? null;
    },

    async set(
      userId: string,
      accountId: string,
      input: { dueDay?: number | null; aprBps?: number | null },
    ): Promise<AccountLiabilityOverride | null> {
      await assertAccountManageable(db, userId, accountId);
      const existing = await this.get(userId, accountId);
      const dueDay = input.dueDay !== undefined ? input.dueDay : existing?.due_day ?? null;
      const aprBps = input.aprBps !== undefined ? input.aprBps : existing?.apr_bps ?? null;
      if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) {
        throw new Error("Due day must be between 1 and 31.");
      }
      if (aprBps !== null && (!Number.isInteger(aprBps) || aprBps < 0 || aprBps > 100000)) {
        throw new Error("APR is outside the supported range.");
      }
      if (dueDay === null && aprBps === null) {
        await db.run("DELETE FROM account_liability_overrides WHERE account_id = ? AND user_id = ?", accountId, userId);
        return null;
      }
      const ts = now();
      await db.run(
        `INSERT INTO account_liability_overrides
           (account_id, user_id, due_day, apr_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           due_day = excluded.due_day,
           apr_bps = excluded.apr_bps,
           updated_at = excluded.updated_at`,
        accountId, userId, dueDay, aprBps, existing?.created_at ?? ts, ts,
      );
      return this.get(userId, accountId);
    },
  };
}
