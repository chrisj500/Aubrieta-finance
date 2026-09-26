import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type LinkTokenCreateRequest,
  type TransactionsSyncRequest,
} from "plaid";
import {
  normalizePlaidAccountType,
  type PlaidAccount,
  PlaidClient,
  PlaidCreds,
  PlaidHolding,
  PlaidLiability,
  PlaidRecurringStream,
  PlaidSecurity,
  PlaidSyncResult,
  PlaidTestResult,
  PlaidTransaction,
} from "./adapter";

function cents(n: number): number {
  return Math.round(n * 100);
}

/** Field-subset shape of a Plaid SDK Transaction we read when mapping into our
 *  domain PlaidTransaction. Mirrors Plaid's Transaction fields exactly. */
interface PlaidRawTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  category: string[] | null;
  personal_finance_category: { detailed: string } | null;
  pending: boolean;
}

function clientFor(creds: PlaidCreds): PlaidApi {
  const config = new Configuration({
    basePath: PlaidEnvironments[creds.environment],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": creds.clientId,
        "PLAID-SECRET": creds.secret,
      },
    },
  });
  return new PlaidApi(config);
}

/** The subset of Plaid's thrown Axios error we read. Caught from a try/catch
 *  so the value is `unknown` by construction; we only ever read these fields. */
interface PlaidErrorPayload {
  response?: { data?: { error_code?: string; error_message?: string } };
  message?: string;
}

function mapError(e: unknown): PlaidTestResult {
  // SAFETY: e is an unknown thrown value; we only read the optional fields
  // declared on PlaidErrorPayload and never treat the cast as anything richer.
  const err = e as PlaidErrorPayload;
  const code = err.response?.data?.error_code;
  const detail = err.response?.data?.error_message || err.message || "Unknown Plaid error.";
  switch (code) {
    case "INVALID_API_KEYS":
    case "INVALID_CLIENT_ID":
      return { ok: false, message: "Those Plaid keys look invalid — double-check client_id and secret." };
    case "INVALID_INPUT":
      return { ok: false, message: `Plaid rejected the input (${detail}) — check the environment matches your keys.` };
    case "RATE_LIMIT_EXCEEDED":
      return { ok: false, message: "Plaid rate limit hit — try again in a minute." };
    case "NOT_IMPLEMENTED":
      return { ok: false, message: "That feature isn't available in this environment yet." };
    default:
      return { ok: false, message: `Plaid error: ${code ?? "unknown"} — ${detail}` };
  }
}

