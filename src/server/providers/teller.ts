import https from "node:https";
import { URL } from "node:url";
import type {
  FinancialProvider,
  NormalizedAccountType,
  ProviderAccount,
  ProviderTransaction,
  ProviderTransactionSync,
} from "./types";

export type TellerEnvironment = "sandbox" | "development" | "production";

export interface TellerConfig {
  environment: TellerEnvironment;
  applicationId: string;
  certificatePem?: string | null;
  privateKeyPem?: string | null;
  tokenSigningKey: string;
}

export interface TellerConnectionSecret {
  config: TellerConfig;
  accessToken: string;
}

interface TellerAccount {
  id: string;
  enrollment_id: string;
  name: string;
  last_four: string;
  type: "depository" | "credit";
  subtype: string;
  currency: string;
  status: "open" | "closed";
  institution: { id: string; name: string };
  links: { balances?: string; transactions?: string };
}

interface TellerBalances {
  ledger: string | null;
  available: string | null;
  account_id: string;
}

interface TellerTransaction {
  id: string;
  account_id: string;
  amount: string;
  date: string;
  description: string;
  status: "posted" | "pending";
  type: string;
  details?: {
    category?: string | null;
    counterparty?: { name?: string | null; type?: string | null } | null;
    processing_status?: string | null;
  } | null;
}

function asSecret(secret: unknown): TellerConnectionSecret {
  const s = secret as Partial<TellerConnectionSecret> | null;
  if (!s?.config || typeof s.accessToken !== "string") {
    throw new Error("Invalid Teller connection secret.");
  }
  return s as TellerConnectionSecret;
}

