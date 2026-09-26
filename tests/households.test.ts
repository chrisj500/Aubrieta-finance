import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb, seedUser } from "./helpers";
import { createAuthService } from "@/server/auth/service";
import { createHouseholdService } from "@/server/domain/households";
import { createAccountsService } from "@/server/domain/accounts";
import { createTransactionsService } from "@/server/domain/transactions";
import { createBudgetsService } from "@/server/domain/budgets";
import { createPlanningService } from "@/server/domain/planning";
import { createReportsService } from "@/server/domain/reports";

async function makeHousehold(db: ReturnType<typeof createTestDb>) {
  const owner = await seedUser(db, "house-owner");
  const member = await seedUser(db, "house-member");
  const households = createHouseholdService(db);
  const householdId = await households.createForUser(owner.id, "Test Household");
  const invite = await households.createInvitation(owner.id, "member@example.com");
  await households.claimInvitation(invite.token, member.id);
  return { owner, member, householdId, households };
}

async function category(
  db: ReturnType<typeof createTestDb>,
  userId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await db.run(
    "INSERT INTO categories (id, user_id, name, is_system, created_at) VALUES (?, ?, ?, 0, ?)",
    id,
    userId,
    name,
    new Date().toISOString(),
  );
  return id;
}

describe("M3 household model", () => {
  it("makes public registration invitation-only after the first real user", async () => {
    const db = createTestDb();
    const auth = createAuthService(db);
    const households = createHouseholdService(db);

    const first = await auth.register({
      username: "first-user",
      display_name: "First User",
      password: "first-user-strong-pass",
      requireInvitation: true,
    });

    await expect(
      auth.register({
        username: "uninvited-user",
        display_name: "Uninvited",
        password: "uninvited-user-strong-pass",
        requireInvitation: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const invite = await households.createInvitation(first.user.id, "second@example.com");
    const second = await auth.register({
      username: "second-user",
      display_name: "Second User",
      password: "second-user-strong-pass",
      inviteToken: invite.token,
      requireInvitation: true,
    });

    const firstMembership = await db.get<{ household_id: string }>(
      "SELECT household_id FROM household_members WHERE user_id = ?",
      first.user.id,
    );
    const secondMembership = await db.get<{ household_id: string }>(
      "SELECT household_id FROM household_members WHERE user_id = ?",
      second.user.id,
    );
    expect(secondMembership?.household_id).toBe(firstMembership?.household_id);

    await expect(
      auth.register({
        username: "replay-user",
        display_name: "Replay",
        password: "replay-user-strong-pass",
        inviteToken: invite.token,
        requireInvitation: true,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await db.get("SELECT id FROM users WHERE username = 'replay-user'")).toBeUndefined();
  });

  it("exposes shared accounts and transactions but never another member's private data", async () => {
    const db = createTestDb();
    const { owner, member } = await makeHousehold(db);
    const accounts = createAccountsService(db);
    const transactions = createTransactionsService(db);

    const shared = await accounts.createManual(owner.id, {
      name: "Joint Checking",
      type: "depository",
      currentBalanceCents: 100_00,
      visibility: "shared",
    });
    const privateAccount = await accounts.createManual(owner.id, {
      name: "Owner Private Card",
      type: "credit",
      currentBalanceCents: -200_00,
      visibility: "private",
    });

    await transactions.createManual(owner.id, {
      accountId: shared.id,
      amountCents: -1_000,
      date: "2026-09-01",
      name: "Shared purchase",
    });
    await transactions.createManual(owner.id, {
      accountId: privateAccount.id,
      amountCents: -2_000,
      date: "2026-09-02",
      name: "Private purchase",
    });

    const visibleAccounts = await accounts.list(member.id);
    expect(visibleAccounts.map((a) => a.id)).toEqual([shared.id]);
    expect(visibleAccounts[0]?.is_owner).toBe(false);

    const visibleTransactions = await transactions.list(member.id, { limit: 50, offset: 0 });
    expect(visibleTransactions.rows.map((t) => t.name)).toEqual(["Shared purchase"]);
    await expect(accounts.get(member.id, privateAccount.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(accounts.rename(member.id, shared.id, "Hijacked")).rejects.toMatchObject({ code: "not_found" });

    await accounts.setVisibility(owner.id, shared.id, "private");
    expect(await accounts.list(member.id)).toHaveLength(0);
  });
  it("keeps household rollups scoped to shared accounts plus the viewer's own private accounts", async () => {
    const db = createTestDb();
    const { owner, member } = await makeHousehold(db);
    const accounts = createAccountsService(db);

    await accounts.createManual(owner.id, {
      name: "Owner Shared",
      type: "depository",
      currentBalanceCents: 10_000,
      visibility: "shared",
    });
    await accounts.createManual(owner.id, {
      name: "Owner Private",
      type: "depository",
      currentBalanceCents: 20_000,
      visibility: "private",
    });
    await accounts.createManual(member.id, {
      name: "Member Shared",
      type: "depository",
      currentBalanceCents: 40_000,
      visibility: "shared",
    });
    await accounts.createManual(member.id, {
      name: "Member Private",
      type: "depository",
      currentBalanceCents: 30_000,
      visibility: "private",
    });

    const reports = createReportsService(db);
    expect((await reports.netWorth(owner.id)).netCents).toBe(70_000);
    expect((await reports.netWorth(member.id)).netCents).toBe(80_000);
  });

  it("does not leak private-account spending through a shared household budget", async () => {
    const db = createTestDb();
    const { owner, member } = await makeHousehold(db);
    const accounts = createAccountsService(db);
    const transactions = createTransactionsService(db);
    const budgets = createBudgetsService(db);
    const ownerGroceries = await category(db, owner.id, "Groceries");
    const memberGroceries = await category(db, member.id, "Groceries");

    const ownerShared = await accounts.createManual(owner.id, {
      name: "Owner Joint",
      type: "depository",
      visibility: "shared",
    });
    const memberShared = await accounts.createManual(member.id, {
      name: "Member Joint",
      type: "depository",
      visibility: "shared",
    });
    const memberPrivate = await accounts.createManual(member.id, {
      name: "Member Private",
      type: "depository",
      visibility: "private",
    });

    await transactions.createManual(owner.id, {
      accountId: ownerShared.id,
      amountCents: -1_000,
      date: "2026-09-10",
      name: "Shared groceries A",
      userCategoryId: ownerGroceries,
    });
    await transactions.createManual(member.id, {
      accountId: memberShared.id,
      amountCents: -2_000,
      date: "2026-09-11",
      name: "Shared groceries B",
      userCategoryId: memberGroceries,
    });
    await transactions.createManual(member.id, {
      accountId: memberPrivate.id,
      amountCents: -9_000,
      date: "2026-09-12",
      name: "Private groceries",
      userCategoryId: memberGroceries,
    });

    const sharedBudget = await budgets.create(owner.id, {
      name: "Household groceries",
      amountCents: 50_000,
      period: "monthly",
      categoryIds: [ownerGroceries],
      visibility: "shared",
    });
    const memberView = await budgets.list(member.id, "2026-09-15", { kind: "month" });
    const budget = memberView.find((b) => b.id === sharedBudget.id);
    expect(budget?.spentCents).toBe(3_000);
  });
  it("keeps private planning objects private and makes shared planning owner-managed", async () => {
    const db = createTestDb();
    const { owner, member } = await makeHousehold(db);
    const accounts = createAccountsService(db);
    const planning = createPlanningService(db);

    const shared = await accounts.createManual(owner.id, {
      name: "Joint Checking",
      type: "depository",
      visibility: "shared",
    });
    const privateAccount = await accounts.createManual(owner.id, {
      name: "Private Checking",
      type: "depository",
      visibility: "private",
    });

    const sharedBill = await planning.createBill(owner.id, {
      name: "Power",
      amountCents: 12_000,
      frequency: "monthly",
      dueDay: 15,
      accountId: shared.id,
      visibility: "shared",
    });
    const privateBill = await planning.createBill(owner.id, {
      name: "Private club",
      amountCents: 5_000,
      frequency: "monthly",
      dueDay: 20,
      accountId: privateAccount.id,
    });

    const memberBills = await planning.listBills(member.id);
    expect(memberBills.map((b) => b.id)).toContain(sharedBill.id);
    expect(memberBills.map((b) => b.id)).not.toContain(privateBill.id);

    await expect(
      planning.updateBill(member.id, sharedBill.id, { name: "Changed by member" }),
    ).rejects.toMatchObject({ code: "not_found" });

    await accounts.setVisibility(owner.id, shared.id, "private");
    expect((await planning.listBills(member.id)).map((b) => b.id)).not.toContain(sharedBill.id);
    const cascaded = await db.get<{ visibility: string }>(
      "SELECT visibility FROM bills WHERE id = ?",
      sharedBill.id,
    );
    expect(cascaded?.visibility).toBe("private");
  });

  it("moves a removed member and their owned finance objects into a new household", async () => {
    const db = createTestDb();
    const { owner, member, householdId, households } = await makeHousehold(db);
    const accounts = createAccountsService(db);
    const owned = await accounts.createManual(member.id, {
      name: "Member account",
      type: "depository",
      visibility: "shared",
    });

    await households.removeMember(owner.id, member.id);

    const oldMembership = await db.get(
      "SELECT user_id FROM household_members WHERE household_id = ? AND user_id = ?",
      householdId,
      member.id,
    );
    expect(oldMembership).toBeUndefined();
    const newMembership = await db.get<{ household_id: string; role: string }>(
      "SELECT household_id, role FROM household_members WHERE user_id = ?",
      member.id,
    );
    expect(newMembership?.household_id).not.toBe(householdId);
    expect(newMembership?.role).toBe("owner");

    const moved = await db.get<{ household_id: string }>(
      "SELECT household_id FROM accounts WHERE id = ?",
      owned.id,
    );
    expect(moved?.household_id).toBe(newMembership?.household_id);
    expect((await accounts.list(owner.id)).map((a) => a.id)).not.toContain(owned.id);
  });
});