import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type {
  FinancialProvider,
  NormalizedAccountType,
  ProviderAccount,
  ProviderTransaction,
  ProviderTransactionSync,
} from "./types";

const DAY_SECONDS = 86_400;
const DEFAULT_LOOKBACK_DAYS = 730;
const DEFAULT_OVERLAP_DAYS = 5;
const CURSOR_PREFIX = "sf1:";

export interface SimpleFinConnectionSecret {
  accessUrl: string;
  /** SimpleFIN v2 conn_id, or a stable v1 organization-derived id. */
  remoteConnectionId: string;
  /** Credential-free server + remote connection identity hash. */
  scopeKey: string;
}

export interface SimpleFinConnectionDescriptor {
  remoteConnectionId: string;
  externalConnectionId: string;
  scopeKey: string;
  institutionExternalId: string | null;
  institutionName: string;
  accountCount: number;
}

export interface SimpleFinProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  initialLookbackDays?: number;
  overlapDays?: number;
  /**
   * Optional resolver for tests/special deployments. Production defaults to
   * node:dns lookup and rejects private/link-local resolutions before fetch.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

interface SimpleFinError {
  code?: string;
  msg?: string;
  conn_id?: string;
  account_id?: string;
}

interface SimpleFinConnection {
  conn_id: string;
  name?: string;
  org_id?: string;
  org_name?: string;
  org_url?: string;
  sfin_url?: string;
}

interface SimpleFinOrg {
  domain?: string;
  name?: string;
  id?: string;
  url?: string;
  "sfin-url"?: string;
}

interface SimpleFinTransaction {
  id: string;
  posted: number;
  amount: string | number;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
  transacted_at?: number;
  extra?: Record<string, unknown>;
}

interface SimpleFinAccount {
  id: string;
  name?: string;
  conn_id?: string;
  conn_name?: string;
  currency?: string;
  balance?: string | number;
  "available-balance"?: string | number;
  "balance-date"?: number;
  transactions?: SimpleFinTransaction[];
  extra?: Record<string, unknown>;
  org?: SimpleFinOrg;
}

export interface SimpleFinAccountSet {
  errlist?: SimpleFinError[];
  errors?: string[];
  connections?: SimpleFinConnection[];
  accounts: SimpleFinAccount[];
}

export interface SimpleFinProvider extends FinancialProvider {
  claimSetupToken(setupToken: string): Promise<string>;
  discoverConnections(accessUrl: string): Promise<SimpleFinConnectionDescriptor[]>;
}

function safeProviderMessage(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>&]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function parseMoney(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function isoDate(unixSeconds: number | null | undefined, fallback: Date): string {
  if (unixSeconds && Number.isFinite(unixSeconds) && unixSeconds > 0) {
    const d = new Date(Math.floor(unixSeconds) * 1000);
    if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return fallback.toISOString().slice(0, 10);
}

export function inferSimpleFinAccountType(name: string, extra?: Record<string, unknown>): NormalizedAccountType {
  const rawExtra =
    (typeof extra?.["account-type"] === "string" ? extra["account-type"] : null) ??
    (typeof extra?.type === "string" ? extra.type : null) ??
    "";
  const text = `${name} ${rawExtra}`.toLowerCase();
  if (/\b(credit|credit card|visa|mastercard|amex)\b/.test(text)) return "credit_card";
  if (/\b(checking|chequing|current)\b/.test(text)) return "checking";
  if (/\b(savings?|money market|certificate|\bcd\b)\b/.test(text)) return "savings";
  if (/\b(mortgage|home loan|heloc)\b/.test(text)) return "mortgage";
  if (/\b(loan|student loan|auto loan|line of credit)\b/.test(text)) return "loan";
  if (/\b(invest|brokerage|401k|403b|ira|roth|retire|securities)\b/.test(text)) return "investment";
  if (/\b(cash|wallet|prepaid)\b/.test(text)) return "cash";
  return "other";
}

export function decodeSimpleFinSetupToken(setupToken: string): string {
  const compact = setupToken.trim().replace(/\s+/g, "");
  if (!compact) throw new Error("SimpleFIN setup token is empty.");
  let decoded = "";
  try {
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
  } catch {
    throw new Error("SimpleFIN setup token is not valid base64.");
  }
  const url = assertHttpsUrl(decoded, "SimpleFIN claim URL");
  if (url.username || url.password) {
    throw new Error("SimpleFIN claim URL must not contain embedded credentials.");
  }
  return url.toString();
}

function isUnsafeLiteralHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^169\.254\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h)) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

function assertHttpsUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (!url.hostname || isUnsafeLiteralHost(url.hostname)) {
    throw new Error(`${label} points to a blocked local or link-local address.`);
  }
  return url;
}

function isUnsafeResolvedAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (
    a === "::" ||
    a === "::1" ||
    a.startsWith("fc") ||
    a.startsWith("fd") ||
    /^fe[89ab]/.test(a)
  ) {
    return true;
  }
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isUnsafeResolvedAddress(mapped[1]);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(a)) return false;
  const parts = a.split(".").map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [x, y] = parts;
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    x >= 224
  );
}

export function splitSimpleFinAccessUrl(accessUrl: string): {
  baseUrl: string;
  authorization: string | null;
} {
  const url = assertHttpsUrl(accessUrl, "SimpleFIN access URL");
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  url.hash = "";
  const baseUrl = url.toString().replace(/\/+$/, "");
  const authorization = username
    ? `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
    : null;
  return { baseUrl, authorization };
}

function remoteV1ConnectionId(account: SimpleFinAccount): string {
  const org = account.org ?? {};
  return `v1:${org.domain ?? org.id ?? org["sfin-url"] ?? org.name ?? "default"}`;
}

function remoteConnectionIdFor(account: SimpleFinAccount): string {
  return account.conn_id?.trim() || remoteV1ConnectionId(account);
}

function credentialFreeRoot(accessUrl: string): string {
  return splitSimpleFinAccessUrl(accessUrl).baseUrl;
}

export function simpleFinScopeKey(accessUrl: string, remoteConnectionId: string): string {
  return `sf:${createHash("sha256")
    .update(`${credentialFreeRoot(accessUrl)}|${remoteConnectionId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function namespacedAccountId(scopeKey: string, accountId: string): string {
  return `${scopeKey}:a:${accountId}`;
}

function namespacedTransactionId(scopeKey: string, accountId: string, transactionId: string): string {
  return `${scopeKey}:a:${accountId}:t:${transactionId}`;
}

function normalizedCurrency(raw: string | undefined): string {
  const value = (raw ?? "USD").trim();
  return /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : value.slice(0, 100) || "USD";
}

function mapAccount(account: SimpleFinAccount, secret: SimpleFinConnectionSecret): ProviderAccount {
  const name = account.name?.trim() || account.id;
  const type = inferSimpleFinAccountType(name, account.extra);
  const rawCurrent = parseMoney(account.balance);
  const rawAvailable = parseMoney(account["available-balance"]);
  const liability = type === "credit_card" || type === "mortgage" || type === "loan";
  return {
    externalId: namespacedAccountId(secret.scopeKey, account.id),
    institutionExternalId:
      account.org?.domain ?? account.org?.id ?? account.org?.url ?? account.org?.["sfin-url"] ?? null,
    name,
    officialName: null,
    type,
    subtype: null,
    mask: null,
    currency: normalizedCurrency(account.currency),
    // Shared sync stores liabilities as negative balances. SimpleFIN commonly
    // already reports them negative, so normalize to magnitude at this boundary.
    currentBalanceMinor: rawCurrent == null ? null : liability ? Math.abs(rawCurrent) : rawCurrent,
    availableBalanceMinor: rawAvailable == null ? null : liability ? Math.abs(rawAvailable) : rawAvailable,
  };
}

function mapTransaction(
  account: SimpleFinAccount,
  txn: SimpleFinTransaction,
  secret: SimpleFinConnectionSecret,
  now: Date,
): ProviderTransaction | null {
  const amount = parseMoney(txn.amount);
  if (amount == null) return null;
  const category =
    typeof txn.extra?.category === "string"
      ? safeProviderMessage(txn.extra.category)
      : null;
  const merchant =
    typeof txn.payee === "string" && txn.payee.trim()
      ? safeProviderMessage(txn.payee)
      : typeof txn.extra?.merchant === "string"
        ? safeProviderMessage(txn.extra.merchant)
        : null;
  const postedDate = isoDate(txn.posted || txn.transacted_at, now);
  const authorizedDate = txn.transacted_at ? isoDate(txn.transacted_at, now) : null;
  return {
    externalId: namespacedTransactionId(secret.scopeKey, account.id, txn.id),
    accountExternalId: namespacedAccountId(secret.scopeKey, account.id),
    // SimpleFIN: positive = deposit, negative = outflow — already canonical.
    amountMinor: amount,
    currency: normalizedCurrency(account.currency),
    date: postedDate,
    authorizedDate,
    name: safeProviderMessage(txn.description ?? txn.payee ?? txn.memo ?? "Transaction") || "Transaction",
    merchant,
    pending: txn.pending === true || txn.posted === 0,
    categoryHint: category,
    categoryPath: category,
    personalFinanceCategory: null,
  };
}

function validateAccountSet(raw: unknown): SimpleFinAccountSet {
  if (!raw || typeof raw !== "object") throw new Error("SimpleFIN returned an invalid response.");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.accounts)) throw new Error("SimpleFIN response did not include an accounts list.");
  return obj as unknown as SimpleFinAccountSet;
}

function relevantAccounts(set: SimpleFinAccountSet, remoteConnectionId: string): SimpleFinAccount[] {
  return set.accounts.filter((account) => remoteConnectionIdFor(account) === remoteConnectionId);
}

function checkErrors(set: SimpleFinAccountSet, remoteConnectionId?: string): void {
  const structured = (set.errlist ?? []).filter((e) => !e.conn_id || !remoteConnectionId || e.conn_id === remoteConnectionId);
  const legacy = (set.errors ?? []).map((msg) => ({ code: "gen.", msg }));
  const errors = [...structured, ...legacy];
  if (errors.length === 0) return;

  const auth = errors.find((e) => e.code === "gen.auth" || e.code === "con.auth");
  if (auth) {
    throw new Error(`SimpleFIN connection needs reauthentication: ${safeProviderMessage(auth.msg) || "authentication failed"}`);
  }
  const incomplete = errors.find((e) => e.code === "act.missingdata" || e.code === "act.failed");
  if (incomplete) {
    throw new Error(`SimpleFIN returned incomplete account data: ${safeProviderMessage(incomplete.msg) || incomplete.code}`);
  }
  const first = errors[0];
  throw new Error(`SimpleFIN reported an error: ${safeProviderMessage(first.msg) || first.code || "unknown error"}`);
}

async function readResponseJson(response: Response): Promise<SimpleFinAccountSet> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("SimpleFIN returned a non-JSON response.");
  }
  return validateAccountSet(raw);
}

export function createSimpleFinProvider(options: SimpleFinProviderOptions = {}): SimpleFinProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const initialLookbackDays = options.initialLookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const overlapDays = options.overlapDays ?? DEFAULT_OVERLAP_DAYS;
  const resolveHost =
    options.resolveHost ??
    (options.fetchImpl
      ? async () => []
      : async (hostname: string) => {
          const rows = await lookup(hostname, { all: true, verbatim: true });
          return rows.map((row) => row.address);
        });

  async function assertSafeRemoteUrl(url: URL, label: string): Promise<void> {
    const addresses = await resolveHost(url.hostname);
    if (addresses.some(isUnsafeResolvedAddress)) {
      throw new Error(`${label} resolves to a blocked local, private, or link-local address.`);
    }
  }

  async function claimSetupToken(setupToken: string): Promise<string> {
    const claimUrl = decodeSimpleFinSetupToken(setupToken);
    const claimParsed = new URL(claimUrl);
    await assertSafeRemoteUrl(claimParsed, "SimpleFIN claim URL");
    let response: Response;
    try {
      response = await fetchImpl(claimUrl, {
        method: "POST",
        headers: { "Content-Length": "0", Accept: "text/plain" },
        redirect: "error",
      });
    } catch {
      throw new Error("Could not reach the SimpleFIN claim endpoint.");
    }
    if (response.status === 403) {
      throw new Error("This SimpleFIN setup token has already been claimed or may be compromised. Generate a new setup token.");
    }
    if (!response.ok) throw new Error(`SimpleFIN rejected the setup token (HTTP ${response.status}).`);
    const accessUrl = (await response.text()).trim();
    assertHttpsUrl(accessUrl, "SimpleFIN access URL");
    return accessUrl;
  }

  async function fetchAccountSet(
    accessUrl: string,
    input: {
      startDate?: number;
      endDate?: number;
      pending?: boolean;
      balancesOnly?: boolean;
    } = {},
  ): Promise<SimpleFinAccountSet> {
    const { baseUrl, authorization } = splitSimpleFinAccessUrl(accessUrl);
    const baseParsed = new URL(baseUrl);
    await assertSafeRemoteUrl(baseParsed, "SimpleFIN access URL");
    const makeUrl = (version2: boolean) => {
      const url = new URL(`${baseUrl}/accounts`);
      if (version2) url.searchParams.set("version", "2");
      if (input.startDate != null) url.searchParams.set("start-date", String(Math.max(0, Math.floor(input.startDate))));
      if (input.endDate != null) url.searchParams.set("end-date", String(Math.max(0, Math.floor(input.endDate))));
      if (input.pending) url.searchParams.set("pending", "1");
      if (input.balancesOnly && version2) url.searchParams.set("balances-only", "1");
      return url;
    };
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authorization) headers.Authorization = authorization;

    let response: Response;
    try {
      response = await fetchImpl(makeUrl(true), { method: "GET", headers, redirect: "error" });
      // Some v1-only servers reject the v2 query parameter. Retry without v2
      // features rather than excluding valid independent SimpleFIN servers.
      if (response.status === 400 || response.status === 404 || response.status === 422) {
        response = await fetchImpl(makeUrl(false), { method: "GET", headers, redirect: "error" });
      }
    } catch {
      throw new Error("Could not reach the SimpleFIN server.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("SimpleFIN rejected the stored access URL. Generate a new setup token and reconnect.");
    }
    if (response.status === 402) {
      throw new Error("SimpleFIN reports that the connection requires payment or subscription renewal.");
    }
    if (!response.ok) throw new Error(`SimpleFIN returned HTTP ${response.status}.`);
    return readResponseJson(response);
  }

  async function discoverConnections(accessUrl: string): Promise<SimpleFinConnectionDescriptor[]> {
    const set = await fetchAccountSet(accessUrl, { balancesOnly: true });
    checkErrors(set);

    const byRemote = new Map<string, SimpleFinAccount[]>();
    for (const account of set.accounts) {
      const remote = remoteConnectionIdFor(account);
      const rows = byRemote.get(remote) ?? [];
      rows.push(account);
      byRemote.set(remote, rows);
    }
    const v2ById = new Map((set.connections ?? []).map((c) => [c.conn_id, c]));
    const out: SimpleFinConnectionDescriptor[] = [];
    for (const [remoteConnectionId, accounts] of byRemote) {
      const connection = v2ById.get(remoteConnectionId);
      const sample = accounts[0];
      const scopeKey = simpleFinScopeKey(accessUrl, remoteConnectionId);
      const v1Org = sample?.org;
      out.push({
        remoteConnectionId,
        externalConnectionId: scopeKey,
        scopeKey,
        institutionExternalId:
          connection?.org_id ??
          connection?.org_url ??
          v1Org?.domain ??
          v1Org?.id ??
          v1Org?.url ??
          v1Org?.["sfin-url"] ??
          null,
        institutionName:
          safeProviderMessage(connection?.org_name ?? connection?.name ?? v1Org?.name ?? v1Org?.domain ?? "SimpleFIN") ||
          "SimpleFIN",
        accountCount: accounts.length,
      });
    }
    return out;
  }

  return {
    descriptor: {
      kind: "simplefin",
      displayName: "SimpleFIN",
      capabilities: new Set(["accounts", "balances", "transactions", "refresh", "reauth"]),
    },
    claimSetupToken,
    discoverConnections,

    async listAccounts(connectionSecret) {
      const secret = connectionSecret as SimpleFinConnectionSecret;
      if (!secret?.accessUrl || !secret.remoteConnectionId || !secret.scopeKey) {
        throw new Error("Invalid SimpleFIN connection secret.");
      }
      const set = await fetchAccountSet(secret.accessUrl, { balancesOnly: true });
      checkErrors(set, secret.remoteConnectionId);
      return relevantAccounts(set, secret.remoteConnectionId).map((a) => mapAccount(a, secret));
    },

    async syncTransactions(connectionSecret, cursor): Promise<ProviderTransactionSync> {
      const secret = connectionSecret as SimpleFinConnectionSecret;
      if (!secret?.accessUrl || !secret.remoteConnectionId || !secret.scopeKey) {
        throw new Error("Invalid SimpleFIN connection secret.");
      }
      const nowDate = now();
      const nowSeconds = Math.floor(nowDate.getTime() / 1000);
      const parsedCursor =
        cursor.value?.startsWith(CURSOR_PREFIX)
          ? Number.parseInt(cursor.value.slice(CURSOR_PREFIX.length), 10)
          : NaN;
      const startDate = Number.isFinite(parsedCursor)
        ? parsedCursor
        : nowSeconds - initialLookbackDays * DAY_SECONDS;
      // end-date is exclusive in SimpleFIN. Give today's pending/posted rows a
      // full UTC-day boundary rather than accidentally clipping late entries.
      const endDate = Math.floor(
        Date.UTC(
          nowDate.getUTCFullYear(),
          nowDate.getUTCMonth(),
          nowDate.getUTCDate() + 1,
        ) / 1000,
      );
      const set = await fetchAccountSet(secret.accessUrl, {
        startDate,
        endDate,
        pending: true,
      });
      checkErrors(set, secret.remoteConnectionId);
      const added: ProviderTransaction[] = [];
      for (const account of relevantAccounts(set, secret.remoteConnectionId)) {
        for (const txn of account.transactions ?? []) {
          const mapped = mapTransaction(account, txn, secret, nowDate);
          if (mapped) added.push(mapped);
        }
      }
      return {
        added,
        modified: [],
        removedExternalIds: [],
        // SimpleFIN has no delta cursor; overlap the next request by five days,
        // matching the current Bridge developer guidance.
        nextCursor: {
          value: `${CURSOR_PREFIX}${Math.max(0, nowSeconds - overlapDays * DAY_SECONDS)}`,
        },
      };
    },

    async refresh() {
      // SimpleFIN is pull-based. The next list/sync request reads the latest
      // data available from the server.
    },

    async revoke() {
      // The SimpleFIN protocol does not expose an application-side revoke
      // endpoint. Users revoke the Access URL at their SimpleFIN server/Bridge.
    },
  };
}
