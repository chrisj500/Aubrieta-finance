import { apiErrors } from "@/lib/api-error";
import type { Db } from "@/server/db/types";

export type HouseholdRole = "owner" | "member";
export type FinancialVisibility = "shared" | "private";

export interface HouseholdContext {
  householdId: string;
  role: HouseholdRole;
}

export async function getHouseholdContext(
  db: Db,
  userId: string,
): Promise<HouseholdContext | null> {
  const row = await db.get<{ household_id: string; role: HouseholdRole }>(
    "SELECT household_id, role FROM household_members WHERE user_id = ?",
    userId,
  );
  return row ? { householdId: row.household_id, role: row.role } : null;
}

export async function requireHouseholdContext(
  db: Db,
  userId: string,
): Promise<HouseholdContext> {
  const ctx = await getHouseholdContext(db, userId);
  if (!ctx) throw apiErrors.forbidden("Your account is not attached to a household.");
  return ctx;
}
export async function accountReadScope(
  db: Db,
  userId: string,
  alias = "a",
): Promise<{ clause: string; params: unknown[]; householdId: string | null }> {
  const ctx = await getHouseholdContext(db, userId);
  if (!ctx) {
    return { clause: `${alias}.user_id = ?`, params: [userId], householdId: null };
  }
  return {
    clause: `(${alias}.owner_user_id = ? OR (${alias}.household_id = ? AND ${alias}.visibility = 'shared'))`,
    params: [userId, ctx.householdId],
    householdId: ctx.householdId,
  };
}

export async function objectReadScope(
  db: Db,
  userId: string,
  alias: string,
): Promise<{ clause: string; params: unknown[]; householdId: string | null }> {
  const ctx = await getHouseholdContext(db, userId);
  if (!ctx) {
    return { clause: `${alias}.user_id = ?`, params: [userId], householdId: null };
  }
  return {
    clause: `(${alias}.owner_user_id = ? OR (${alias}.household_id = ? AND ${alias}.visibility = 'shared'))`,
    params: [userId, ctx.householdId],
    householdId: ctx.householdId,
  };
}
export async function assertAccountReadable(
  db: Db,
  userId: string,
  accountId: string,
): Promise<void> {
  const scope = await accountReadScope(db, userId, "a");
  const row = await db.get(
    `SELECT a.id FROM accounts a WHERE a.id = ? AND a.deleted_at IS NULL AND ${scope.clause}`,
    accountId,
    ...scope.params,
  );
  if (!row) throw apiErrors.notFound("Account");
}

export async function assertAccountManageable(
  db: Db,
  userId: string,
  accountId: string,
  includeDeleted = false,
): Promise<void> {
  const row = await db.get(
    `SELECT id FROM accounts
      WHERE id = ?
        AND COALESCE(owner_user_id, user_id) = ?
        ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
    accountId,
    userId,
  );
  if (!row) throw apiErrors.notFound("Account");
}

export async function assertObjectManageable(
  db: Db,
  userId: string,
  table: "budgets" | "bills" | "goals" | "debts",
  id: string,
): Promise<void> {
  const row = await db.get(
    `SELECT id FROM ${table} WHERE id = ? AND COALESCE(owner_user_id, user_id) = ?`,
    id,
    userId,
  );
  if (!row) throw apiErrors.notFound(table.slice(0, -1));
}