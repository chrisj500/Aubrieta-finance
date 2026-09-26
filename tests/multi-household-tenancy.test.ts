import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { createAuthService } from "@/server/auth/service";
import { createHouseholdService } from "@/server/domain/households";
import { createInstanceAdminService } from "@/server/domain/instance-admin";
import { isInstanceAdmin } from "@/server/authz/instance-admin";
import { createAccountsService } from "@/server/domain/accounts";
import { createTransactionsService } from "@/server/domain/transactions";
import { createBudgetsService } from "@/server/domain/budgets";
import { createPlanningService } from "@/server/domain/planning";
import { createReportsService } from "@/server/domain/reports";
import { ensureProviderConnection } from "@/server/providers/connections";
import { syncProviderConnection } from "@/server/providers/sync";
import type { FinancialProvider } from "@/server/providers/types";

async function twoIndependentHouseholds() {
  const db = createTestDb();
  const auth = createAuthService(db);
  const first = await auth.register({
    username: "instance-owner",
    display_name: "Instance Owner",
    password: "instance-owner-pass",
    requireInvitation: true,
  });
  const admin = createInstanceAdminService(db);
  const provisioned = await admin.provisionHousehold(first.user.id, {
    name: "Second Household",
    ownerEmail: "second@example.com",
  });
  const second = await auth.register({
    username: "second-owner",
    display_name: "Second Owner",
    password: "second-owner-pass",
    inviteToken: provisioned.invitation.token,
    requireInvitation: true,
  });
  return { db, auth, admin, first, second, provisioned };
}

