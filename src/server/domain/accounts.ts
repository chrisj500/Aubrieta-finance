import { randomUUID } from "@/lib/uuid";
import { apiErrors } from "@/lib/api-error";
import { assertValidCents } from "@/server/domain/money";
import { getDb, type Db } from "@/server/db/registry";
import { accountReadScope, assertAccountManageable, getHouseholdContext } from "@/server/authz/household-access";

export interface AccountRow {
  id: string;
  user_id: string;
  household_id: string | null;
  owner_user_id: string | null;
  visibility: "shared" | "private";
  owner_display_name?: string | null;
  is_owner?: boolean;
  item_id: string | null;
  plaid_account_id: string | null;
  name: string;
  name_override: string | null;
  official_name: string | null;
  type: string | null;
  subtype: string | null;
  mask: string | null;
  current_balance_cents: number | null;
  available_balance_cents: number | null;
  currency: string;
  institution_name: string | null;
  is_demo: number;
  include_in_net_worth: number;
  hidden: number;
  type_override: number;
  sort_order: number;
  description: string | null;
  deleted_at: string | null;
  created_at: string;
  /** Sum of pending transaction amounts for this account (positive = income). */
  pending_balance_cents?: number;
  /** current_balance_cents + pending_balance_cents (sign-aware). */
  balance_with_pending_cents?: number;
}

function now(): string {
  return new Date().toISOString();
}

const ACCOUNT_TYPES = ["depository", "credit", "investment", "loan", "other"] as const;