export const realPlaidClient: PlaidClient = {
  async createLinkToken(creds, clientUserId, accessToken) {
    const client = clientFor(creds);
    const req: LinkTokenCreateRequest = {
      client_name: "Aubrieta",
      language: "en",
      country_codes: [CountryCode.Us],
      user: { client_user_id: clientUserId },
      // Update mode re-authenticates an existing Item; Plaid recommends
      // omitting products there. For a new Item, Transactions remains the
      // required product while Liabilities is consented without restricting
      // institution availability.
      ...(accessToken
        ? { access_token: accessToken }
        : {
            products: [Products.Transactions],
            additional_consented_products: [Products.Liabilities, Products.Investments],
            transactions: { days_requested: 730 },
          }),
    };
    const res = await client.linkTokenCreate(req);
    return res.data.link_token;
  },

  async exchangePublicToken(creds, publicToken) {
    const client = clientFor(creds);
    const res = await client.itemPublicTokenExchange({ public_token: publicToken });
    return { accessToken: res.data.access_token, itemId: res.data.item_id };
  },

  async getAccounts(creds, accessToken) {
    const client = clientFor(creds);
    const res = await client.accountsGet({ access_token: accessToken });
    return res.data.accounts.map((a): PlaidAccount => ({
      id: a.account_id,
      name: a.name,
      officialName: a.official_name ?? null,
      type: normalizePlaidAccountType(a.type, a.subtype),
      subtype: a.subtype ?? null,
      mask: a.mask ?? null,
      currentBalanceCents: a.balances.current !== null && a.balances.current !== undefined ? cents(a.balances.current) : null,
      availableBalanceCents: a.balances.available !== null && a.balances.available !== undefined ? cents(a.balances.available) : null,
      currency: a.balances.iso_currency_code ?? "USD",
    }));
  },

  async syncTransactions(creds, accessToken, cursor) {
    const client = clientFor(creds);
    const added: PlaidTransaction[] = [];
    const modified: PlaidTransaction[] = [];
    const removed: PlaidSyncResult["removed"] = [];
    let nextCursor = cursor ?? null;
    let hasMore = true;

    while (hasMore) {
      const req: TransactionsSyncRequest = { access_token: accessToken };
      if (nextCursor) req.cursor = nextCursor;
      const res = await client.transactionsSync(req);
      const data = res.data;

      // SAFETY: t is a Plaid SDK Transaction; PlaidRawTransaction mirrors the
      // exact fields we read from it, so the cast is a field-subset narrowing.
      const map = (t: PlaidRawTransaction): PlaidTransaction => ({
        id: t.transaction_id,
        accountId: t.account_id,
        amountCents: cents(t.amount),
        date: t.date,
        authorizedDate: t.authorized_date,
        name: t.name,
        merchantName: t.merchant_name,
        categoryPath: t.category ? t.category.join("|") : null,
        personalFinanceCategory: t.personal_finance_category?.detailed ?? null,
        pending: t.pending,
      });

      for (const t of data.added) {
        // SAFETY: cast Plaid SDK Transaction to our read shape (field-subset)
        added.push(map(t as PlaidRawTransaction));
      }
      for (const t of data.modified) {
        // SAFETY: cast Plaid SDK Transaction to our read shape (field-subset)
        modified.push(map(t as PlaidRawTransaction));
      }
      for (const t of data.removed) removed.push({ transactionId: t.transaction_id });

      nextCursor = data.next_cursor;
      hasMore = data.has_more;
      if (added.length + modified.length > 100_000) break; // safety
    }

    return { added, modified, removed, nextCursor, hasMore: false };
  },

  async getLiabilities(creds, accessToken) {
    const client = clientFor(creds);
    const res = await client.liabilitiesGet({ access_token: accessToken });
    const out: PlaidLiability[] = [];
    const liabilities = res.data.liabilities;

    for (const credit of liabilities.credit ?? []) {
      if (!credit.account_id) continue;
      const aprs = credit.aprs ?? [];
      const purchaseApr = aprs.find((a) => a.apr_type === "purchase_apr") ?? aprs[0];
      out.push({
        accountId: credit.account_id,
        kind: "credit_card",
        nextPaymentDueDate: credit.next_payment_due_date ?? null,
        minimumPaymentCents: credit.minimum_payment_amount == null ? null : cents(credit.minimum_payment_amount),
        statementBalanceCents: credit.last_statement_balance == null ? null : cents(credit.last_statement_balance),
        statementDate: credit.last_statement_issue_date ?? null,
        nextMonthlyPaymentCents: null,
        aprBps: purchaseApr?.apr_percentage == null ? null : Math.round(purchaseApr.apr_percentage * 100),
        lastPaymentAmountCents: credit.last_payment_amount == null ? null : cents(credit.last_payment_amount),
        lastPaymentDate: credit.last_payment_date ?? null,
        rawStatus: credit.is_overdue == null ? null : credit.is_overdue ? "overdue" : "current",
      });
    }

    for (const mortgage of liabilities.mortgage ?? []) {
      out.push({
        accountId: mortgage.account_id,
        kind: "mortgage",
        nextPaymentDueDate: mortgage.next_payment_due_date ?? null,
        minimumPaymentCents: null,
        statementBalanceCents: null,
        statementDate: null,
        nextMonthlyPaymentCents: mortgage.next_monthly_payment == null ? null : cents(mortgage.next_monthly_payment),
        // Plaid exposes mortgage interest rate percentage rather than APR.
        aprBps: mortgage.interest_rate?.percentage == null ? null : Math.round(mortgage.interest_rate.percentage * 100),
        lastPaymentAmountCents: mortgage.last_payment_amount == null ? null : cents(mortgage.last_payment_amount),
        lastPaymentDate: mortgage.last_payment_date ?? null,
        rawStatus: mortgage.past_due_amount && mortgage.past_due_amount > 0 ? "past_due" : "current",
      });
    }

    for (const student of liabilities.student ?? []) {
      if (!student.account_id) continue;
      out.push({
        accountId: student.account_id,
        kind: "student_loan",
        nextPaymentDueDate: student.next_payment_due_date ?? null,
        minimumPaymentCents: student.minimum_payment_amount == null ? null : cents(student.minimum_payment_amount),
        statementBalanceCents: student.last_statement_balance == null ? null : cents(student.last_statement_balance),
        statementDate: student.last_statement_issue_date ?? null,
        nextMonthlyPaymentCents: null,
        aprBps: student.interest_rate_percentage == null ? null : Math.round(student.interest_rate_percentage * 100),
        lastPaymentAmountCents: student.last_payment_amount == null ? null : cents(student.last_payment_amount),
        lastPaymentDate: student.last_payment_date ?? null,
        rawStatus: student.loan_status?.type ?? (student.is_overdue ? "overdue" : "current"),
      });
    }

    return out;
  },

  async getInvestments(creds, accessToken) {
    const client = clientFor(creds);
    const res = await client.investmentsHoldingsGet({ access_token: accessToken });
    type RawSecurity = {
      security_id: string;
      name: string | null;
      ticker_symbol: string | null;
      isin: string | null;
      cusip: string | null;
      type: string | null;
      iso_currency_code: string | null;
    };
    type RawHolding = {
      account_id: string;
      security_id: string;
      quantity: number;
      institution_price: number | null;
      institution_value: number | null;
      cost_basis: number | null;
      iso_currency_code: string | null;
    };
    const securities = (res.data.securities as unknown as RawSecurity[]).map((s): PlaidSecurity => ({
      id: s.security_id,
      name: s.name ?? s.ticker_symbol ?? "Unknown security",
      ticker: s.ticker_symbol ?? null,
      isin: s.isin ?? null,
      cusip: s.cusip ?? null,
      type: s.type ?? null,
      currency: s.iso_currency_code ?? "USD",
    }));
    const holdings = (res.data.holdings as unknown as RawHolding[]).map((h): PlaidHolding => ({
      accountId: h.account_id,
      securityId: h.security_id,
      quantity: h.quantity,
      institutionPriceCents: h.institution_price == null ? null : cents(h.institution_price),
      institutionValueCents: h.institution_value == null ? null : cents(h.institution_value),
      costBasisCents: h.cost_basis == null ? null : cents(h.cost_basis),
      currency: h.iso_currency_code ?? "USD",
    }));
    return { securities, holdings };
  },

  async getRecurringStreams(creds, accessToken) {
    const client = clientFor(creds);
    const res = await client.transactionsRecurringGet({
      access_token: accessToken,
    });
    type RawStream = {
      stream_id: string;
      account_id: string;
      description: string;
      merchant_name?: string | null;
      frequency?: string | null;
      average_amount?: { amount?: number | null } | number | null;
      last_amount?: { amount?: number | null } | number | null;
      last_date?: string | null;
      predicted_next_date?: string | null;
      status?: string | null;
    };
    const map = (
      stream: RawStream,
      direction: "inflow" | "outflow",
    ): PlaidRecurringStream => {
      const amountValue = (
        value: RawStream["average_amount"] | RawStream["last_amount"],
      ): number | null => {
        if (typeof value === "number") return cents(value);
        if (value && typeof value === "object" && typeof value.amount === "number") {
          return cents(value.amount);
        }
        return null;
      };
      const freq = (stream.frequency ?? "").toLowerCase();
      const cadence: PlaidRecurringStream["cadence"] =
        freq.includes("week") && !freq.includes("bi")
          ? "weekly"
          : freq.includes("biweekly") || freq.includes("semi_month")
            ? "biweekly"
            : freq.includes("month") && !freq.includes("quarter")
              ? "monthly"
              : freq.includes("quarter")
                ? "quarterly"
                : freq.includes("year")
                  ? "yearly"
                  : "unknown";
      return {
        id: stream.stream_id,
        accountId: stream.account_id,
        direction,
        merchantName: stream.merchant_name ?? null,
        description: stream.description,
        cadence,
        averageAmountCents: amountValue(stream.average_amount),
        lastAmountCents: amountValue(stream.last_amount),
        lastDate: stream.last_date ?? null,
        nextExpectedDate: stream.predicted_next_date ?? null,
        active: !["MATURED", "INACTIVE"].includes((stream.status ?? "").toUpperCase()),
      };
    };

    const data = res.data as unknown as {
      inflow_streams?: RawStream[];
      outflow_streams?: RawStream[];
    };
    return [
      ...(data.inflow_streams ?? []).map((s) => map(s, "inflow")),
      ...(data.outflow_streams ?? []).map((s) => map(s, "outflow")),
    ];
  },

  async removeItem(creds, accessToken) {
    const client = clientFor(creds);
    await client.itemRemove({ access_token: accessToken });
  },

  async getTransactions(creds, accessToken, start, end) {
    const client = clientFor(creds);
    const out: PlaidTransaction[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const res = await client.transactionsGet({
        access_token: accessToken,
        start_date: start,
        end_date: end,
        options: { offset, count: 500 },
      });
      // SAFETY: t is a Plaid SDK Transaction; PlaidRawTransaction mirrors the
      // exact fields we read from it, so the cast is a field-subset narrowing.
      const map = (t: PlaidRawTransaction): PlaidTransaction => ({
        id: t.transaction_id,
        accountId: t.account_id,
        amountCents: cents(t.amount),
        date: t.date,
        authorizedDate: t.authorized_date,
        name: t.name,
        merchantName: t.merchant_name,
        categoryPath: t.category ? t.category.join("|") : null,
        personalFinanceCategory: t.personal_finance_category?.detailed ?? null,
        pending: t.pending,
      });
      for (const t of res.data.transactions) {
        // SAFETY: cast Plaid SDK Transaction to our read shape (field-subset)
        out.push(map(t as PlaidRawTransaction));
      }
      // SAFETY: TransactionsGetResponse has no has_more field; read the raw pagination flag only when a full page (500) returned, so the single cast to {has_more?} is safe.
      hasMore = res.data.transactions.length === 500 && (res.data as { has_more?: boolean }).has_more === true;
      offset += res.data.transactions.length;
      if (res.data.transactions.length === 0) break;
    }
    return out;
  },

  async testCredentials(creds) {
    try {
      // Cheapest real call: create a link token in the target environment.
      await this.createLinkToken(creds, "open-finance-key-test");
      return { ok: true };
    } catch (e) {
      return mapError(e);
    }
  },
};
