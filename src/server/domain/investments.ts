import { getDb, type Db } from "@/server/db/registry";
import { accountReadScope } from "@/server/authz/household-access";

export interface InvestmentHoldingView {
  id: string;
  accountId: string;
  accountName: string;
  securityName: string;
  ticker: string | null;
  securityType: string | null;
  quantity: number;
  priceCents: number | null;
  valueCents: number;
  costBasisCents: number | null;
  gainCents: number | null;
  gainPct: number | null;
  currency: string;
}

export interface InvestmentAccountView {
  id: string;
  name: string;
  institutionName: string | null;
  subtype: string | null;
  balanceCents: number;
  holdingsValueCents: number;
  holdingsCount: number;
  includeInNetWorth: boolean;
}

export function createInvestmentsService(db: Db = getDb()) {
  return {
    async overview(userId: string): Promise<{
      totalValueCents: number;
      holdingsValueCents: number;
      unallocatedValueCents: number;
      totalCostBasisCents: number | null;
      totalGainCents: number | null;
      totalGainPct: number | null;
      accounts: InvestmentAccountView[];
      holdings: InvestmentHoldingView[];
    }> {
      const scope = await accountReadScope(db, userId, "a");

      const accounts = await db.all<{
        id: string;
        name: string;
        institution_name: string | null;
        subtype: string | null;
        current_balance_cents: number | null;
        include_in_net_worth: number;
      }>(
        `SELECT a.id, a.name,
                (SELECT pc.institution_name
                   FROM account_provider_refs apr
                   JOIN provider_connections pc ON pc.id = apr.connection_id
                  WHERE apr.account_id = a.id
                  LIMIT 1) AS institution_name,
                a.subtype, a.current_balance_cents, a.include_in_net_worth
           FROM accounts a
          WHERE ${scope.clause}
            AND a.deleted_at IS NULL
            AND a.hidden = 0
            AND a.type = 'investment'
          ORDER BY a.sort_order, a.name`,
        ...scope.params,
      );

      const holdings = await db.all<{
        id: string;
        account_id: string;
        account_name: string;
        security_name: string;
        ticker: string | null;
        security_type: string | null;
        quantity: number;
        institution_price_cents: number | null;
        institution_value_cents: number | null;
        cost_basis_cents: number | null;
        currency: string;
      }>(
        `SELECT h.id, h.account_id, a.name AS account_name,
                s.name AS security_name, s.ticker, s.security_type,
                h.quantity, h.institution_price_cents, h.institution_value_cents,
                h.cost_basis_cents, h.currency
           FROM investment_holdings h
           JOIN investment_securities s ON s.id = h.security_id
           JOIN accounts a ON a.id = h.account_id
          WHERE ${scope.clause}
            AND a.deleted_at IS NULL
            AND a.hidden = 0
            AND a.type = 'investment'
          ORDER BY COALESCE(h.institution_value_cents, 0) DESC, s.name`,
        ...scope.params,
      );

      const holdingViews: InvestmentHoldingView[] = holdings.map((h) => {
        const valueCents =
          h.institution_value_cents ??
          (h.institution_price_cents == null ? 0 : Math.round(h.quantity * h.institution_price_cents));
        const gainCents =
          h.cost_basis_cents == null ? null : valueCents - h.cost_basis_cents;
        const gainPct =
          h.cost_basis_cents == null || h.cost_basis_cents === 0
            ? null
            : (gainCents! / Math.abs(h.cost_basis_cents)) * 100;
        return {
          id: h.id,
          accountId: h.account_id,
          accountName: h.account_name,
          securityName: h.security_name,
          ticker: h.ticker,
          securityType: h.security_type,
          quantity: h.quantity,
          priceCents: h.institution_price_cents,
          valueCents,
          costBasisCents: h.cost_basis_cents,
          gainCents,
          gainPct,
          currency: h.currency,
        };
      });

      const valueByAccount = new Map<string, { value: number; count: number }>();
      for (const h of holdingViews) {
        const row = valueByAccount.get(h.accountId) ?? { value: 0, count: 0 };
        row.value += h.valueCents;
        row.count += 1;
        valueByAccount.set(h.accountId, row);
      }

      const accountViews: InvestmentAccountView[] = accounts.map((a) => {
        const held = valueByAccount.get(a.id) ?? { value: 0, count: 0 };
        return {
          id: a.id,
          name: a.name,
          institutionName: a.institution_name,
          subtype: a.subtype,
          balanceCents: a.current_balance_cents ?? 0,
          holdingsValueCents: held.value,
          holdingsCount: held.count,
          includeInNetWorth: a.include_in_net_worth === 1,
        };
      });

      const totalValueCents = accountViews.reduce((sum, a) => sum + a.balanceCents, 0);
      const holdingsValueCents = holdingViews.reduce((sum, h) => sum + h.valueCents, 0);
      const costRows = holdingViews.filter((h) => h.costBasisCents != null);
      const totalCostBasisCents =
        costRows.length === 0 ? null : costRows.reduce((sum, h) => sum + (h.costBasisCents ?? 0), 0);
      const totalGainCents =
        totalCostBasisCents == null ? null : holdingsValueCents - totalCostBasisCents;
      const totalGainPct =
        totalCostBasisCents == null || totalCostBasisCents === 0
          ? null
          : (totalGainCents! / Math.abs(totalCostBasisCents)) * 100;

      return {
        totalValueCents,
        holdingsValueCents,
        unallocatedValueCents: Math.max(0, totalValueCents - holdingsValueCents),
        totalCostBasisCents,
        totalGainCents,
        totalGainPct,
        accounts: accountViews,
        holdings: holdingViews,
      };
    },
  };
}

export type InvestmentsService = ReturnType<typeof createInvestmentsService>;
