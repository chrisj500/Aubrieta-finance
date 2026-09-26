"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Landmark, TrendingUp, WalletCards } from "lucide-react";
import { api } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import { Money } from "@/components/money";
import { Card, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Page, PageHeader } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Holding {
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

interface InvestmentAccount {
  id: string;
  name: string;
  institutionName: string | null;
  subtype: string | null;
  balanceCents: number;
  holdingsValueCents: number;
  holdingsCount: number;
  includeInNetWorth: boolean;
}

interface InvestmentOverview {
  totalValueCents: number;
  holdingsValueCents: number;
  unallocatedValueCents: number;
  totalCostBasisCents: number | null;
  totalGainCents: number | null;
  totalGainPct: number | null;
  accounts: InvestmentAccount[];
  holdings: Holding[];
}

function pct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function quantity(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

export default function InvestmentsPage() {
  usePageTitle("Investments");
  const query = useQuery({
    queryKey: ["investments"],
    queryFn: () => api.get<InvestmentOverview>("/api/investments"),
  });

  const data = query.data;
  const gainTone =
    (data?.totalGainCents ?? 0) < 0 ? "danger" : (data?.totalGainCents ?? 0) > 0 ? "positive" : "default";

  return (
    <Page>
      <PageHeader
        title="Investments"
        description="See investment-account balances, synced holdings, cost basis, and portfolio gains in one place."
      />

      {query.isError && !data ? (
        <Card className="border-danger/30 bg-[var(--danger-soft)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-sm text-danger">
              Couldn&apos;t load investments — {query.error instanceof Error ? query.error.message : "Request failed"}.
            </p>
            <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? "Retrying…" : "Try again"}
            </Button>
          </div>
        </Card>
      ) : null}

      <section aria-labelledby="investment-overview-heading" className="space-y-3">
        <div>
          <h2 id="investment-overview-heading" className="text-lg font-semibold text-text">Portfolio overview</h2>
          <p className="mt-1 text-sm text-text-muted">
            Account balances are authoritative. Holdings appear when your provider supplies position-level data.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard
            label="Investment value"
            value={<Money cents={data?.totalValueCents ?? 0} />}
            hint={`${data?.accounts.length ?? 0} investment account${data?.accounts.length === 1 ? "" : "s"}`}
            icon={<Landmark size={17} />}
          />
          <MetricCard
            label="Synced holdings"
            value={<Money cents={data?.holdingsValueCents ?? 0} />}
            hint={`${data?.holdings.length ?? 0} position${data?.holdings.length === 1 ? "" : "s"}`}
            icon={<WalletCards size={17} />}
          />
          <MetricCard
            label="Unrealized gain"
            value={data?.totalGainCents == null ? "—" : <Money cents={data.totalGainCents} signed />}
            hint={data?.totalGainPct == null ? "Cost basis unavailable" : pct(data.totalGainPct)}
            icon={<TrendingUp size={17} />}
            tone={gainTone}
          />
        </div>
      </section>

      {query.isLoading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2" role="status" aria-label="Loading investments">
          <div className="skeleton h-40" />
          <div className="skeleton h-40" />
        </div>
      ) : data && data.accounts.length === 0 ? (
        <Card className="text-center">
          <BarChart3 className="mx-auto text-text-muted" size={28} aria-hidden />
          <CardTitle className="mt-3">No investment accounts yet</CardTitle>
          <p className="mx-auto mt-2 max-w-lg text-sm text-text-muted">
            Link a brokerage or retirement account, or mark an existing account as Investment.
          </p>
          <Link href="/accounts" className="mt-4 inline-flex text-sm font-medium text-accent-text hover:underline">
            Open accounts
          </Link>
        </Card>
      ) : null}

      {(data?.accounts.length ?? 0) > 0 ? (
        <section aria-labelledby="investment-accounts-heading" className="space-y-3">
          <div>
            <h2 id="investment-accounts-heading" className="text-lg font-semibold text-text">Investment accounts</h2>
            <p className="mt-1 text-sm text-text-muted">Balances and holding coverage by account.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data!.accounts.map((account) => (
              <Card key={account.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{account.name}</CardTitle>
                    <p className="mt-1 truncate text-xs text-text-muted">
                      {[account.institutionName, account.subtype?.replace(/-/g, " ")].filter(Boolean).join(" · ") || "Investment account"}
                    </p>
                  </div>
                  <Badge>{account.includeInNetWorth ? "In net worth" : "Excluded"}</Badge>
                </div>
                <p className="money mt-5 text-2xl font-bold text-text"><Money cents={account.balanceCents} /></p>
                <div className="mt-3 flex items-center justify-between gap-3 text-xs text-text-muted">
                  <span>{account.holdingsCount} synced holding{account.holdingsCount === 1 ? "" : "s"}</span>
                  <span><Money cents={account.holdingsValueCents} /> covered</span>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {(data?.holdings.length ?? 0) > 0 ? (
        <Card>
          <CardTitle>Holdings</CardTitle>
          <p className="mt-1 text-xs text-text-muted">Current provider-supplied positions, ordered by market value.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="pb-2 font-medium">Holding</th>
                    <th className="pb-2 font-medium">Account</th>
                    <th className="pb-2 text-right font-medium">Quantity</th>
                    <th className="pb-2 text-right font-medium">Price</th>
                    <th className="pb-2 text-right font-medium">Value</th>
                    <th className="pb-2 text-right font-medium">Gain</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.holdings.map((holding) => (
                    <tr key={holding.id} className="border-b border-border/70 last:border-0">
                      <td className="py-3">
                        <div className="font-medium text-text">{holding.ticker ?? holding.securityName}</div>
                        {holding.ticker ? <div className="text-xs text-text-muted">{holding.securityName}</div> : null}
                      </td>
                      <td className="py-3 text-text-muted">{holding.accountName}</td>
                      <td className="py-3 text-right text-text">{quantity(holding.quantity)}</td>
                      <td className="py-3 text-right text-text-muted">{holding.priceCents == null ? "—" : <Money cents={holding.priceCents} />}</td>
                      <td className="py-3 text-right font-medium text-text"><Money cents={holding.valueCents} /></td>
                      <td className={`py-3 text-right font-medium ${(holding.gainCents ?? 0) < 0 ? "text-danger" : (holding.gainCents ?? 0) > 0 ? "text-success" : "text-text-muted"}`}>
                        {holding.gainCents == null ? "—" : <><Money cents={holding.gainCents} signed /> <span className="text-xs">({pct(holding.gainPct)})</span></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        </Card>
      ) : data && data.accounts.length > 0 ? (
        <Card>
          <CardTitle>Holdings are not available yet</CardTitle>
          <p className="mt-2 text-sm text-text-muted">
            Your investment-account balances are included above. Position-level holdings will appear automatically when a connected provider supplies them.
          </p>
        </Card>
      ) : null}
    </Page>
  );
}