export function createAccountsService(db: Db = getDb()) {
  return {
    async list(userId: string): Promise<AccountRow[]> {
      const scope = await accountReadScope(db, userId, "a");
      const rows = await db.all<AccountRow>(
        `SELECT a.*,
          COALESCE(
            i.institution_name,
            (SELECT pc.institution_name
               FROM account_provider_refs apr
               JOIN provider_connections pc ON pc.id = apr.connection_id
              WHERE apr.account_id = a.id
              ORDER BY CASE apr.provider WHEN 'plaid' THEN 0 WHEN 'teller' THEN 1 ELSE 2 END
              LIMIT 1)
          ) AS institution_name,
          u.is_demo,
          owner.display_name AS owner_display_name,
          COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.pending = 1 AND t.exclude_from_budgets = 0 AND t.is_transfer = 0), 0) AS pending_balance_cents
           FROM accounts a
           LEFT JOIN plaid_items i ON i.id = a.item_id
           JOIN users u ON u.id = a.user_id
           LEFT JOIN users owner ON owner.id = COALESCE(a.owner_user_id, a.user_id)
          WHERE ${scope.clause} AND a.hidden = 0 AND a.deleted_at IS NULL
          ORDER BY a.sort_order, a.type, a.name COLLATE NOCASE`,
        ...scope.params,
      );
      return rows.map((a) => ({
        ...a,
        is_owner: (a.owner_user_id ?? a.user_id) === userId,
        balance_with_pending_cents:
          (a.current_balance_cents ?? 0) + (a.pending_balance_cents ?? 0),
      }));
    },

    /** Removed accounts (soft-deleted) so the user can restore them. */
    async listDeleted(userId: string): Promise<AccountRow[]> {
      const rows = await db.all<AccountRow>(
        `SELECT a.*,
          COALESCE(
            i.institution_name,
            (SELECT pc.institution_name
               FROM account_provider_refs apr
               JOIN provider_connections pc ON pc.id = apr.connection_id
              WHERE apr.account_id = a.id
              ORDER BY CASE apr.provider WHEN 'plaid' THEN 0 WHEN 'teller' THEN 1 ELSE 2 END
              LIMIT 1)
          ) AS institution_name,
          u.is_demo,
          u.display_name AS owner_display_name
           FROM accounts a
           LEFT JOIN plaid_items i ON i.id = a.item_id
           JOIN users u ON u.id = a.user_id
          WHERE COALESCE(a.owner_user_id, a.user_id) = ? AND a.deleted_at IS NOT NULL
          ORDER BY a.deleted_at DESC`,
        userId,
      );
      return rows.map((a) => ({ ...a, is_owner: true }));
    },

    /**
     * Agent-facing list: scoped by token scopes (read:investments only sees
     * investment accounts unless read:banking is also held) AND account allowlist.
     */
    async listForAgent(userId: string, scopes: string[], accountIds: string[] | null): Promise<AccountRow[]> {
      const scope = await accountReadScope(db, userId, "a");
      const conditions: string[] = [scope.clause, "a.hidden = 0", "a.deleted_at IS NULL"];
      const params: unknown[] = [...scope.params];
      const seeBanking = scopes.includes("read:banking");
      const seeInvestments = scopes.includes("read:investments");
      if (!seeBanking && seeInvestments) {
        conditions.push("a.type = 'investment'");
      } else if (seeBanking && !seeInvestments) {
        conditions.push("(a.type IS NULL OR a.type != 'investment')");
      } else if (!seeBanking && !seeInvestments) {
        conditions.push("0 = 1"); // no account scopes at all
      }
      if (accountIds !== null) {
        if (accountIds.length === 0) {
          conditions.push("0 = 1");
        } else {
          conditions.push(`a.id IN (${accountIds.map(() => "?").join(", ")})`);
          params.push(...accountIds);
        }
      }
      return db.all<AccountRow>(
        `SELECT a.*,
          COALESCE(
            i.institution_name,
            (SELECT pc.institution_name
               FROM account_provider_refs apr
               JOIN provider_connections pc ON pc.id = apr.connection_id
              WHERE apr.account_id = a.id
              ORDER BY CASE apr.provider WHEN 'plaid' THEN 0 WHEN 'teller' THEN 1 ELSE 2 END
              LIMIT 1)
          ) AS institution_name,
          u.is_demo
           FROM accounts a
           LEFT JOIN plaid_items i ON i.id = a.item_id
           JOIN users u ON u.id = a.user_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY a.type, a.name COLLATE NOCASE`,
        ...params
      );
    },

    async get(userId: string, id: string): Promise<AccountRow> {
      const scope = await accountReadScope(db, userId, "a");
      const row = await db.get<AccountRow>(
        `SELECT a.*,
          COALESCE(
            i.institution_name,
            (SELECT pc.institution_name
               FROM account_provider_refs apr
               JOIN provider_connections pc ON pc.id = apr.connection_id
              WHERE apr.account_id = a.id
              ORDER BY CASE apr.provider WHEN 'plaid' THEN 0 WHEN 'teller' THEN 1 ELSE 2 END
              LIMIT 1)
          ) AS institution_name,
          u.is_demo,
          owner.display_name AS owner_display_name
           FROM accounts a
           LEFT JOIN plaid_items i ON i.id = a.item_id
           JOIN users u ON u.id = a.user_id
           LEFT JOIN users owner ON owner.id = COALESCE(a.owner_user_id, a.user_id)
          WHERE a.id = ? AND ${scope.clause} AND a.hidden = 0 AND a.deleted_at IS NULL`,
        id,
        ...scope.params,
      );
      if (!row) throw apiErrors.notFound("Account");
      return { ...row, is_owner: (row.owner_user_id ?? row.user_id) === userId };
    },

    /** Manual account — no Plaid item, fully user-owned. */
    async createManual(
      userId: string,
      input: {
        name: string;
        type?: string;
        subtype?: string | null;
        mask?: string | null;
        currentBalanceCents?: number | null;
        availableBalanceCents?: number | null;
        currency?: string;
        visibility?: "shared" | "private";
      }
    ): Promise<AccountRow> {
      const name = input.name.trim();
      if (!name) throw apiErrors.badRequest("Account name cannot be empty.");
      if (name.length > 100) throw apiErrors.badRequest("Account name cannot exceed 100 characters.");
      const type = input.type ?? "other";
      // SAFETY: widens only the includes() parameter type so an arbitrary user string
      // can be membership-checked against the literal tuple; tuple contents unchanged.
      if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
        throw apiErrors.badRequest(`Account type must be one of: ${ACCOUNT_TYPES.join(", ")}.`);
      }
      if (input.currentBalanceCents !== undefined && input.currentBalanceCents !== null) {
        if (!Number.isInteger(input.currentBalanceCents)) {
          throw apiErrors.badRequest("Current balance must be a whole number of cents.");
        }
        assertValidCents(input.currentBalanceCents, "Current balance");
      }
      if (input.availableBalanceCents !== undefined && input.availableBalanceCents !== null) {
        if (!Number.isInteger(input.availableBalanceCents)) {
          throw apiErrors.badRequest("Available balance must be a whole number of cents.");
        }
        assertValidCents(input.availableBalanceCents, "Available balance");
      }
      const id = randomUUID();
      const household = await getHouseholdContext(db, userId);
      await db.run(
        `INSERT INTO accounts
           (id, user_id, household_id, owner_user_id, visibility,
            item_id, plaid_account_id, name, official_name, type, subtype, mask,
            current_balance_cents, available_balance_cents, currency, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        household?.householdId ?? null,
        userId,
        input.visibility ?? "shared",
        name,
        type,
        input.subtype?.trim().slice(0, 50) || null,
        input.mask?.trim().slice(0, 4) || null,
        input.currentBalanceCents ?? null,
        input.availableBalanceCents ?? null,
        input.currency?.trim().toUpperCase().slice(0, 3) || "USD",
        now()
      );
      // Initial balance_history point so manual accounts appear in the
      // net-worth trend from day one (raw stored value — createManual keeps
      // the user's sign as-is, unlike Plaid sync which flips credit/loan).
      if (input.currentBalanceCents != null) {
        await db.run(
          `INSERT INTO balance_history (id, account_id, date, balance_cents) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents`,
          randomUUID(),
          id,
          now().slice(0, 10),
          input.currentBalanceCents
        );
      }
      return this.get(userId, id);
    },

    async rename(userId: string, id: string, name: string): Promise<AccountRow> {
      await assertAccountManageable(db, userId, id);
      const clean = name.trim();
      if (!clean) throw apiErrors.badRequest("Account name cannot be empty.");
      if (clean.length > 100) throw apiErrors.badRequest("Account name cannot exceed 100 characters.");
      await db.run("UPDATE accounts SET name = ?, name_override = ? WHERE id = ?", clean, clean, id);
      return this.get(userId, id);
    },

    /** Remove one account (soft delete so it can be restored). For Plaid
     * accounts this disconnects the account locally; the institution remains
     * linked so a later sync will continue importing the other accounts. */
    async remove(userId: string, id: string): Promise<void> {
      await assertAccountManageable(db, userId, id);
      const row = await db.get<{ id: string; item_id: string | null }>(
        "SELECT id, item_id FROM accounts WHERE id = ? AND deleted_at IS NULL",
        id,
      );
      if (!row) throw apiErrors.notFound("Account");
      await db.transaction(async () => {
        if (row.item_id) {
          // Keep the row (hidden) so sync doesn't recreate it, and mark it
          // deleted so it shows in "Recently removed" for restore.
          await db.run(
            "UPDATE accounts SET hidden = 1, deleted_at = ? WHERE id = ?",
            now(),
            id
          );
        } else {
          await db.run("UPDATE accounts SET deleted_at = ? WHERE id = ?", now(), id);
        }
      });
    },

    /** Restore a soft-deleted account (and any Plaid account it belonged to). */
    async restore(userId: string, id: string): Promise<AccountRow> {
      await assertAccountManageable(db, userId, id, true);
      const row = await db.get<{ id: string; deleted_at: string | null }>(
        "SELECT id, deleted_at FROM accounts WHERE id = ? AND deleted_at IS NOT NULL",
        id,
      );
      if (!row) throw apiErrors.notFound("Account");
      await db.run("UPDATE accounts SET deleted_at = NULL, hidden = 0 WHERE id = ?", id);
      return this.get(userId, id);
    },

    /** Persist user-defined display order (array of account ids, first = top). */
    async reorder(userId: string, orderedIds: string[]): Promise<void> {
      const mine = await db.all<{ id: string }>(
        "SELECT id FROM accounts WHERE COALESCE(owner_user_id, user_id) = ? AND deleted_at IS NULL",
        userId
      );
      const mineSet = new Set(mine.map((r) => r.id));
      const seen = new Set<string>();
      const valid = orderedIds.filter((id) => {
        if (!mineSet.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (valid.length === 0) throw apiErrors.badRequest("No valid account ids to reorder.");
      await db.transaction(async () => {
        for (const [i, accountId] of valid.entries()) {
          await db.run("UPDATE accounts SET sort_order = ? WHERE id = ? AND COALESCE(owner_user_id, user_id) = ?", i, accountId, userId);
        }
      });
    },

    /** Free-text note describing the account (shown on the card). */
    async setDescription(userId: string, id: string, description: string | null): Promise<AccountRow> {
      await assertAccountManageable(db, userId, id);
      const clean = description?.trim().slice(0, 300) || null;
      await db.run("UPDATE accounts SET description = ? WHERE id = ?", clean, id);
      return this.get(userId, id);
    },

    /** User override for Plaid's inferred account type. */
    async setType(userId: string, id: string, type: string): Promise<AccountRow> {
      await assertAccountManageable(db, userId, id);
      // SAFETY: widens only the includes() parameter type so an arbitrary user string
      // can be membership-checked against the literal tuple; tuple contents unchanged.
      if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
        throw apiErrors.badRequest(`Account type must be one of: ${ACCOUNT_TYPES.join(", ")}.`);
      }
      await db.run("UPDATE accounts SET type = ?, type_override = 1 WHERE id = ?", type, id);
      return this.get(userId, id);
    },

    /** Shared accounts are visible to all household members; private accounts only to their owner. */
    async setVisibility(userId: string, id: string, visibility: "shared" | "private"): Promise<AccountRow> {
      await assertAccountManageable(db, userId, id);
      await db.transaction(async () => {
        await db.run("UPDATE accounts SET visibility = ? WHERE id = ?", visibility, id);
        if (visibility === "private") {
          // Tightening account privacy must also tighten any planning object
          // linked to it; otherwise an amount/name could leak through Plan.
          await db.run("UPDATE bills SET visibility = 'private' WHERE account_id = ?", id);
          await db.run("UPDATE goals SET visibility = 'private' WHERE account_id = ?", id);
          await db.run("UPDATE debts SET visibility = 'private' WHERE account_id = ?", id);
        }
      });
      return this.get(userId, id);
    },

    /** Include/exclude an account from the day-to-day net worth (P24). */
    async setNetWorthInclusion(userId: string, id: string, include: boolean): Promise<AccountRow> {
      await assertAccountManageable(db, userId, id);
      await db.run("UPDATE accounts SET include_in_net_worth = ? WHERE id = ?", include ? 1 : 0, id);
      return this.get(userId, id);
    },
  };
}

export type AccountsService = ReturnType<typeof createAccountsService>;