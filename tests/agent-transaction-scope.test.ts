import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getSqliteDb } from "@/server/db/adapter";
import { createAgentTokenService } from "@/server/authz/tokens";
import { createAgentPrefsService } from "@/server/domain/agent-prefs";
import { createAccountsService } from "@/server/domain/accounts";
import { createTransactionsService } from "@/server/domain/transactions";
import { GET as listTransactions } from "@/app/api/transactions/route";
import { GET as listBudgets } from "@/app/api/budgets/route";
import { GET as getProjection } from "@/app/api/planning/projection/route";
import { createCategoriesService } from "@/server/domain/categories";
import { createBudgetsService } from "@/server/domain/budgets";
import { GET as getTransaction, PATCH as patchTransaction } from "@/app/api/transactions/[id]/route";
import { seedUser } from "./helpers";

function migrationFiles(): string[] {
  const dir = path.join(process.cwd(), "migrations");
  return fs.readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
}

beforeAll(() => {
  const db = getSqliteDb();
  for (const sql of migrationFiles()) db.exec(sql);
});

afterAll(() => getSqliteDb().close());

function bearerRequest(url: string, token: string, init: { method?: string; body?: BodyInit | null } = {}): NextRequest {
  return new NextRequest(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

async function seedTxn(userId: string, accountId: string, name: string) {
  return createTransactionsService(getSqliteDb()).createManual(userId, {
    accountId,
    amountCents: -1234,
    date: "2026-09-26",
    name,
  });
}

describe("agent transaction account-scope isolation", () => {
  it("banking-only REST tokens cannot list or fetch investment transactions", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, `txn-scope-${Date.now()}`);
    await createAgentPrefsService(db).update(user.id, { global: true });
    const accounts = createAccountsService(db);
    const checking = await accounts.createManual(user.id, { name: "Checking", type: "depository" });
    const brokerage = await accounts.createManual(user.id, { name: "Brokerage", type: "investment" });
    const checkingTxn = await seedTxn(user.id, checking.id, "Checking purchase");
    const investmentTxn = await seedTxn(user.id, brokerage.id, "Investment purchase");
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "banking-only",
      preset: "custom",
      scopes: ["read:banking"],
    });

    const listed = await listTransactions(bearerRequest("http://localhost/api/transactions", token));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((row) => row.id)).toContain(checkingTxn.id);
    expect(body.rows.map((row) => row.id)).not.toContain(investmentTxn.id);

    const hidden = await getTransaction(
      bearerRequest(`http://localhost/api/transactions/${investmentTxn.id}`, token),
      { params: Promise.resolve({ id: investmentTxn.id }) },
    );
    expect(hidden.status).toBe(404);
  });

  it("REST budget progress and projection honor the token account allowlist", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, `aggregate-allow-${Date.now()}`);
    await createAgentPrefsService(db).update(user.id, { global: true });
    const accounts = createAccountsService(db);
    const allowed = await accounts.createManual(user.id, { name: "Aggregate Allowed", type: "depository", currentBalanceCents: 100_000 });
    const blocked = await accounts.createManual(user.id, { name: "Aggregate Blocked", type: "depository", currentBalanceCents: 900_000 });
    const category = await createCategoriesService(db).create(user.id, { name: `Aggregate ${Date.now()}` });
    await createTransactionsService(db).createManual(user.id, { accountId: allowed.id, amountCents: -1_000, date: "2026-09-26", name: "Allowed spend", userCategoryId: category.id });
    await createTransactionsService(db).createManual(user.id, { accountId: blocked.id, amountCents: -9_000, date: "2026-09-26", name: "Blocked spend", userCategoryId: category.id });
    await createBudgetsService(db).create(user.id, { name: "Scoped budget", amountCents: 20_000, categoryIds: [category.id] });
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "aggregate-reader",
      preset: "custom",
      scopes: ["read:budgets", "read:planning"],
      accountIds: [allowed.id],
    });

    const budgetRes = await listBudgets(bearerRequest("http://localhost/api/budgets?referenceDate=2026-09-26", token));
    expect(budgetRes.status).toBe(200);
    const budgetBody = (await budgetRes.json()) as { budgets: Array<{ spentCents: number }> };
    expect(budgetBody.budgets).toHaveLength(1);
    expect(budgetBody.budgets[0]?.spentCents).toBe(1_000);

    const projectionRes = await getProjection(bearerRequest("http://localhost/api/planning/projection?months=1", token));
    expect(projectionRes.status).toBe(200);
    const projection = (await projectionRes.json()) as { baselineCents: number };
    expect(projection.baselineCents).toBe(100_000);
  });

  it("REST transaction edits honor the token account allowlist and target account", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, `txn-allow-${Date.now()}`);
    await createAgentPrefsService(db).update(user.id, { global: true });
    const accounts = createAccountsService(db);
    const allowed = await accounts.createManual(user.id, { name: "Allowed", type: "depository" });
    const blocked = await accounts.createManual(user.id, { name: "Blocked", type: "depository" });
    const allowedTxn = await seedTxn(user.id, allowed.id, "Allowed txn");
    const blockedTxn = await seedTxn(user.id, blocked.id, "Blocked txn");
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "allowlisted-editor",
      preset: "custom",
      scopes: ["read:banking", "transactions:edit"],
      accountIds: [allowed.id],
    });

    const denied = await patchTransaction(
      bearerRequest(`http://localhost/api/transactions/${blockedTxn.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ userNote: "must not write" }),
      }),
      { params: Promise.resolve({ id: blockedTxn.id }) },
    );
    expect(denied.status).toBe(404);
    expect((await createTransactionsService(db).get(user.id, blockedTxn.id)).user_note).toBeNull();

    const moved = await patchTransaction(
      bearerRequest(`http://localhost/api/transactions/${allowedTxn.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ accountId: blocked.id }),
      }),
      { params: Promise.resolve({ id: allowedTxn.id }) },
    );
    expect(moved.status).toBe(404);
    expect((await createTransactionsService(db).get(user.id, allowedTxn.id)).account_id).toBe(allowed.id);

    const allowedEdit = await patchTransaction(
      bearerRequest(`http://localhost/api/transactions/${allowedTxn.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ userNote: "allowed write" }),
      }),
      { params: Promise.resolve({ id: allowedTxn.id }) },
    );
    expect(allowedEdit.status).toBe(200);
    expect((await createTransactionsService(db).get(user.id, allowedTxn.id)).user_note).toBe("allowed write");
  });
});
