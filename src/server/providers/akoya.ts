import type {
  FinancialProvider,
  NormalizedAccountType,
  ProviderAccount,
  ProviderLiability,
  ProviderTransaction,
  ProviderTransactionSync,
} from "./types";

const DAY_MS = 86_400_000;
const INITIAL_LOOKBACK_DAYS = 730;
const OVERLAP_DAYS = 5;
const PAGE_SIZE = 50;
const CURSOR_PREFIX = "akoya1:";

export type AkoyaEnvironment = "sandbox" | "production";
export type AkoyaInteractionType = "USER" | "BATCH";

export interface AkoyaConfig {
  environment: AkoyaEnvironment;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AkoyaTokens {
  idToken: string;
  refreshToken: string;
  expiresAt: string;
  grantId: string;
}

export interface AkoyaConnectionSecret {
  config: AkoyaConfig;
  providerId: string;
  tokens: AkoyaTokens;
  interactionType?: AkoyaInteractionType;
  lastAccessAt?: string;
}

interface FdxAccount {
  accountId?: string;
  accountType?: string;
  accountCategory?: string;
  accountNumberDisplay?: string;
  displayName?: string;
  nickname?: string;
  productName?: string;
  description?: string;
  status?: string;
  balanceType?: string;
  currency?: { currencyCode?: string };
  currentBalance?: number;
  availableBalance?: number;
  principalBalance?: number;
  currentValue?: number;
  availableCashBalance?: number;
  minimumPaymentAmount?: number;
  nextPaymentAmount?: number;
  nextPaymentDate?: string;
  lastStmtBalance?: number;
  lastStmtDate?: string;
  purchasesApr?: number;
  interestRate?: number;
  lastPaymentAmount?: number;
  lastPaymentDate?: string;
}

interface FdxTransaction {
  accountId?: string;
  transactionId?: string;
  amount?: number;
  debitCreditMemo?: string;
  description?: string;
  memo?: string;
  payee?: string;
  category?: string;
  subCategory?: string;
  status?: string;
  postedTimestamp?: string;
  transactionTimestamp?: string;
  transactionType?: string;
}

interface AccountEnvelope {
  [key: string]: FdxAccount | undefined;
}

interface TransactionEnvelope {
  [key: string]: FdxTransaction | undefined;
}

interface AccountsResponse {
  accounts?: AccountEnvelope[];
}

interface TransactionsResponse {
  transactions?: TransactionEnvelope[];
  links?: {
    next?: { href?: string | null };
  };
}

function productsBase(environment: AkoyaEnvironment): string {
  return environment === "sandbox"
    ? "https://sandbox-products.ddp.akoya.com"
    : "https://products.ddp.akoya.com";
}

function idpBase(environment: AkoyaEnvironment): string {
  return environment === "sandbox"
    ? "https://sandbox-idp.ddp.akoya.com"
    : "https://idp.ddp.akoya.com";
}

export function akoyaAuthorizationUrl(input: {
  config: AkoyaConfig;
  providerId: string;
  state: string;
}): string {
  const url = new URL(`${idpBase(input.config.environment)}/auth`);
  url.searchParams.set("connector", input.providerId);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile offline_access");
  url.searchParams.set("state", input.state);
  return url.toString();
}

function normalizeCurrency(account: FdxAccount): string {
  const value = account.currency?.currencyCode?.trim() || "USD";
  return /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : "USD";
}

function inferAccountType(account: FdxAccount): NormalizedAccountType {
  const category = (account.accountCategory ?? "").toUpperCase();
  const type = (account.accountType ?? "").toUpperCase();
  const name = [
    account.productName,
    account.nickname,
    account.displayName,
    account.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  const hint = `${type} ${name}`;

  if (/CREDIT.?CARD|VISA|MASTERCARD|AMEX/.test(hint)) return "credit_card";
  if (/MORTGAGE|HELOC|HOME.?EQUITY/.test(hint)) return "mortgage";
  if (category === "LOAN_ACCOUNT" || /LOAN|AUTO|STUDENT/.test(hint)) return "loan";
  if (category === "INVESTMENT_ACCOUNT" || /401K|403B|IRA|BROKER|INVEST/.test(hint)) {
    return "investment";
  }
  if (/SAVINGS|MONEY.?MARKET|CERTIFICATE|\bCD\b/.test(hint)) return "savings";
  if (/CHECKING|CHECK|CURRENT|DDA/.test(hint)) return "checking";
  if (category === "LOC_ACCOUNT") return "credit_card";
  if (category === "DEPOSIT_ACCOUNT") return "cash";
  return "other";
}

function unwrapAccount(envelope: AccountEnvelope): FdxAccount | null {
  for (const value of Object.values(envelope)) {
    if (value && typeof value === "object" && typeof value.accountId === "string") return value;
  }
  return null;
}

function unwrapTransaction(envelope: TransactionEnvelope): FdxTransaction | null {
  for (const value of Object.values(envelope)) {
    if (value && typeof value === "object" && typeof value.transactionId === "string") return value;
  }
  return null;
}

function minor(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100);
}

function accountName(account: FdxAccount): string {
  return (
    account.nickname?.trim() ||
    account.displayName?.trim() ||
    account.productName?.trim() ||
    account.description?.trim() ||
    account.accountNumberDisplay?.trim() ||
    account.accountType?.trim() ||
    "Akoya account"
  );
}

function currentBalanceMagnitude(account: FdxAccount, type: NormalizedAccountType): number | null {
  const raw =
    type === "investment"
      ? account.currentValue ?? account.availableCashBalance
      : type === "mortgage" || type === "loan"
        ? account.principalBalance ?? account.currentBalance
        : account.currentBalance ?? account.principalBalance;
  const value = minor(raw);
  if (value == null) return null;
  return type === "credit_card" || type === "mortgage" || type === "loan"
    ? Math.abs(value)
    : value;
}

function availableBalanceMagnitude(account: FdxAccount, type: NormalizedAccountType): number | null {
  const value = minor(
    type === "investment" ? account.availableCashBalance : account.availableBalance,
  );
  if (value == null) return null;
  return type === "credit_card" || type === "mortgage" || type === "loan"
    ? Math.abs(value)
    : value;
}

function accountExternalId(providerId: string, accountId: string): string {
  return `${providerId}:a:${accountId}`;
}

function transactionExternalId(providerId: string, accountId: string, transactionId: string): string {
  return `${providerId}:a:${accountId}:t:${transactionId}`;
}

function safeDate(raw?: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function toProviderAccount(providerId: string, account: FdxAccount): ProviderAccount | null {
  if (!account.accountId) return null;
  const type = inferAccountType(account);
  return {
    externalId: accountExternalId(providerId, account.accountId),
    institutionExternalId: providerId,
    name: accountName(account),
    officialName: account.productName ?? account.displayName ?? null,
    type,
    subtype: account.accountType ?? null,
    mask: account.accountNumberDisplay ?? null,
    currency: normalizeCurrency(account),
    currentBalanceMinor: currentBalanceMagnitude(account, type),
    availableBalanceMinor: availableBalanceMagnitude(account, type),
  };
}

function toLiability(providerId: string, account: FdxAccount): ProviderLiability | null {
  if (!account.accountId) return null;
  const type = inferAccountType(account);
  if (!["credit_card", "mortgage", "loan"].includes(type)) return null;
  const apr = account.purchasesApr ?? account.interestRate;
  return {
    accountExternalId: accountExternalId(providerId, account.accountId),
    kind:
      type === "credit_card"
        ? "credit_card"
        : type === "mortgage"
          ? "mortgage"
          : "loan",
    nextPaymentDueDate: safeDate(account.nextPaymentDate),
    minimumPaymentMinor: minor(account.minimumPaymentAmount),
    statementBalanceMinor: minor(account.lastStmtBalance),
    statementDate: safeDate(account.lastStmtDate),
    nextMonthlyPaymentMinor: minor(account.nextPaymentAmount),
    aprBps: apr == null || !Number.isFinite(apr) ? null : Math.round(apr * 100),
    lastPaymentAmountMinor: minor(account.lastPaymentAmount),
    lastPaymentDate: safeDate(account.lastPaymentDate),
    rawStatus: account.status ?? null,
  };
}

function toProviderTransaction(
  providerId: string,
  accountCurrency: string,
  txn: FdxTransaction,
): ProviderTransaction | null {
  if (!txn.accountId || !txn.transactionId || txn.amount == null || !Number.isFinite(txn.amount)) {
    return null;
  }
  const rawDate = txn.postedTimestamp ?? txn.transactionTimestamp;
  const date = safeDate(rawDate);
  if (!date) return null;
  // Akoya/FDX standardized transaction amounts already carry signs. In
  // published Akoya examples, POS debits/withdrawals are negative and credits
  // are positive, matching Aubrieta's canonical convention.
  return {
    externalId: transactionExternalId(providerId, txn.accountId, txn.transactionId),
    accountExternalId: accountExternalId(providerId, txn.accountId),
    amountMinor: Math.round(txn.amount * 100),
    currency: accountCurrency,
    date,
    authorizedDate:
      txn.transactionTimestamp && txn.transactionTimestamp !== txn.postedTimestamp
        ? safeDate(txn.transactionTimestamp)
        : null,
    name: txn.description?.trim() || txn.memo?.trim() || txn.payee?.trim() || "Transaction",
    merchant: txn.payee?.trim() || null,
    pending: ["PENDING", "AUTHORIZATION", "MEMO"].includes((txn.status ?? "").toUpperCase()),
    categoryHint: txn.subCategory ?? txn.category ?? txn.transactionType ?? null,
    categoryPath: txn.category ?? null,
    personalFinanceCategory: null,
  };
}

function asSecret(secret: unknown): AkoyaConnectionSecret {
  const value = secret as Partial<AkoyaConnectionSecret> | null;
  if (
    !value?.config ||
    typeof value.providerId !== "string" ||
    !value.tokens?.idToken ||
    !value.tokens.refreshToken
  ) {
    throw new Error("Invalid Akoya connection secret.");
  }
  return value as AkoyaConnectionSecret;
}

function requestHeaders(secret: AkoyaConnectionSecret): Record<string, string> {
  return {
    Authorization: `Bearer ${secret.tokens.idToken}`,
    Accept: "application/json",
    "x-akoya-interaction-type": secret.interactionType ?? "BATCH",
    "x-akoya-last-access": secret.lastAccessAt ?? new Date().toISOString(),
    "x-akoya-intent-type": "nonpayments",
  };
}

async function akoyaJson<T>(
  secret: AkoyaConnectionSecret,
  path: string,
): Promise<T> {
  const response = await fetch(`${productsBase(secret.config.environment)}${path}`, {
    method: "GET",
    headers: requestHeaders(secret),
    redirect: "error",
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Akoya authorization needs to be refreshed or reconnected.");
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { code?: number; message?: string };
      detail = body.message ? `: ${String(body.message).slice(0, 180)}` : "";
    } catch {
      // keep status-only message
    }
    throw new Error(`Akoya returned HTTP ${response.status}${detail}`);
  }
  return response.json() as Promise<T>;
}

async function fetchBalances(secret: AkoyaConnectionSecret): Promise<FdxAccount[]> {
  const response = await akoyaJson<AccountsResponse>(
    secret,
    `/balances/v3/${encodeURIComponent(secret.providerId)}?mode=standard`,
  );
  return (response.accounts ?? [])
    .map(unwrapAccount)
    .filter((a): a is FdxAccount => Boolean(a));
}

function cursorStart(cursor: string | null, now: Date): Date {
  if (cursor?.startsWith(CURSOR_PREFIX)) {
    const millis = Number.parseInt(cursor.slice(CURSOR_PREFIX.length), 10);
    if (Number.isFinite(millis) && millis > 0) return new Date(millis);
  }
  return new Date(now.getTime() - INITIAL_LOOKBACK_DAYS * DAY_MS);
}

export function createAkoyaProvider(): FinancialProvider {
  return {
    descriptor: {
      kind: "akoya",
      displayName: "Akoya / FDX",
      capabilities: new Set([
        "accounts",
        "balances",
        "transactions",
        "liabilities",
        "refresh",
        "reauth",
      ]),
    },

    async listAccounts(connectionSecret) {
      const secret = asSecret(connectionSecret);
      const accounts = await fetchBalances(secret);
      return accounts
        .map((a) => toProviderAccount(secret.providerId, a))
        .filter((a): a is ProviderAccount => Boolean(a));
    },

    async syncTransactions(connectionSecret, cursor): Promise<ProviderTransactionSync> {
      const secret = asSecret(connectionSecret);
      const now = new Date();
      const start = cursorStart(cursor.value, now);
      const end = now;
      const accounts = await fetchBalances(secret);
      const currencyById = new Map(
        accounts
          .filter((a): a is FdxAccount & { accountId: string } => Boolean(a.accountId))
          .map((a) => [a.accountId, normalizeCurrency(a)]),
      );
      const added: ProviderTransaction[] = [];

      for (const account of accounts) {
        if (!account.accountId || account.accountCategory === "ANNUITY_ACCOUNT") continue;
        let offset = 0;
        for (let guard = 0; guard < 200; guard++) {
          const q = new URLSearchParams({
            mode: "standard",
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            offset: String(offset),
            limit: String(PAGE_SIZE),
          });
          const page = await akoyaJson<TransactionsResponse>(
            secret,
            `/transactions/v3/${encodeURIComponent(secret.providerId)}/${encodeURIComponent(account.accountId)}?${q.toString()}`,
          );
          const rows = page.transactions ?? [];
          for (const envelope of rows) {
            const raw = unwrapTransaction(envelope);
            if (!raw) continue;
            const mapped = toProviderTransaction(
              secret.providerId,
              currencyById.get(account.accountId) ?? "USD",
              raw,
            );
            if (mapped) added.push(mapped);
          }
          if (rows.length < PAGE_SIZE || !page.links?.next?.href) break;
          offset += PAGE_SIZE;
        }
      }

      return {
        added,
        modified: [],
        removedExternalIds: [],
        nextCursor: {
          value: `${CURSOR_PREFIX}${Math.max(0, now.getTime() - OVERLAP_DAYS * DAY_MS)}`,
        },
      };
    },

    async getLiabilities(connectionSecret) {
      const secret = asSecret(connectionSecret);
      const accounts = await fetchBalances(secret);
      return accounts
        .map((a) => toLiability(secret.providerId, a))
        .filter((l): l is ProviderLiability => Boolean(l));
    },

    async refresh() {
      // Token refresh is handled by the Akoya connection service before sync.
    },

    async revoke() {
      // Revocation requires client credentials and the rotating refresh token,
      // so the Akoya connection service owns it.
    },
  };
}

export async function exchangeAkoyaCode(input: {
  config: AkoyaConfig;
  code: string;
}): Promise<AkoyaTokens> {
  const url = `${idpBase(input.config.environment)}/token`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${input.config.clientId}:${input.config.clientSecret}`,
      ).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: input.config.redirectUri,
      code: input.code,
    }),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Akoya token exchange failed with HTTP ${response.status}.`);
  const body = (await response.json()) as {
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    grant_id?: string;
  };
  if (!body.id_token || !body.refresh_token) throw new Error("Akoya token response was incomplete.");
  const grantId = body.grant_id ?? decodeJwtClaim(body.id_token, "grant_id") ?? crypto.randomUUID();
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + Math.max(60, body.expires_in ?? 900) * 1000).toISOString(),
    grantId,
  };
}

