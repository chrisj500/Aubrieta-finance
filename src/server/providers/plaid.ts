import type { PlaidClient, PlaidCreds } from "@/server/plaid/adapter";
import type {
  FinancialProvider,
  NormalizedAccountType,
  ProviderAccount,
  ProviderLiability,
  ProviderTransaction,
  ProviderTransactionSync,
} from "./types";

export interface PlaidConnectionSecret {
  creds: PlaidCreds;
  accessToken: string;
}

function asPlaidSecret(secret: unknown): PlaidConnectionSecret {
  const s = secret as Partial<PlaidConnectionSecret> | null;
  if (!s?.creds || typeof s.accessToken !== "string") {
    throw new Error("Invalid Plaid connection secret.");
  }
  return s as PlaidConnectionSecret;
}

function normalizeAccountType(type: string, subtype: string | null): NormalizedAccountType {
  const t = type.toLowerCase();
  const s = (subtype ?? "").toLowerCase();
  if (t === "depository") {
    if (s.includes("checking")) return "checking";
    if (s.includes("savings") || s.includes("money market")) return "savings";
    return "cash";
  }
  if (t === "credit") return "credit_card";
  if (t === "investment") return "investment";
  if (t === "loan") {
    if (s.includes("mortgage")) return "mortgage";
    return "loan";
  }
  return "other";
}

function mapAccount(a: Awaited<ReturnType<PlaidClient["getAccounts"]>>[number]): ProviderAccount {
  return {
    externalId: a.id,
    name: a.name,
    officialName: a.officialName,
    type: normalizeAccountType(a.type, a.subtype),
    subtype: a.subtype,
    mask: a.mask,
    currency: a.currency,
    currentBalanceMinor: a.currentBalanceCents,
    availableBalanceMinor: a.availableBalanceCents,
  };
}

function mapTransaction(t: Awaited<ReturnType<PlaidClient["syncTransactions"]>>["added"][number]): ProviderTransaction {
  return {
    externalId: t.id,
    accountExternalId: t.accountId,
    // Canonical Aubrieta sign: positive=inflow, negative=outflow.
    // Plaid reports positive amounts as money leaving the account.
    amountMinor: -t.amountCents,
    currency: "USD",
    date: t.date,
    authorizedDate: t.authorizedDate,
    name: t.name,
    merchant: t.merchantName,
    pending: t.pending,
    categoryHint: t.personalFinanceCategory ?? t.categoryPath,
    categoryPath: t.categoryPath,
    personalFinanceCategory: t.personalFinanceCategory,
  };
}

export function createPlaidProvider(client: PlaidClient): FinancialProvider {
  return {
    descriptor: {
      kind: "plaid",
      displayName: "Plaid",
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
      const { creds, accessToken } = asPlaidSecret(connectionSecret);
      return (await client.getAccounts(creds, accessToken)).map(mapAccount);
    },

    async syncTransactions(connectionSecret, cursor): Promise<ProviderTransactionSync> {
      const { creds, accessToken } = asPlaidSecret(connectionSecret);
      const added: ProviderTransaction[] = [];
      const modified: ProviderTransaction[] = [];
      const removedExternalIds: string[] = [];
      let nextCursor = cursor.value;
      let hasMore = true;
      let guard = 0;

      // PlaidClient is intentionally page-oriented for native/test clients.
      // Consume every page here so the shared sync engine stays provider-agnostic.
      while (hasMore && guard < 20) {
        guard++;
        const res = await client.syncTransactions(creds, accessToken, nextCursor);
        added.push(...res.added.map(mapTransaction));
        modified.push(...res.modified.map(mapTransaction));
        removedExternalIds.push(...res.removed.map((r) => r.transactionId));
        nextCursor = res.nextCursor;
        hasMore = res.hasMore;
      }

      return {
        added,
        modified,
        removedExternalIds,
        nextCursor: { value: nextCursor },
      };
    },

    async getLiabilities(connectionSecret): Promise<ProviderLiability[]> {
      const { creds, accessToken } = asPlaidSecret(connectionSecret);
      if (!client.getLiabilities) return [];
      return (await client.getLiabilities(creds, accessToken)).map((l) => ({
        accountExternalId: l.accountId,
        kind: l.kind,
        nextPaymentDueDate: l.nextPaymentDueDate,
        minimumPaymentMinor: l.minimumPaymentCents,
        statementBalanceMinor: l.statementBalanceCents,
        statementDate: l.statementDate,
        nextMonthlyPaymentMinor: l.nextMonthlyPaymentCents,
        aprBps: l.aprBps,
        lastPaymentAmountMinor: l.lastPaymentAmountCents,
        lastPaymentDate: l.lastPaymentDate,
        rawStatus: l.rawStatus,
      }));
    },

    async refresh() {
      // Transactions and liabilities are refreshed by their product endpoints.
      // This capability exists so other providers can expose an explicit refresh.
    },

    async revoke(connectionSecret) {
      const { creds, accessToken } = asPlaidSecret(connectionSecret);
      await client.removeItem(creds, accessToken);
    },
  };
}

/** Converts Aubrieta's canonical type back to the legacy account.type values
 * used by the existing UI while the broader account-domain migration proceeds. */
export function legacyAccountType(type: NormalizedAccountType): string {
  switch (type) {
    case "checking":
    case "savings":
    case "cash":
      return "depository";
    case "credit_card":
      return "credit";
    case "mortgage":
    case "loan":
      return "loan";
    case "investment":
      return "investment";
    default:
      return "other";
  }
}
