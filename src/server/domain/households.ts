import { randomBytes } from "node:crypto";
import { randomUUID } from "@/lib/uuid";
import { hashSecret } from "@/lib/crypto";
import { apiErrors } from "@/lib/api-error";
import { getDb, type Db } from "@/server/db/registry";
import { requireHouseholdContext, type HouseholdRole } from "@/server/authz/household-access";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

export interface HouseholdMember {
  userId: string;
  displayName: string;
  username: string | null;
  email: string | null;
  role: HouseholdRole;
  joinedAt: string;
  isCurrentUser: boolean;
}

export interface HouseholdSummary {
  id: string;
  name: string;
  role: HouseholdRole;
  members: HouseholdMember[];
  invitations: Array<{
    id: string;
    inviteeEmail: string | null;
    expiresAt: string;
    createdAt: string;
  }>;
}
async function assertOwner(db: Db, userId: string): Promise<string> {
  const ctx = await requireHouseholdContext(db, userId);
  if (ctx.role !== "owner") {
    throw apiErrors.forbidden("Only the household owner can manage membership.");
  }
  return ctx.householdId;
}

export function createHouseholdService(db: Db = getDb()) {
  return {
    async createForUser(userId: string, requestedName?: string): Promise<string> {
      const existing = await db.get<{ household_id: string }>(
        "SELECT household_id FROM household_members WHERE user_id = ?",
        userId,
      );
      if (existing) return existing.household_id;

      const user = await db.get<{ display_name: string }>(
        "SELECT display_name FROM users WHERE id = ?",
        userId,
      );
      if (!user) throw apiErrors.notFound("User");

      const id = randomUUID();
      const name = requestedName?.trim().slice(0, 80) ||
        `${user.display_name.trim() || "My"}'s Household`;
      const ts = now();
      await db.run(
        "INSERT INTO households (id, name, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        id, name, userId, ts, ts,
      );
      await db.run(
        "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
        id, userId, ts,
      );
      return id;
    },
    async get(userId: string): Promise<HouseholdSummary> {
      const ctx = await requireHouseholdContext(db, userId);
      const household = await db.get<{ id: string; name: string }>(
        "SELECT id, name FROM households WHERE id = ?",
        ctx.householdId,
      );
      if (!household) throw apiErrors.notFound("Household");

      const rows = await db.all<{
        user_id: string;
        display_name: string;
        username: string | null;
        email: string | null;
        role: HouseholdRole;
        joined_at: string;
      }>(
        `SELECT hm.user_id, u.display_name, u.username, u.email, hm.role, hm.joined_at
           FROM household_members hm
           JOIN users u ON u.id = hm.user_id
          WHERE hm.household_id = ?
          ORDER BY CASE hm.role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name COLLATE NOCASE`,
        ctx.householdId,
      );

      const invitations = ctx.role === "owner"
        ? await db.all<{ id: string; invitee_email: string | null; expires_at: string; created_at: string }>(
            `SELECT id, invitee_email, expires_at, created_at
               FROM household_invitations
              WHERE household_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
              ORDER BY created_at DESC`,
            ctx.householdId, now(),
          )
        : [];

      return {
        id: household.id,
        name: household.name,
        role: ctx.role,
        members: rows.map((r) => ({
          userId: r.user_id,
          displayName: r.display_name,
          username: r.username,
          email: r.email,
          role: r.role,
          joinedAt: r.joined_at,
          isCurrentUser: r.user_id === userId,
        })),
        invitations: invitations.map((i) => ({
          id: i.id,
          inviteeEmail: i.invitee_email,
          expiresAt: i.expires_at,
          createdAt: i.created_at,
        })),
      };
    },
    async rename(userId: string, name: string): Promise<void> {
      const householdId = await assertOwner(db, userId);
      const clean = name.trim().slice(0, 80);
      if (!clean) throw apiErrors.badRequest("Household name cannot be empty.");
      await db.run(
        "UPDATE households SET name = ?, updated_at = ? WHERE id = ?",
        clean, now(), householdId,
      );
    },

    async createInvitation(
      userId: string,
      inviteeEmail?: string | null,
    ): Promise<{ id: string; token: string; expiresAt: string }> {
      const householdId = await assertOwner(db, userId);
      const email = inviteeEmail?.trim().toLowerCase() || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw apiErrors.badRequest("That email address is not valid.");
      }
      const token = randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      const id = randomUUID();
      await db.run(
        `INSERT INTO household_invitations
           (id, household_id, token_hash, invitee_email, role, invited_by_user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'member', ?, ?, ?)`,
        id, householdId, hashSecret(token), email, userId, expiresAt, now(),
      );
      return { id, token, expiresAt };
    },

    async revokeInvitation(userId: string, invitationId: string): Promise<void> {
      const householdId = await assertOwner(db, userId);
      const result = await db.run(
        `UPDATE household_invitations SET revoked_at = ?
          WHERE id = ? AND household_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        now(), invitationId, householdId,
      );
      if (!result.changes) throw apiErrors.notFound("Invitation");
    },
    async previewInvitation(token: string): Promise<{
      householdName: string;
      inviterName: string;
      inviteeEmail: string | null;
      expiresAt: string;
    }> {
      const row = await db.get<{
        household_name: string;
        inviter_name: string;
        invitee_email: string | null;
        expires_at: string;
      }>(
        `SELECT h.name AS household_name, u.display_name AS inviter_name,
                i.invitee_email, i.expires_at
           FROM household_invitations i
           JOIN households h ON h.id = i.household_id
           JOIN users u ON u.id = i.invited_by_user_id
          WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > ?`,
        hashSecret(token), now(),
      );
      if (!row) throw apiErrors.badRequest("This household invitation is invalid or has expired.");
      return {
        householdName: row.household_name,
        inviterName: row.inviter_name,
        inviteeEmail: row.invitee_email,
        expiresAt: row.expires_at,
      };
    },

    async claimInvitation(token: string, userId: string): Promise<string> {
      const invitation = await db.get<{ id: string; household_id: string }>(
        `SELECT id, household_id
           FROM household_invitations
          WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL
            AND expires_at > ?`,
        hashSecret(token), now(),
      );
      if (!invitation) {
        throw apiErrors.badRequest("This household invitation is invalid or has expired.");
      }
      const existing = await db.get<{ household_id: string }>(
        "SELECT household_id FROM household_members WHERE user_id = ?",
        userId,
      );
      if (existing && existing.household_id !== invitation.household_id) {
        throw apiErrors.conflict("This account already belongs to another household.");
      }
      if (!existing) {
        await db.run(
          "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
          invitation.household_id, userId, now(),
        );
      }
      const result = await db.run(
        `UPDATE household_invitations
            SET accepted_by_user_id = ?, accepted_at = ?
          WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        userId, now(), invitation.id,
      );
      if (!result.changes) throw apiErrors.conflict("That invitation has already been used.");
      return invitation.household_id;
    },
    async removeMember(userId: string, memberUserId: string): Promise<void> {
      const householdId = await assertOwner(db, userId);
      if (memberUserId === userId) {
        throw apiErrors.badRequest("The household owner cannot remove themselves.");
      }
      const member = await db.get<{ role: HouseholdRole; display_name: string }>(
        `SELECT hm.role, u.display_name
           FROM household_members hm JOIN users u ON u.id = hm.user_id
          WHERE hm.household_id = ? AND hm.user_id = ?`,
        householdId, memberUserId,
      );
      if (!member) throw apiErrors.notFound("Household member");
      if (member.role === "owner") throw apiErrors.badRequest("The household owner cannot be removed.");

      const newHouseholdId = randomUUID();
      const ts = now();
      await db.transaction(async () => {
        await db.run(
          "INSERT INTO households (id, name, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          newHouseholdId, `${member.display_name}'s Household`, memberUserId, ts, ts,
        );
        for (const table of ["accounts", "budgets", "bills", "goals", "debts"] as const) {
          await db.run(
            `UPDATE ${table} SET household_id = ? WHERE COALESCE(owner_user_id, user_id) = ?`,
            newHouseholdId, memberUserId,
          );
        }
        await db.run(
          "DELETE FROM household_members WHERE household_id = ? AND user_id = ?",
          householdId, memberUserId,
        );
        await db.run(
          "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
          newHouseholdId, memberUserId, ts,
        );
      });
    },
  };
}

export type HouseholdService = ReturnType<typeof createHouseholdService>;