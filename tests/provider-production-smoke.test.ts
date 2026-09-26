import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts/provider-smoke.mjs");

function runSmoke(env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("M5.7 production-provider smoke harness", () => {
  it("fails closed without explicit live-provider opt-in and provider selection", async () => {
    const noOptIn = await runSmoke({
      AUBRIETA_PROVIDER_SMOKE: undefined,
      AUBRIETA_SMOKE_BASE_URL: "http://127.0.0.1:9",
      AUBRIETA_SMOKE_PROVIDERS: "plaid",
    });
    expect(noOptIn.code).toBe(1);
    expect(noOptIn.stderr).toContain("AUBRIETA_PROVIDER_SMOKE=YES_I_UNDERSTAND");

    const noProviders = await runSmoke({
      AUBRIETA_PROVIDER_SMOKE: "YES_I_UNDERSTAND",
      AUBRIETA_SMOKE_BASE_URL: "http://127.0.0.1:9",
      AUBRIETA_SMOKE_PROVIDERS: "",
    });
    expect(noProviders.code).toBe(1);
    expect(noProviders.stderr).toContain("AUBRIETA_SMOKE_PROVIDERS");
  });

  it("refuses authenticated remote plain HTTP", async () => {
    const result = await runSmoke({
      AUBRIETA_PROVIDER_SMOKE: "YES_I_UNDERSTAND",
      AUBRIETA_SMOKE_BASE_URL: "http://example.com",
      AUBRIETA_SMOKE_PROVIDERS: "plaid",
      AUBRIETA_SMOKE_COOKIE: "of_session=do-not-send",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to send an authenticated smoke session over remote plain HTTP");
  });

  it("exercises login, two syncs, health, linked accounts and liability detail without leaking financial data", async () => {
    let syncCount = 0;
    const secretAccountName = "Extremely Secret Brokerage Card";
    const secretInstitution = "Private Family Bank";
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const body = JSON.parse(await readBody(req)) as { username?: string; password?: string };
        expect(body).toEqual(expect.objectContaining({ username: "smoke-user", password: "smoke-password" }));
        return json(res, 200, { user: { id: "u1" }, expiresAt: null }, { "set-cookie": "of_session=smoke-session; Path=/; HttpOnly; SameSite=Lax" });
      }
      expect(req.headers.cookie).toContain("of_session=smoke-session");
      if (req.method === "GET" && url.pathname === "/api/connections/health") {
        return json(res, 200, {
          summary: { connectionCount: 1, healthyCount: syncCount > 0 ? 1 : 0 },
          connections: [{
            id: "conn-plaid-1",
            provider: "plaid",
            providerName: "Plaid",
            institutionName: secretInstitution,
            environment: "production",
            state: syncCount > 0 ? "healthy" : "needs_attention",
            rawStatus: syncCount > 0 ? "active" : "linked",
            lastSuccessfulSyncAt: syncCount > 0 ? `2026-09-26T18:2${syncCount}:00.000Z` : null,
            lastError: null,
            updatedAt: "2026-09-26T18:20:00.000Z",
            capabilities: ["accounts", "balances", "transactions", "liabilities", "refresh", "reauth"],
            supportsRefresh: true,
            supportsReauth: true,
            accountCount: syncCount > 0 ? 1 : 0,
            accountNames: syncCount > 0 ? [secretAccountName] : [],
          }],
        });
      }
      if (req.method === "POST" && url.pathname === "/api/transactions/sync") {
        expect(req.headers["x-of-request"]).toBe("1");
        syncCount++;
        return json(res, 200, {
          results: [{ provider: "plaid", itemId: "item-1", institutionName: secretInstitution, added: syncCount === 1 ? 4 : 0, modified: 0, removed: 0, ok: true }],
          bills: { refreshed: 0 },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/plaid/items") {
        return json(res, 200, { items: [{ id: "item-1", accounts: [{ id: "acct-1", name: secretAccountName }] }] });
      }
      if (req.method === "GET" && url.pathname === "/api/accounts/acct-1") {
        return json(res, 200, {
          account: { id: "acct-1", name: secretAccountName, type: "credit", current_balance_cents: -123456 },
          liability: { minimumPaymentCents: 2500, statementBalanceCents: 120000 },
          recentTransactions: [{ name: "Secret Merchant", amount_cents: -9999 }],
        });
      }
      return json(res, 404, { error: { code: "not_found", message: "not found" } });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    try {
      const result = await runSmoke({
        AUBRIETA_PROVIDER_SMOKE: "YES_I_UNDERSTAND",
        AUBRIETA_SMOKE_BASE_URL: `http://127.0.0.1:${address.port}`,
        AUBRIETA_SMOKE_PROVIDERS: "plaid",
        AUBRIETA_SMOKE_USERNAME: "smoke-user",
        AUBRIETA_SMOKE_PASSWORD: "smoke-password",
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Sync pass 1: PASS");
      expect(result.stdout).toContain("plaid: 1 linked account(s); liabilities 1/1 liability account(s) returned provider detail");
      expect(result.stdout).toContain("Sync pass 2 / resync: PASS");
      expect(result.stdout).toContain("M5.7 provider smoke: PASS");
      expect(syncCount).toBe(2);
      expect(result.stdout).not.toContain(secretAccountName);
      expect(result.stdout).not.toContain(secretInstitution);
      expect(result.stdout).not.toContain("123456");
      expect(result.stdout).not.toContain("Secret Merchant");
      expect(result.stdout).not.toContain("smoke-password");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  }, 15_000);

  it("is not wired into ordinary GitHub Actions", () => {
    const workflows = readdirSync(path.join(root, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => readFileSync(path.join(root, ".github/workflows", name), "utf8"))
      .join("\n");
    expect(workflows).not.toContain("smoke:providers");
    expect(workflows).not.toContain("provider-smoke.mjs");
  });
});
