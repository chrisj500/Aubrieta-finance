/**
 * Aubrieta provider-neutral financial aggregation contracts.
 *
 * IMPORTANT:
 * Domain code must depend on these normalized shapes, never directly on
 * Plaid/Teller/SimpleFIN SDK types.
 */

export type ProviderKind = "plaid" | "teller" | "simplefin" | "file";

export type ProviderCapability =
  | "accounts"
  | "balances"
  | "transactions"
  | "liabilities"
  | "investments"
  | "statements"
  | "recurring"
  | "webhooks"
  | "refresh"
  | "reauth";

export interface ProviderDescriptor {
  kind: ProviderKind;
  displayName: string;
  capabilities: ReadonlySet<ProviderCapability>;
}

export type NormalizedAccountType =
  | "checking"
  | "savings"
  | "cash"
  | "credit_card"
  | "mortgage"
  | "loan"
  | "investment"
  | "property"
  | "other";

export interface ProviderAccount {
  externalId: string;
  institutionExternalId?: string | null;
  name: string;
  officialName?: string | null;
  type: NormalizedAccountType;
  subtype?: string | null;
  mask?: string | null;
  currency: string;
  currentBalanceMinor?: number | null;
  availableBalanceMinor?: number | null;
}

export interface ProviderTransaction {
  externalId: string;
  accountExternalId: string;
  amountMinor: number;
  currency: string;
  date: string;
  authorizedDate?: string | null;
  name: string;
  merchant?: string | null;
  pending: boolean;
  categoryHint?: string | null;
  pendingExternalId?: string | null;
}

export interface ProviderLiability {
  accountExternalId: string;
  kind: "credit_card" | "mortgage" | "student_loan" | "loan" | "other";
  nextPaymentDueDate?: string | null;
  minimumPaymentMinor?: number | null;
  statementBalanceMinor?: number | null;
  statementDate?: string | null;
  nextMonthlyPaymentMinor?: number | null;
  aprBps?: number | null;
  lastPaymentAmountMinor?: number | null;
  lastPaymentDate?: string | null;
  rawStatus?: string | null;
}

export interface ProviderSecurity {
  externalId: string;
  name: string;
  ticker?: string | null;
  isin?: string | null;
  cusip?: string | null;
  type?: string | null;
  currency: string;
}

export interface ProviderHolding {
  accountExternalId: string;
  securityExternalId: string;
  quantity: number;
  institutionPriceMinor?: number | null;
  institutionValueMinor?: number | null;
  costBasisMinor?: number | null;
  currency: string;
}

export interface ProviderRecurringStream {
  externalId: string;
  accountExternalId: string;
  direction: "inflow" | "outflow";
  merchant?: string | null;
  description: string;
  cadence?: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "unknown";
  averageAmountMinor?: number | null;
  lastAmountMinor?: number | null;
  lastDate?: string | null;
  nextExpectedDate?: string | null;
  active: boolean;
}

export interface ProviderSyncCursor {
  value: string | null;
}

export interface ProviderTransactionSync {
  accounts?: ProviderAccount[];
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removedExternalIds: string[];
  nextCursor: ProviderSyncCursor;
}

export interface FinancialProvider {
  readonly descriptor: ProviderDescriptor;

  listAccounts(connectionSecret: unknown): Promise<ProviderAccount[]>;

  syncTransactions?(
    connectionSecret: unknown,
    cursor: ProviderSyncCursor,
  ): Promise<ProviderTransactionSync>;

  getLiabilities?(connectionSecret: unknown): Promise<ProviderLiability[]>;

  getInvestments?(connectionSecret: unknown): Promise<{
    securities: ProviderSecurity[];
    holdings: ProviderHolding[];
  }>;

  getRecurringStreams?(connectionSecret: unknown): Promise<ProviderRecurringStream[]>;

  refresh?(connectionSecret: unknown): Promise<void>;
  revoke?(connectionSecret: unknown): Promise<void>;
}
