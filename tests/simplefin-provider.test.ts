import { describe, expect, it } from "vitest";
import {
  createSimpleFinProvider,
  decodeSimpleFinSetupToken,
  inferSimpleFinAccountType,
  simpleFinScopeKey,
  splitSimpleFinAccessUrl,
  type SimpleFinConnectionSecret,
} from "@/server/providers/simplefin";

const CLAIM_URL = "https://bridge.example/simplefin/claim/abc";
const SETUP_TOKEN = Buffer.from(CLAIM_URL, "utf8").toString("base64");
const ACCESS_URL = "https://demo-user:demo-pass@bridge.example/simplefin";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture() {
  return {
    errlist: [],
    connections: [
      { conn_id: "conn-1", name: "Primary", org_id: "bank-1", org_name: "My Bank" },
      { conn_id: "conn-2", name: "Card", org_id: "bank-2", org_name: "Card Bank" },
    ],
    accounts: [
      {
        id: "acct-1",
        conn_id: "conn-1",
        name: "Everyday Checking",
        currency: "USD",
        balance: "1234.56",
        "available-balance": "1200.00",
        transactions: [
          {
            id: "txn-1",
            posted: 1789948800,
            amount: "-33.00",
            description: "BLUE BOTTLE COFFEE",
            payee: "Blue Bottle",
            pending: false,
          },
          {
            id: "txn-2",
            posted: 1790035200,
            amount: "2500.00",
            description: "PAYROLL",
            pending: false,
          },
        ],
      },
      {
        // Deliberately reuse account + transaction ids under another v2
        // connection: v2 only guarantees these ids inside their parent scope.
        id: "acct-1",
        conn_id: "conn-2",
        name: "Visa Signature Card",
        currency: "USD",
        balance: "-450.25",
        transactions: [
          {
            id: "txn-1",
            posted: 1789948800,
            amount: "-19.99",
            description: "STREAMING SVC",
            pending: true,
          },
        ],
      },
    ],
  };
}

describe("SimpleFIN provider", () => {
  it("decodes setup tokens and strips credentials from request URLs", () => {
    expect(decodeSimpleFinSetupToken(SETUP_TOKEN)).toBe(CLAIM_URL);
    const split = splitSimpleFinAccessUrl(ACCESS_URL);
    expect(split.baseUrl).toBe("https://bridge.example/simplefin");
    expect(split.baseUrl).not.toContain("demo-pass");
    expect(split.authorization).toBe(
      `Basic ${Buffer.from("demo-user:demo-pass").toString("base64")}`,
    );
  });

  it("claims a setup token exactly once with POST", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = createSimpleFinProvider({
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        return new Response(ACCESS_URL, { status: 200 });
      },
    });
    await expect(provider.claimSetupToken(SETUP_TOKEN)).resolves.toBe(ACCESS_URL);
    expect(calls).toEqual([{ url: CLAIM_URL, method: "POST" }]);
  });

  it("discovers multiple v2 connections and namespaces colliding account ids", async () => {
    const seen: string[] = [];
    const provider = createSimpleFinProvider({
      fetchImpl: async (input) => {
        seen.push(String(input));
        return json(fixture());
      },
    });
    const connections = await provider.discoverConnections(ACCESS_URL);
    expect(connections).toHaveLength(2);
    expect(connections[0].externalConnectionId).not.toBe(connections[1].externalConnectionId);

    const first: SimpleFinConnectionSecret = {
      accessUrl: ACCESS_URL,
      remoteConnectionId: "conn-1",
      scopeKey: simpleFinScopeKey(ACCESS_URL, "conn-1"),
    };
    const second: SimpleFinConnectionSecret = {
      accessUrl: ACCESS_URL,
      remoteConnectionId: "conn-2",
      scopeKey: simpleFinScopeKey(ACCESS_URL, "conn-2"),
    };
    const [a1] = await provider.listAccounts(first);
    const [a2] = await provider.listAccounts(second);
    expect(a1.externalId).not.toBe(a2.externalId);
    expect(a1.currentBalanceMinor).toBe(123456);
    // Liability magnitude is normalized at the adapter boundary; the shared
    // sync engine applies Aubrieta's negative liability sign once.
    expect(a2.type).toBe("credit_card");
    expect(a2.currentBalanceMinor).toBe(45025);
    expect(seen.every((url) => !url.includes("demo-pass"))).toBe(true);
  });

  it("keeps SimpleFIN transaction signs and namespaces colliding transaction ids", async () => {
    const provider = createSimpleFinProvider({
      fetchImpl: async () => json(fixture()),
      now: () => new Date("2026-09-24T20:00:00Z"),
      initialLookbackDays: 30,
      overlapDays: 5,
    });
    const first: SimpleFinConnectionSecret = {
      accessUrl: ACCESS_URL,
      remoteConnectionId: "conn-1",
      scopeKey: simpleFinScopeKey(ACCESS_URL, "conn-1"),
    };
    const second: SimpleFinConnectionSecret = {
      accessUrl: ACCESS_URL,
      remoteConnectionId: "conn-2",
      scopeKey: simpleFinScopeKey(ACCESS_URL, "conn-2"),
    };
    const r1 = await provider.syncTransactions!(first, { value: null });
    const r2 = await provider.syncTransactions!(second, { value: null });

    expect(r1.added.map((t) => t.amountMinor)).toEqual([-3300, 250000]);
    expect(r2.added[0].amountMinor).toBe(-1999);
    expect(r1.added[0].externalId).not.toBe(r2.added[0].externalId);
    expect(r1.added[0].accountExternalId).not.toBe(r2.added[0].accountExternalId);
    expect(r2.added[0].pending).toBe(true);
    expect(r1.nextCursor.value).toMatch(/^sf1:\d+$/);
  });

  it("infers common account types and fails closed on unknown names", () => {
    expect(inferSimpleFinAccountType("Everyday Checking")).toBe("checking");
    expect(inferSimpleFinAccountType("High Yield Savings")).toBe("savings");
    expect(inferSimpleFinAccountType("Visa Signature Card")).toBe("credit_card");
    expect(inferSimpleFinAccountType("Home Mortgage")).toBe("mortgage");
    expect(inferSimpleFinAccountType("Brokerage IRA")).toBe("investment");
    expect(inferSimpleFinAccountType("Mystery Account")).toBe("other");
  });

  it("rejects local/link-local claim targets", () => {
    const local = Buffer.from(
      "https://169.254.169.254/latest/meta-data/",
      "utf8",
    ).toString("base64");
    expect(() => decodeSimpleFinSetupToken(local)).toThrow(/blocked/i);
    expect(() =>
      splitSimpleFinAccessUrl("https://user:pass@127.0.0.1/simplefin"),
    ).toThrow(/blocked/i);
  });
});
