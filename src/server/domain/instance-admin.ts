import { randomBytes } from "node:crypto";
import { randomUUID } from "@/lib/uuid";
import { hashSecret } from "@/lib/crypto";
import { apiErrors } from "@/lib/api-error";
import type { Db } from "@/server/db/types";
import { requireInstanceAdmin } from "@/server/authz/instance-admin";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function cleanEmail(value?: string | null): string | null {
  const email = value?.trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw apiErrors.badRequest("That email address is not valid.");
  }
  return email;
}

export interface InstanceHouseholdSummary {
  id: string;
  name: string;
  memberCount: number;
  ownerName: string | null;
  ownerUsername: string | null;
  createdAt: string;
}

async function createOwnerInvitation(
  db: Db,
  adminUserId: string,
  householdId: string,
  inviteeEmail?: string | null,
): Promise<{ id: string; token: string; expiresAt: string }> {
  const household = await db.get<{ id: string }>("SELECT id FROM households WHERE id = ?", householdId);
  if (!household) throw apiErrors.notFound("Household");

  const owner = await db.get<{ user_id: string }>(
    "SELECT user_id FROM household_members WHERE household_id = ? AND role = 'owner'",
    householdId,
  );
  if (owner) {
    throw apiErrors.conflict("This household already has an owner.");
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const id = randomUUID();
  await db.run(
    `INSERT INTO household_invitations
       (id, household_id, token_hash, invitee_email, role, invited_by_user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)`,
    id,
    householdId,
    hashSecret(token),
    cleanEmail(inviteeEmail),
    adminUserId,
    expiresAt,
    now(),
  );
  return { id, token, expiresAt };
}

export function createInstanceAdminService(db: Db) {
  return {
    async listHouseholds(adminUserId: string): Promise<InstanceHouseholdSummary[]> {
      await requireInstanceAdmin(db, adminUserId);
      const rows = await db.all<{
        id: string;
        name: string;
        created_at: string;
        member_count: number;
        owner_name: string | null;
        owner_username: string | null;
      }>(
        `SELECT h.id, h.name, h.created_at,
                COUNT(hm.user_id) AS member_count,
                MAX(CASE WHEN hm.role = 'owner' THEN u.display_name END) AS owner_name,
                MAX(CASE WHEN hm.role = 'owner' THEN u.username END) AS owner_username
           FROM households h
           LEFT JOIN household_members hm ON hm.household_id = h.id
           LEFT JOIN users u ON u.id = hm.user_id
          GROUP BY h.id, h.name, h.created_at
          ORDER BY lower(h.name), h.created_at`,
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        memberCount: Number(row.member_count),
        ownerName: row.owner_name,
        ownerUsername: row.owner_username,
        createdAt: row.created_at,
      }));
    },

    async provisionHousehold(
      adminUserId: string,
      input: { name: string; ownerEmail?: string | null },
    ): Promise<{
      household: InstanceHouseholdSummary;
      invitation: { id: string; token: string; expiresAt: string };
    }> {
      await requireInstanceAdmin(db, adminUserId);
      const name = input.name.trim().slice(0, 80);
      if (!name) throw apiErrors.badRequest("Household name cannot be empty.");
      const householdId = randomUUID();
      const ts = now();

      const invitation = await db.transaction(async () => {
        await db.run(
          `INSERT INTO households (id, name, created_by_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          householdId,
          name,
          adminUserId,
          ts,
          ts,
        );
        return createOwnerInvitation(db, adminUserId, householdId, input.ownerEmail);
      });

      return {
        household: {
          id: householdId,
          name,
          memberCount: 0,
          ownerName: null,
          ownerUsername: null,
          createdAt: ts,
        },
        invitation,
      };
    },

    async createOwnerInvitation(
      adminUserId: string,
      householdId: string,
      ownerEmail?: string | null,
    ): Promise<{ id: string; token: string; expiresAt: string }> {
      await requireInstanceAdmin(db, adminUserId);
      return createOwnerInvitation(db, adminUserId, householdId, ownerEmail);
    },
  };
}

export type InstanceAdminService = ReturnType<typeof createInstanceAdminService>;
