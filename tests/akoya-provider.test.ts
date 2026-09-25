import { afterEach, describe, expect, it, vi } from "vitest";
import {
  akoyaAuthorizationUrl,
  createAkoyaProvider,
  exchangeAkoyaCode,
  refreshAkoyaTokens,
  revokeAkoyaRefreshToken,
  type AkoyaConfig,
  type AkoyaConnectionSecret,
} from "@/server/providers/akoya";

const config: AkoyaConfig = {
  environment: "sandbox",
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://aubrieta.example/api/akoya/callback",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function idToken(payload: Record<string, unknown>): string {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Akoya authorization and tokens", () => {
  it("builds the documented authorization-code URL", () => {
    const url = new URL(
      akoyaAuthorizationUrl({
        config,
        providerId: "mikomo",
        state: "opaque-state",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://sandbox-idp.ddp.akoya.com/auth");
    expect(url.searchParams.get("connector")).toBe("mikomo");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile offline_access");
    expect(url.searchParams.get("state")).toBe("opaque-state");
  });

  it("exchanges authorization codes using Basic auth and captures grant identity", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return json({
          id_token: idToken({ grant_id: "grant-from-jwt" }),
          refresh_token: "refresh-1",
          expires_in: 900,
          token_type: "bearer",
        });
      }),
    );

    const tokens = await exchangeAkoyaCode({ config, code: "auth-code" });
    expect(tokens.grantId).toBe("grant-from-jwt");
    expect(tokens.refreshToken).toBe("refresh-1");
    expect(calls[0].url).toBe("https://sandbox-idp.ddp.akoya.com/token");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    const body = calls[0].init?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
    expect(body.get("code")).toBe("auth-code");
  });

  it("rotates refresh tokens and can revoke the current grant", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        if (String(input).endsWith("/token")) {
          return json({
            id_token: idToken({ grant_id: "grant-1" }),
            refresh_token: "refresh-2",
            expires_in: 900,
          });
        }
        return new Response("", { status: 200 });
      }),
    );

    const rotated = await refreshAkoyaTokens({
      config,
      refreshToken: "refresh-1",
      previousGrantId: "grant-1",
    });
    expect(rotated.refreshToken).toBe("refresh-2");

    await revokeAkoyaRefreshToken({ config, refreshToken: rotated.refreshToken });
    expect(calls[1].url).toBe("https://sandbox-idp.ddp.akoya.com/revoke");
    const revokeBody = calls[1].init?.body as URLSearchParams;
    expect(revokeBody.get("token")).toBe("refresh-2");
    expect(revokeBody.get("token_type_hint")).toBe("refresh_token");
  });
});

