import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedUser } from "./helpers";
import { createAkoyaService } from "@/server/akoya/service";
import { decrypt, encrypt } from "@/lib/crypto";
import type { AkoyaConnectionSecret } from "@/server/providers/akoya";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(grantId: string): string {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify({ grant_id: grantId })).toString("base64url"),
    "sig",
  ].join(".");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Akoya service", () => {
  it("stores credentials safely, validates OAuth state, and projects FDX liabilities into Bills", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "akoya-oauth");
    const calls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/token") && init?.method === "POST") {
          return json({
            id_token: jwt("grant-1"),
            refresh_token: "refresh-1",
            expires_in: 900,
          });
        }
        if (url.includes("/balances/v3/mikomo")) {
          return json({
            accounts: [
              {
                depositAccount: {
                  accountId: "checking-1",
                  accountCategory: "DEPOSIT_ACCOUNT",
                  accountType: "CHECKING",
                  nickname: "Checking",
                  currency: { currencyCode: "USD" },
                  currentBalance: 1000,
                  availableBalance: 950,
                  status: "OPEN",
                },
              },
              {
                locAccount: {
                  accountId: "card-1",
                  accountCategory: "LOC_ACCOUNT",
                  accountType: "CREDITCARD",
                  productName: "Visa",
                  currency: { currencyCode: "USD" },
                  currentBalance: 500,
                  minimumPaymentAmount: 50,
                  nextPaymentDate: "2026-10-15T00:00:00Z",
                  lastStmtBalance: 725,
                  lastStmtDate: "2026-09-28T00:00:00Z",
                  purchasesApr: 19.99,
                  status: "OPEN",
                },
              },
            ],
          });
        }
        if (url.includes("/transactions/")) {
          const accountId = decodeURIComponent(url.split("/transactions/v3/mikomo/")[1].split("?")[0]);
          return json({
            links: {},
            transactions:
              accountId === "checking-1"
                ? [
                    {
                      depositTransaction: {
                        accountId: "checking-1",
                        transactionId: "txn-1",
                        amount: -25,
                        description: "Dinner",
                        status: "POSTED",
                        postedTimestamp: "2026-09-20T00:00:00Z",
                      },
                    },
                  ]
                : [],
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      }),
    );

    const service = createAkoyaService(db);
    await service.saveCredentials(user.id, {
      environment: "sandbox",
      clientId: "client-id",
      clientSecret: "super-secret",
      redirectUri: "https://aubrieta.example/api/akoya/callback",
    });

    const credential = await db.get<{
      id: string;
      config_enc: string;
      public_config_json: string;
    }>(
      "SELECT id, config_enc, public_config_json FROM provider_credentials WHERE user_id = ? AND provider = 'akoya'",
      user.id,
    );
    expect(credential?.config_enc).not.toContain("super-secret");
    expect(credential?.public_config_json).not.toContain("super-secret");

    const start = await service.startAuthorization(user.id, "sandbox", "mikomo");
    const auth = new URL(start.authorizationUrl);
    const state = auth.searchParams.get("state");
    expect(auth.origin + auth.pathname).toBe("https://sandbox-idp.ddp.akoya.com/auth");
    expect(auth.searchParams.get("connector")).toBe("mikomo");
    expect(state).toBeTruthy();

    const completed = await service.completeAuthorization(
      user.id,
      state!,
      "authorization-code",
    );
    expect(completed.sync.ok).toBe(true);
    expect(completed.sync.added).toBe(1);

    const connection = await db.get<{
      id: string;
      provider: string;
      external_connection_id: string;
      institution_external_id: string;
      status: string;
    }>(
      "SELECT id, provider, external_connection_id, institution_external_id, status FROM provider_connections WHERE user_id = ? AND provider = 'akoya'",
      user.id,
    );
    expect(connection).toMatchObject({
      provider: "akoya",
      external_connection_id: "grant-1",
      institution_external_id: "mikomo",
      status: "active",
    });

    const accounts = await db.all<{
      name: string;
      current_balance_cents: number;
    }>(
      "SELECT name, current_balance_cents FROM accounts WHERE user_id = ? ORDER BY name",
      user.id,
    );
    expect(accounts).toEqual([
      { name: "Checking", current_balance_cents: 100000 },
      { name: "Visa", current_balance_cents: -50000 },
    ]);

    const bill = await db.get<{
      name: string;
      amount_cents: number;
      next_due_date: string;
      source: string;
      source_confidence: string;
    }>(
      "SELECT name, amount_cents, next_due_date, source, source_confidence FROM bills WHERE user_id = ?",
      user.id,
    );
    expect(bill).toMatchObject({
      name: "Visa payment",
      amount_cents: 5000,
      next_due_date: "2026-10-15",
      source: "provider",
      source_confidence: "confirmed",
    });

    const stored = await db.get<{ secret_enc: string }>(
      "SELECT secret_enc FROM provider_connection_secrets WHERE connection_id = ?",
      connection!.id,
    );
    expect(stored?.secret_enc).not.toContain("refresh-1");
    expect(calls.filter((u) => u.endsWith("/token"))).toHaveLength(1);

    await expect(
      service.completeAuthorization(user.id, state!, "authorization-code"),
    ).rejects.toThrow(/expired/i);
  });

  it("refreshes and persists rotating tokens before a later sync", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "akoya-refresh");
    let refreshCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/token")) {
          const body = init?.body as URLSearchParams;
          if (body.get("grant_type") === "refresh_token") {
            refreshCalls++;
            return json({
              id_token: jwt("grant-1"),
              refresh_token: "refresh-2",
              expires_in: 900,
            });
          }
          return json({
            id_token: jwt("grant-1"),
            refresh_token: "refresh-1",
            expires_in: 900,
          });
        }
        if (url.includes("/balances/")) {
          return json({
            accounts: [
              {
                depositAccount: {
                  accountId: "checking-1",
                  accountCategory: "DEPOSIT_ACCOUNT",
                  accountType: "CHECKING",
                  nickname: "Checking",
                  currency: { currencyCode: "USD" },
                  currentBalance: 1,
                },
              },
            ],
          });
        }
        if (url.includes("/transactions/")) return json({ links: {}, transactions: [] });
        throw new Error(`Unexpected fetch ${url}`);
      }),
    );

    const service = createAkoyaService(db);
    await service.saveCredentials(user.id, {
      environment: "sandbox",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://aubrieta.example/api/akoya/callback",
    });
    const start = await service.startAuthorization(user.id, "sandbox", "mikomo");
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const completed = await service.completeAuthorization(user.id, state, "code");

    const row = await db.get<{ secret_enc: string }>(
      "SELECT secret_enc FROM provider_connection_secrets WHERE connection_id = ?",
      completed.connectionId,
    );
    const aad = `${user.id}:provider:${completed.connectionId}`;
    const secret = JSON.parse(decrypt(row!.secret_enc, aad)) as AkoyaConnectionSecret;
    secret.tokens.expiresAt = "2000-01-01T00:00:00.000Z";
    await db.run(
      "UPDATE provider_connection_secrets SET secret_enc = ? WHERE connection_id = ?",
      encrypt(JSON.stringify(secret), aad),
      completed.connectionId,
    );

    const result = await service.syncAll(user.id, "BATCH");
    expect(result[0].ok).toBe(true);
    expect(refreshCalls).toBe(1);

    const rotatedRow = await db.get<{ secret_enc: string }>(
      "SELECT secret_enc FROM provider_connection_secrets WHERE connection_id = ?",
      completed.connectionId,
    );
    const rotated = JSON.parse(
      decrypt(rotatedRow!.secret_enc, aad),
    ) as AkoyaConnectionSecret;
    expect(rotated.tokens.refreshToken).toBe("refresh-2");
    expect(rotated.interactionType).toBe("BATCH");
  });
});
