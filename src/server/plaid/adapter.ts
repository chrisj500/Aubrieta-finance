export type PlaidEnvironment = "sandbox" | "production";

export interface PlaidCreds {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
}

export function normalizePlaidAccountType(type: string | null | undefined, subtype: string | null | undefined): string {
  const t = (type ?? "").toLowerCase();
  const s = (subtype ?? "").toLowerCase();
  if (s.includes("credit card") || t === "credit") return "credit";
  if (s.includes("auto loan") || s.includes("mortgage") || t === "loan") return "loan";
  if (t === "investment" || t === "depository") return t;
  return "other";
}

export interface PlaidAccount {
  id: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currentBalanceCents: number | null;
  availableBalanceCents: number | null;
  currency: string;
}

export interface PlaidTransaction {
  id: string;
  accountId: string;
  amountCents: number; // Plaid sign: positive = money out (debit)
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  categoryPath: string | null;
  personalFinanceCategory: string | null;
  pending: boolean;
}

export interface PlaidSyncResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transactionId: string }[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PlaidRecurringStream {
  id: string;
  accountId: string;
  direction: "inflow" | "outflow";
  merchantName: string | null;
  description: string;
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "unknown";
  averageAmountCents: number | null;
  lastAmountCents: number | null;
  lastDate: string | null;
  nextExpectedDate: string | null;
  active: boolean;
}

export interface PlaidLiability {
  accountId: string;
  kind: "credit_card" | "mortgage" | "student_loan";
  nextPaymentDueDate: string | null;
  minimumPaymentCents: number | null;
  statementBalanceCents: number | null;
  statementDate: string | null;
  nextMonthlyPaymentCents: number | null;
  aprBps: number | null;
  lastPaymentAmountCents: number | null;
  lastPaymentDate: string | null;
  rawStatus: string | null;
}

/** All Plaid calls go through this interface so tests can inject a fake and
 *  the Android native plugin can implement the same surface in P8b. */
export interface PlaidClient {
  createLinkToken(creds: PlaidCreds, clientUserId: string, accessToken?: string): Promise<string>;
  exchangePublicToken(
    creds: PlaidCreds,
    publicToken: string
  ): Promise<{ accessToken: string; itemId: string }>;
  getAccounts(creds: PlaidCreds, accessToken: string): Promise<PlaidAccount[]>;
  syncTransactions(creds: PlaidCreds, accessToken: string, cursor: string | null): Promise<PlaidSyncResult>;
  /** Pull-based history fetch (transactions/get). Returns transactions in an
   *  explicit date range — used to backfill older history on an EXISTING item
   *  without deleting it (and without burning a Plaid link slot). Unlike
   *  transactions/sync, the link-time 90-day window lock does not apply. */
  getTransactions(
    creds: PlaidCreds,
    accessToken: string,
    start: string,
    end: string
  ): Promise<PlaidTransaction[]>;
  getLiabilities?(creds: PlaidCreds, accessToken: string): Promise<PlaidLiability[]>;
  getRecurringStreams?(creds: PlaidCreds, accessToken: string): Promise<PlaidRecurringStream[]>;
  removeItem(creds: PlaidCreds, accessToken: string): Promise<void>;
  testCredentials(creds: PlaidCreds): Promise<PlaidTestResult>;
}

/** Result of validating Plaid credentials: ok=true when the keys work,
 *  otherwise a user-facing explanation of what went wrong. */
export type PlaidTestResult = { ok: boolean; message?: string };