describe("Akoya FDX provider", () => {
  const secret: AkoyaConnectionSecret = {
    config,
    providerId: "mikomo",
    tokens: {
      idToken: "id-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      grantId: "grant-1",
    },
    interactionType: "USER",
    lastAccessAt: "2026-09-24T20:00:00.000Z",
  };

  const balances = {
    accounts: [
      {
        depositAccount: {
          accountId: "checking-1",
          accountCategory: "DEPOSIT_ACCOUNT",
          accountType: "CHECKING",
          nickname: "Everyday Checking",
          accountNumberDisplay: "1234",
          balanceType: "ASSET",
          currency: { currencyCode: "USD" },
          currentBalance: 1234.56,
          availableBalance: 1200,
          status: "OPEN",
        },
      },
      {
        locAccount: {
          accountId: "card-1",
          accountCategory: "LOC_ACCOUNT",
          accountType: "CREDITCARD",
          productName: "Rewards Visa",
          accountNumberDisplay: "9876",
          balanceType: "LIABILITY",
          currency: { currencyCode: "USD" },
          currentBalance: 450.25,
          availableCredit: 4549.75,
          minimumPaymentAmount: 45,
          nextPaymentAmount: 450.25,
          nextPaymentDate: "2026-10-15T00:00:00Z",
          lastStmtBalance: 1708.77,
          lastStmtDate: "2026-09-28T00:00:00Z",
          purchasesApr: 24.99,
          status: "OPEN",
        },
      },
      {
        loanAccount: {
          accountId: "mortgage-1",
          accountCategory: "LOAN_ACCOUNT",
          accountType: "MORTGAGE",
          productName: "Home Mortgage",
          balanceType: "LIABILITY",
          currency: { currencyCode: "USD" },
          principalBalance: 300000,
          nextPaymentAmount: 3141.54,
          nextPaymentDate: "2026-10-01T00:00:00Z",
          interestRate: 3.99,
          lastPaymentAmount: 3141.54,
          lastPaymentDate: "2026-09-01T00:00:00Z",
          status: "OPEN",
        },
      },
    ],
  };

  it("maps FDX balances and provider-confirmed liabilities", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return json(balances);
      }),
    );

    const provider = createAkoyaProvider();
    const accounts = await provider.listAccounts(secret);
    expect(accounts).toHaveLength(3);
    expect(accounts[0]).toMatchObject({
      externalId: "mikomo:a:checking-1",
      type: "checking",
      currentBalanceMinor: 123456,
      availableBalanceMinor: 120000,
    });
    expect(accounts[1]).toMatchObject({
      externalId: "mikomo:a:card-1",
      type: "credit_card",
      currentBalanceMinor: 45025,
    });
    expect(accounts[2]).toMatchObject({
      type: "mortgage",
      currentBalanceMinor: 30000000,
    });

    const liabilities = await provider.getLiabilities!(secret);
    expect(liabilities).toHaveLength(2);
    expect(liabilities[0]).toMatchObject({
      kind: "credit_card",
      nextPaymentDueDate: "2026-10-15",
      minimumPaymentMinor: 4500,
      statementBalanceMinor: 170877,
      statementDate: "2026-09-28",
      aprBps: 2499,
    });
    expect(liabilities[1]).toMatchObject({
      kind: "mortgage",
      nextPaymentDueDate: "2026-10-01",
      nextMonthlyPaymentMinor: 314154,
      aprBps: 399,
    });

    expect(calls[0].url).toContain("/balances/v3/mikomo?mode=standard");
    expect(calls[0].headers.get("authorization")).toBe("Bearer id-token");
    expect(calls[0].headers.get("x-akoya-interaction-type")).toBe("USER");
    expect(calls[0].headers.get("x-akoya-last-access")).toBe(secret.lastAccessAt);
    expect(calls[0].headers.get("x-akoya-intent-type")).toBe("nonpayments");
  });

  it("maps FDX transaction signs, pending state, namespaced ids and pagination", async () => {
    const urls: string[] = [];
    const firstPage = Array.from({ length: 50 }, (_, i) => ({
      depositTransaction: {
        accountId: "checking-1",
        transactionId: `txn-${i}`,
        amount: i === 0 ? -51.74 : 1,
        description: i === 0 ? "Grocery purchase" : `Row ${i}`,
        payee: i === 0 ? "Market" : undefined,
        category: i === 0 ? "GROCERY" : undefined,
        status: i === 0 ? "PENDING" : "POSTED",
        postedTimestamp: "2026-09-20T00:00:00Z",
      },
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/balances/")) {
          return json({
            accounts: [balances.accounts[0]],
          });
        }
        const parsed = new URL(url);
        const offset = Number(parsed.searchParams.get("offset") ?? "0");
        if (offset === 0) {
          return json({
            links: { next: { href: "/next" } },
            transactions: firstPage,
          });
        }
        return json({
          links: {},
          transactions: [
            {
              depositTransaction: {
                accountId: "checking-1",
                transactionId: "txn-50",
                amount: 2500,
                description: "Payroll",
                status: "POSTED",
                postedTimestamp: "2026-09-21T00:00:00Z",
              },
            },
          ],
        });
      }),
    );

    const result = await createAkoyaProvider().syncTransactions!(secret, { value: null });
    expect(result.added).toHaveLength(51);
    expect(result.added[0]).toMatchObject({
      externalId: "mikomo:a:checking-1:t:txn-0",
      accountExternalId: "mikomo:a:checking-1",
      amountMinor: -5174,
      pending: true,
      merchant: "Market",
    });
    expect(result.added[50].amountMinor).toBe(250000);
    expect(result.nextCursor.value).toMatch(/^akoya1:\d+$/);
    expect(urls.some((u) => u.includes("offset=50"))).toBe(true);
    expect(urls.find((u) => u.includes("/transactions/"))).toContain("mode=standard");
  });
});
