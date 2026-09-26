import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getSqliteDb } from "@/server/db/adapter";
import { createAgentTokenService } from "@/server/authz/tokens";
import { createAgentPrefsService } from "@/server/domain/agent-prefs";
import { createAccountsService } from "@/server/domain/accounts";
import { createTransactionsService } from "@/server/domain/transactions";
import { createCategoriesService } from "@/server/domain/categories";
import { createBudgetsService } from "@/server/domain/budgets";
import { authFromToken, createOpenFinanceMcpServer } from "@/server/mcp/server";
import { seedUser } from "./helpers";

/**
 * MCP transport must enforce the SAME access boundary as REST routes:
 * effective scopes = token scopes ∩ the user's current Settings caps
 * (agent-auth.effectiveScopes). Before this fix, authFromToken returned the
 * raw token scopes — so reducing the user's Settings caps did not apply to
 * MCP calls until the token itself was revoked. Verified over the real MCP
 * server + in-memory transport (practice-not-theory).
 */

function migrationFiles(): string[] {
  const dir = path.join(process.cwd(), "migrations");
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
}

beforeAll(() => {
  const db = getSqliteDb();
  for (const sql of migrationFiles()) db.exec(sql);
});

afterAll(() => {
  getSqliteDb().close();
});

async function connectMcp(rawToken: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createOpenFinanceMcpServer(() => authFromToken(rawToken));
  await server.connect(serverTransport);
  const client = new Client({ name: "caps-test", version: "1.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP transport enforces user Settings caps", () => {
  it("authFromToken intersects token scopes with the user's caps", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, "mcp-caps-1");
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "wide-token",
      preset: "custom",
      scopes: ["read:summary", "read:budgets"],
    });

    // User caps allow only the activity tab (read:banking) — budgets off.
    await createAgentPrefsService(db).update(user.id, { tabs: ["activity"], tabsWrite: [] });

    const auth = await authFromToken(token);
    expect(auth.scopes).not.toContain("read:budgets");
    expect(auth.scopes).not.toContain("read:summary");
  });

  it("a capped token gets insufficient_scope over MCP, then works after the user widens caps", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, "mcp-caps-2");
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "budget-token",
      preset: "custom",
      scopes: ["read:budgets"],
    });
    await createAgentPrefsService(db).update(user.id, { tabs: ["activity"], tabsWrite: [] });

    const client = await connectMcp(token);

    // Denied: the token has read:budgets but the user's caps don't.
    const denied = await client.callTool({ name: "get_budgets", arguments: {} });
    expect(denied.isError).toBe(true);
    const deniedText = (denied.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    expect(deniedText).toContain("insufficient_scope");

    // tools/list hides the tool too (visibility uses effective scopes).
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).not.toContain("get_budgets");

    // User enables the budgets tab in Settings → same token works immediately.
    await createAgentPrefsService(db).update(user.id, { tabs: ["activity", "budgets"] });
    const granted = await client.callTool({ name: "get_budgets", arguments: {} });
    expect(granted.isError).toBeFalsy();
    const grantedText = (granted.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    expect(grantedText).toContain("budgets");

    await client.close();
  });

  it("every dispatch-side tool is scope-gated (regression for list_uncategorized_transactions bypass)", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, "mcp-caps-uncat");
    // Narrow token: only read:budgets — NOT read:banking/read:investments.
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "budget-only-token",
      preset: "custom",
      scopes: ["read:budgets"],
    });
    await createAgentPrefsService(db).update(user.id, { tabs: ["budgets"], tabsWrite: [] });

    const client = await connectMcp(token);

    // Before the fix, list_uncategorized_transactions was absent from the
    // MCP_TOOLS registry, so scopesFor() returned [] and ANY token could call
    // it scope-free. Now it requires read:banking/read:investments.
    const denied = await client.callTool({ name: "list_uncategorized_transactions", arguments: {} });
    expect(denied.isError).toBe(true);
    const deniedText = (denied.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    expect(deniedText).toContain("insufficient_scope");

    // And it stays hidden from tools/list for this narrow token.
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).not.toContain("list_uncategorized_transactions");

    await client.close();
  });

  it("a follow_settings token tracks the user's caps in both directions", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, "mcp-caps-3");
    // follow_settings: scopes come from caps at creation (budgets on now)…
    await createAgentPrefsService(db).update(user.id, { tabs: ["budgets"], tabsWrite: [] });
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "hermes-token",
      preset: "custom",
      followSettings: true,
    });

    let auth = await authFromToken(token);
    expect(auth.scopes).toContain("read:budgets");

    // …and shrink when the user removes the tab (no token regeneration).
    await createAgentPrefsService(db).update(user.id, { tabs: ["activity"] });
    auth = await authFromToken(token);
    expect(auth.scopes).not.toContain("read:budgets");
  });
});