describe("M3.5 instance administration", () => {
  it("makes the first real user the instance admin without granting cross-household membership", async () => {
    const { db, admin, first, second, provisioned } = await twoIndependentHouseholds();

    expect(await isInstanceAdmin(db, first.user.id)).toBe(true);
    expect(await isInstanceAdmin(db, second.user.id)).toBe(false);

    const secondMembership = await db.get<{ household_id: string; role: string }>(
      "SELECT household_id, role FROM household_members WHERE user_id = ?",
      second.user.id,
    );
    expect(secondMembership).toEqual({ household_id: provisioned.household.id, role: "owner" });

    const adminMembershipInSecond = await db.get(
      "SELECT user_id FROM household_members WHERE household_id = ? AND user_id = ?",
      provisioned.household.id,
      first.user.id,
    );
    expect(adminMembershipInSecond).toBeUndefined();

    const households = await admin.listHouseholds(first.user.id);
    expect(households).toHaveLength(2);
    expect(households.find((h) => h.id === provisioned.household.id)).toMatchObject({
      name: "Second Household",
      memberCount: 1,
      ownerName: "Second Owner",
      ownerUsername: "second-owner",
    });

    await expect(admin.listHouseholds(second.user.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      admin.provisionHousehold(second.user.id, { name: "Not allowed" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      admin.createOwnerInvitation(first.user.id, provisioned.household.id),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps the one-user/one-household invariant for provisioned owners", async () => {
    const { db, first, second } = await twoIndependentHouseholds();
    const households = createHouseholdService(db);
    const firstHousehold = await households.get(first.user.id);
    const memberInvite = await households.createInvitation(first.user.id, "second@example.com");

    await expect(households.claimInvitation(memberInvite.token, second.user.id))
      .rejects.toMatchObject({ code: "conflict" });
    expect((await households.get(second.user.id)).id).not.toBe(firstHousehold.id);
  });
});

describe("M3.5 tenant isolation", () => {
  it("does not let instance administration imply finance access across households", async () => {
    const { db, first, second } = await twoIndependentHouseholds();
    const accounts = createAccountsService(db);
    const transactions = createTransactionsService(db);
    const budgets = createBudgetsService(db);
    const planning = createPlanningService(db);
    const reports = createReportsService(db);

    const firstAccount = await accounts.createManual(first.user.id, {
      name: "First Household Checking",
      type: "depository",
      currentBalanceCents: 100_000,
      visibility: "shared",
    });
    const secondAccount = await accounts.createManual(second.user.id, {
      name: "Second Household Checking",
      type: "depository",
      currentBalanceCents: 900_000,
      visibility: "shared",
    });
    await transactions.createManual(first.user.id, {
      accountId: firstAccount.id,
      amountCents: -1_000,
      date: "2026-09-01",
      name: "First household purchase",
    });
    await transactions.createManual(second.user.id, {
      accountId: secondAccount.id,
      amountCents: -9_000,
      date: "2026-09-02",
      name: "Second household purchase",
    });
    await budgets.create(first.user.id, { name: "First budget", amountCents: 25_000, visibility: "shared" });
    await budgets.create(second.user.id, { name: "Second budget", amountCents: 75_000, visibility: "shared" });
    await planning.createBill(first.user.id, {
      name: "First utility", amountCents: 5_000, frequency: "monthly", dueDay: 12,
      accountId: firstAccount.id, visibility: "shared",
    });
    await planning.createBill(second.user.id, {
      name: "Second utility", amountCents: 8_000, frequency: "monthly", dueDay: 18,
      accountId: secondAccount.id, visibility: "shared",
    });

    expect((await accounts.list(first.user.id)).map((a) => a.name)).toEqual(["First Household Checking"]);
    expect((await accounts.list(second.user.id)).map((a) => a.name)).toEqual(["Second Household Checking"]);
    expect((await accounts.listForAgent(first.user.id, ["read:banking"], null)).map((a) => a.name))
      .toEqual(["First Household Checking"]);
    expect((await accounts.listForAgent(second.user.id, ["read:banking"], null)).map((a) => a.name))
      .toEqual(["Second Household Checking"]);
    expect((await transactions.list(first.user.id, { limit: 50, offset: 0 })).rows.map((t) => t.name))
      .toEqual(["First household purchase"]);
    expect((await transactions.list(second.user.id, { limit: 50, offset: 0 })).rows.map((t) => t.name))
      .toEqual(["Second household purchase"]);
    expect((await budgets.list(first.user.id)).map((b) => b.name)).toEqual(["First budget"]);
    expect((await budgets.list(second.user.id)).map((b) => b.name)).toEqual(["Second budget"]);
    expect((await planning.listBills(first.user.id)).map((b) => b.name)).toEqual(["First utility"]);
    expect((await planning.listBills(second.user.id)).map((b) => b.name)).toEqual(["Second utility"]);
    expect((await reports.netWorth(first.user.id)).netCents).toBe(100_000);
    expect((await reports.netWorth(second.user.id)).netCents).toBe(900_000);

    await expect(accounts.get(first.user.id, secondAccount.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(accounts.get(second.user.id, firstAccount.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("stamps provider connections with their household tenant and rejects stale cross-tenant sync", async () => {
    const { db, first, second, provisioned } = await twoIndependentHouseholds();
    const provider = {
      descriptor: { kind: "teller", name: "Test", capabilities: ["accounts"] },
    } as unknown as FinancialProvider;

    const connectionId = await ensureProviderConnection(db, {
      userId: second.user.id,
      provider,
      externalConnectionId: "second-connection",
      institutionExternalId: "test-bank",
      institutionName: "Test Bank",
    });
    const row = await db.get<{ household_id: string | null }>(
      "SELECT household_id FROM provider_connections WHERE id = ?",
      connectionId,
    );
    expect(row?.household_id).toBe(provisioned.household.id);

    const firstHousehold = await createHouseholdService(db).get(first.user.id);
    await db.run(
      "UPDATE provider_connections SET household_id = ? WHERE id = ?",
      firstHousehold.id, connectionId,
    );
    await expect(syncProviderConnection(db, {
      userId: second.user.id,
      connectionId,
      provider,
      connectionSecret: {},
    })).rejects.toThrow("Provider connection tenant mismatch.");
  });
});