function cents(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function normalizeAccountType(type: string, subtype: string): NormalizedAccountType {
  if (type === "credit" || subtype === "credit_card") return "credit_card";
  if (subtype === "checking") return "checking";
  if (subtype === "savings" || subtype === "money_market") return "savings";
  return type === "depository" ? "cash" : "other";
}

function startDateFromCursor(cursor: string | null): string {
  const today = new Date();
  if (!cursor) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - 730);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(`${cursor}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return cursor;
  // Teller recommends overlapping by 7-10 days because a pending
  // transaction's date can move when it posts.
  d.setUTCDate(d.getUTCDate() - 10);
  return d.toISOString().slice(0, 10);
}

function tellerRequest<T>(
  config: TellerConfig,
  accessToken: string,
  path: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (
      config.environment !== "sandbox" &&
      (!config.certificatePem || !config.privateKeyPem)
    ) {
      reject(new Error("Teller development/production requires a client certificate and private key."));
      return;
    }

    const url = new URL(path, "https://api.teller.io");
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        cert: config.certificatePem || undefined,
        key: config.privateKeyPem || undefined,
        headers: {
          Authorization: `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}`,
          Accept: "application/json",
          "Teller-Version": "2020-10-12",
          "User-Agent": "Aubrieta-Finance/0.1",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            let detail = body;
            try {
              const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
              detail = parsed.error?.message ?? parsed.error?.code ?? body;
            } catch {
              // keep raw response text
            }
            reject(new Error(`Teller API ${status}: ${detail || "request failed"}`));
            return;
          }
          try {
            resolve((body ? JSON.parse(body) : null) as T);
          } catch {
            reject(new Error("Teller returned invalid JSON."));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function listAccountsWithBalances(secret: TellerConnectionSecret): Promise<ProviderAccount[]> {
  const accounts = await tellerRequest<TellerAccount[]>(
    secret.config,
    secret.accessToken,
    "/accounts",
  );
  const out: ProviderAccount[] = [];
  for (const account of accounts) {
    if (account.status === "closed") continue;
    let balances: TellerBalances | null = null;
    if (account.links?.balances) {
      try {
        balances = await tellerRequest<TellerBalances>(
          secret.config,
          secret.accessToken,
          `/accounts/${encodeURIComponent(account.id)}/balances`,
        );
      } catch {
        // Balance is optional for provider discovery; a later sync can retry.
      }
    }
    out.push({
      externalId: account.id,
      institutionExternalId: account.institution?.id ?? null,
      name: account.name,
      officialName: account.name,
      type: normalizeAccountType(account.type, account.subtype),
      subtype: account.subtype,
      mask: account.last_four || null,
      currency: account.currency || "USD",
      currentBalanceMinor: cents(balances?.ledger),
      availableBalanceMinor: cents(balances?.available),
    });
  }
  return out;
}

async function listTransactions(
  secret: TellerConnectionSecret,
  accountId: string,
  start: string,
  end: string,
): Promise<TellerTransaction[]> {
  const all: TellerTransaction[] = [];
  let fromId: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const q = new URLSearchParams({
      start_date: start,
      end_date: end,
      count: "500",
    });
    if (fromId) q.set("from_id", fromId);
    const page = await tellerRequest<TellerTransaction[]>(
      secret.config,
      secret.accessToken,
      `/accounts/${encodeURIComponent(accountId)}/transactions?${q.toString()}`,
    );
    all.push(...page);
    if (page.length < 500) break;
    const next = page[page.length - 1]?.id;
    if (!next || next === fromId) break;
    fromId = next;
  }
  return all;
}

export function createTellerProvider(): FinancialProvider {
  return {
    descriptor: {
      kind: "teller",
      displayName: "Teller",
      capabilities: new Set([
        "accounts",
        "balances",
        "transactions",
        "refresh",
        "reauth",
      ]),
    },

    async listAccounts(connectionSecret) {
      return listAccountsWithBalances(asSecret(connectionSecret));
    },

    async syncTransactions(connectionSecret, cursor): Promise<ProviderTransactionSync> {
      const secret = asSecret(connectionSecret);
      const accounts = await tellerRequest<TellerAccount[]>(
        secret.config,
        secret.accessToken,
        "/accounts",
      );
      const start = startDateFromCursor(cursor.value);
      const end = new Date().toISOString().slice(0, 10);
      const added: ProviderTransaction[] = [];

      for (const account of accounts) {
        if (account.status === "closed" || !account.links?.transactions) continue;
        const txns = await listTransactions(secret, account.id, start, end);
        for (const t of txns) {
          const raw = cents(t.amount);
          if (raw == null) continue;
          added.push({
            externalId: t.id,
            accountExternalId: t.account_id,
            // Teller examples represent ATM withdrawals as positive amounts.
            // Normalize at the adapter boundary to Aubrieta's sign convention.
            amountMinor: -raw,
            currency: account.currency || "USD",
            date: t.date,
            authorizedDate: null,
            name: t.description,
            merchant: t.details?.counterparty?.name ?? null,
            pending: t.status === "pending",
            categoryHint: t.details?.category ?? t.type ?? null,
            categoryPath: t.details?.category ?? null,
            personalFinanceCategory: null,
          });
        }
      }

      return {
        added,
        modified: [],
        removedExternalIds: [],
        nextCursor: { value: end },
      };
    },

    async refresh() {
      // Teller refreshes enrollments at least daily. Calling account and
      // transaction endpoints retrieves the newest available data.
    },

    async revoke(connectionSecret) {
      const secret = asSecret(connectionSecret);
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: "api.teller.io",
            port: 443,
            path: "/accounts",
            method: "DELETE",
            cert: secret.config.certificatePem || undefined,
            key: secret.config.privateKeyPem || undefined,
            headers: {
              Authorization: `Basic ${Buffer.from(`${secret.accessToken}:`).toString("base64")}`,
              "Teller-Version": "2020-10-12",
              "User-Agent": "Aubrieta-Finance/0.1",
            },
          },
          (res) => {
            res.resume();
            const status = res.statusCode ?? 500;
            if (status >= 200 && status < 300) resolve();
            else reject(new Error(`Teller revoke failed with HTTP ${status}.`));
          },
        );
        req.on("error", reject);
        req.end();
      });
    },
  };
}

export async function inspectTellerEnrollment(
  secret: TellerConnectionSecret,
): Promise<{
  enrollmentId: string | null;
  institutionExternalId: string | null;
  institutionName: string | null;
  accounts: ProviderAccount[];
}> {
  const rawAccounts = await tellerRequest<TellerAccount[]>(
    secret.config,
    secret.accessToken,
    "/accounts",
  );
  const first = rawAccounts[0] ?? null;
  return {
    enrollmentId: first?.enrollment_id ?? null,
    institutionExternalId: first?.institution?.id ?? null,
    institutionName: first?.institution?.name ?? null,
    accounts: await listAccountsWithBalances(secret),
  };
}
