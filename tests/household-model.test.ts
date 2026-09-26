import { describe, expect, it } from "vitest";
import { createAuthService } from "@/server/auth/service";
import { createAccountsService } from "@/server/domain/accounts";
import { createBudgetsService } from "@/server/domain/budgets";
import { createHouseholdService } from "@/server/domain/households";
import { createTransactionsService } from "@/server/domain/transactions";
import { createTestDb, seedUser } from "./helpers";

async function makeHouseholdPair() {
  const db = createTestDb();
  const owner = await seedUser(db, "owner");
  const member = await seedUser(db, "member");
  const households = createHouseholdService(db);
  const householdId = await households.createForUser(owner.id);
  const invite = await households.createInvitation(owner.id, "member@example.com");
  await households.claimInvitation(invite.token, member.id);
  return { db, owner, member, households, householdId };
}

describe("M3 household membership", () => {
  it("creates invitation-only members with separate identities", async () => {
    const db = createTestDb();
    const auth = createAuthService(db);

    const first = await auth.register({
      username: "alice",
      display_name: "Alice",
      password: "alice-strong-pass",
      requireInvitation: true,
    });    const firstHousehold = await createHouseholdService(db).get(first.user.id);
    expect(firstHousehold.role).toBe("owner");
    expect(firstHousehold.members).toHaveLength(1);

    await expect(
      auth.register({
        username: "bob",
        display_name: "Bob",
        password: "bob-strong-pass",
        requireInvitation: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const invite = await createHouseholdService(db).createInvitation(
      first.user.id,
      "bob@example.com",
    );
    const second = await auth.register({
      username: "bob",
      display_name: "Bob",
      password: "bob-strong-pass",
      inviteToken: invite.token,
      requireInvitation: true,
    });

    const household = await createHouseholdService(db).get(second.user.id);
    expect(household.id).toBe(firstHousehold.id);
    expect(household.role).toBe("member");
    expect(household.members.map((m) => m.displayName).sort()).toEqual(["Alice", "Bob"]);
  });

  it("makes invitations single-use and owner-only", async () => {    const { db, owner, member, households } = await makeHouseholdPair();

    await expect(
      households.createInvitation(member.id, "third@example.com"),
    ).rejects.toMatchObject({ code: "forbidden" });

    const invite = await households.createInvitation(owner.id);
    const third = await seedUser(db, "third");
    await households.claimInvitation(invite.token, third.id);
    await expect(households.claimInvitation(invite.token, member.id))
      .rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("M3 account privacy", () => {
  it("shares household accounts but never exposes another member's private account", async () => {
    const { db, owner, member } = await makeHouseholdPair();
    const accounts = createAccountsService(db);

    const ownerShared = await accounts.createManual(owner.id, {
      name: "Joint Checking",
      type: "depository",
      currentBalanceCents: 100_000,
      visibility: "shared",
    });
    await accounts.createManual(owner.id, {
      name: "Owner Private",
      type: "depository",
      currentBalanceCents: 20_000,
      visibility: "private",
    });    const memberShared = await accounts.createManual(member.id, {
      name: "Household Savings",
      type: "depository",
      currentBalanceCents: 50_000,
      visibility: "shared",
    });
    await accounts.createManual(member.id, {
      name: "Member Private",
      type: "depository",
      currentBalanceCents: 30_000,
      visibility: "private",
    });

    expect((await accounts.list(owner.id)).map((a) => a.name).sort()).toEqual(
      ["Household Savings", "Joint Checking", "Owner Private"].sort(),
    );
    expect((await accounts.list(member.id)).map((a) => a.name).sort()).toEqual(
      ["Household Savings", "Joint Checking", "Member Private"].sort(),
    );

    await expect(accounts.rename(member.id, ownerShared.id, "Nope"))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(accounts.rename(owner.id, memberShared.id, "Nope"))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("moves a removed member and their owned data into a new household", async () => {
    const { db, owner, member, households, householdId } = await makeHouseholdPair();
    const accounts = createAccountsService(db);
    await accounts.createManual(member.id, {
      name: "Member Shared",
      type: "depository",
      visibility: "shared",
    });
    await accounts.createManual(member.id, {
      name: "Member Private",
      type: "depository",
      visibility: "private",
    });

    await households.removeMember(owner.id, member.id);

    const memberHousehold = await households.get(member.id);
    expect(memberHousehold.id).not.toBe(householdId);
    expect(memberHousehold.role).toBe("owner");
    expect(memberHousehold.members).toHaveLength(1);
    expect((await accounts.list(owner.id)).map((a) => a.name)).not.toContain("Member Shared");
    expect((await accounts.list(member.id)).map((a) => a.name).sort()).toEqual(
      ["Member Private", "Member Shared"].sort(),
    );
  });

  it("applies account privacy to transactions, not just the account screen", async () => {
    const { db, owner, member } = await makeHouseholdPair();
    const accounts = createAccountsService(db);
    const txns = createTransactionsService(db);

    const shared = await accounts.createManual(owner.id, {      name: "Shared Card", type: "credit", visibility: "shared",
    });
    const privateAccount = await accounts.createManual(owner.id, {
      name: "Private Card", type: "credit", visibility: "private",
    });

    await txns.createManual(owner.id, {
      accountId: shared.id,
      amountCents: -2500,
      date: "2026-09-01",
      name: "Shared purchase",
    });
    await txns.createManual(owner.id, {
      accountId: privateAccount.id,
      amountCents: -9900,
      date: "2026-09-02",
      name: "Private purchase",
    });

    const memberRows = await txns.list(member.id, { limit: 100, offset: 0 });
    expect(memberRows.rows.map((t) => t.name)).toEqual(["Shared purchase"]);
  });
});

describe("M3 household planning visibility", () => {
  it("shows shared budgets to household members while private budgets stay private", async () => {
    const { db, owner, member } = await makeHouseholdPair();
    const budgets = createBudgetsService(db);

    await budgets.create(owner.id, {
      name: "Groceries",
      amountCents: 80_000,      visibility: "shared",
    });
    await budgets.create(owner.id, {
      name: "Owner Fun Money",
      amountCents: 20_000,
      visibility: "private",
    });
    await budgets.create(member.id, {
      name: "Member Personal",
      amountCents: 15_000,
      visibility: "private",
    });

    const ownerView = await budgets.list(owner.id);
    const memberView = await budgets.list(member.id);
    expect(ownerView.map((b) => b.name).sort()).toEqual(
      ["Groceries", "Owner Fun Money"].sort(),
    );
    expect(memberView.map((b) => b.name).sort()).toEqual(
      ["Groceries", "Member Personal"].sort(),
    );
  });
});