export async function refreshAkoyaTokens(input: {
  config: AkoyaConfig;
  refreshToken: string;
  previousGrantId: string;
}): Promise<AkoyaTokens> {
  const response = await fetch(`${idpBase(input.config.environment)}/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
    }),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error("Akoya refresh token is no longer valid; reconnect this institution.");
  }
  const body = (await response.json()) as {
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    grant_id?: string;
  };
  if (!body.id_token || !body.refresh_token) throw new Error("Akoya refresh response was incomplete.");
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + Math.max(60, body.expires_in ?? 900) * 1000).toISOString(),
    grantId:
      body.grant_id ??
      decodeJwtClaim(body.id_token, "grant_id") ??
      input.previousGrantId,
  };
}

export async function revokeAkoyaRefreshToken(input: {
  config: AkoyaConfig;
  refreshToken: string;
}): Promise<void> {
  const response = await fetch(`${idpBase(input.config.environment)}/revoke`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      token: input.refreshToken,
      token_type_hint: "refresh_token",
    }),
    redirect: "error",
  });
  if (!response.ok && response.status !== 400) {
    throw new Error(`Akoya token revocation failed with HTTP ${response.status}.`);
  }
}

function decodeJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    return typeof json[claim] === "string" ? (json[claim] as string) : null;
  } catch {
    return null;
  }
}