describe("MCP account-scope isolation", () => {
  it("banking-only tokens do not receive investment transactions", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, `mcp-txn-type-${Date.now()}`);
    await createAgentPrefsService(db).update(user.id, { global: true });
    const accounts = createAccountsService(db);
    const checking = await accounts.createManual(user.id, { name: "MCP Checking", type: "depository" });
    const brokerage = await accounts.createManual(user.id, { name: "MCP Brokerage", type: "investment" });
    await createTransactionsService(db).createManual(user.id, { accountId: checking.id, amountCents: -1000, date: "2026-09-26", name: "MCP checking txn" });
    const investmentTxn = await createTransactionsService(db).createManual(user.id, { accountId: brokerage.id, amountCents: -2000, date: "2026-09-26", name: "MCP investment txn" });
    const { token } = await createAgentTokenService(db).create(user.id, { name: "mcp-bank", preset: "custom", scopes: ["read:banking"] });
    const client = await connectMcp(token);

    const listed = await client.callTool({ name: "list_transactions", arguments: { limit: 20 } });
    const text = (listed.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    expect(text).toContain("MCP checking txn");
    expect(text).not.toContain("MCP investment txn");
    await expect(client.callTool({ name: "get_transaction", arguments: { transactionId: investmentTxn.id } })).rejects.toThrow(/Transaction not found/i);

    await client.close();
  });

  it("reports, budget progress, and projection honor the token account allowlist", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, `mcp-aggregate-${Date.now()}`);
    await createAgentPrefsService(db).update(user.id, { global: true });
    const accounts = createAccountsService(db);
    const allowed = await accounts.createManual(user.id, { name: "MCP Aggregate Allowed", type: "depository", currentBalanceCents: 100_000 });
    const blocked = await accounts.createManual(user.id, { name: "MCP Aggregate Blocked", type: "depository", currentBalanceCents: 900_000 });
    const category = await createCategoriesService(db).create(user.id, { name: `MCP Aggregate ${Date.now()}` });
    await createTransactionsService(db).createManual(user.id, { accountId: allowed.id, amountCents: -1_000, date: "2026-09-26", name: "MCP allowed spend", userCategoryId: category.id });
    await createTransactionsService(db).createManual(user.id, { accountId: blocked.id, amountCents: -9_000, date: "2026-09-26", name: "MCP blocked spend", userCategoryId: category.id });
    await createBudgetsService(db).create(user.id, { name: "MCP scoped budget", amountCents: 20_000, categoryIds: [category.id] });
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "mcp-aggregate-reader",
      preset: "custom",
      scopes: ["read:reports", "read:budgets", "read:planning"],
      accountIds: [allowed.id],
    });
    const client = await connectMcp(token);

    const net = await client.callTool({ name: "get_net_worth", arguments: {} });
    const netText = (net.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    expect(netText).toContain('"netCents": 100000');
    expect(netText).not.toContain("1000000");

    const budgets = await client.callTool({ name: "get_budgets", arguments: {} });
    const budgetText = (budgets.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    expect(budgetText).toContain('"spentCents": 1000');
    expect(budgetText).not.toContain('"spentCents": 10000');

    const planning = await client.callTool({ name: "get_planning_items", arguments: {} });
    const planningText = (planning.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    expect(planningText).toContain('"baselineCents": 100000');
    expect(planningText).not.toContain('"baselineCents": 1000000');

    await client.close();
  });

  it("transaction category writes honor the token account allowlist", async () => {
    const db = getSqliteDb();
    const user = await seedUser(db, `mcp-txn-allow-${Date.now()}`);
    await createAgentPrefsService(db).update(user.id, { global: true });
    const accounts = createAccountsService(db);
    const allowed = await accounts.createManual(user.id, { name: "MCP Allowed", type: "depository" });
    const blocked = await accounts.createManual(user.id, { name: "MCP Blocked", type: "depository" });
    const allowedTxn = await createTransactionsService(db).createManual(user.id, { accountId: allowed.id, amountCents: -1000, date: "2026-09-26", name: "MCP allowed txn" });
    const blockedTxn = await createTransactionsService(db).createManual(user.id, { accountId: blocked.id, amountCents: -1000, date: "2026-09-26", name: "MCP blocked txn" });
    const category = await createCategoriesService(db).create(user.id, { name: `Scoped ${Date.now()}` });
    const { token } = await createAgentTokenService(db).create(user.id, {
      name: "mcp-editor",
      preset: "custom",
      scopes: ["read:banking", "transactions:edit"],
      accountIds: [allowed.id],
    });
    const client = await connectMcp(token);

    await expect(client.callTool({ name: "set_transaction_category", arguments: { transactionId: blockedTxn.id, categoryId: category.id } })).rejects.toThrow(/Transaction not found/i);
    expect((await createTransactionsService(db).get(user.id, blockedTxn.id)).user_category_id).toBeNull();

    const accepted = await client.callTool({ name: "set_transaction_category", arguments: { transactionId: allowedTxn.id, categoryId: category.id } });
    expect(accepted.isError).toBeFalsy();
    expect((await createTransactionsService(db).get(user.id, allowedTxn.id)).user_category_id).toBe(category.id);

    await client.close();
  });
});
