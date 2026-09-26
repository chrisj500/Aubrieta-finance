"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowLeftRight,
  CalendarDays,
  CreditCard,
  Landmark,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import { Card, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Page, PageHeader } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/money";

interface AccountDetail {
  account: {
    id: string;
    name: string;
    official_name: string | null;
    type: string | null;
    subtype: string | null;
    mask: string | null;
    current_balance_cents: number | null;
    available_balance_cents: number | null;
    pending_balance_cents?: number;
    balance_with_pending_cents?: number;
    currency: string;
    institution_name: string | null;
    visibility: "shared" | "private";
    owner_display_name?: string | null;
    is_owner?: boolean;
    include_in_net_worth: number;
    description: string | null;
  };
  history: Array<{ date: string; balanceCents: number }>;
  recentActivity: Array<{
    id: string;
    amount_cents: number;
    date: string;
    name: string;
    category_name: string | null;
    category_color: string | null;
    pending: number;
    is_transfer: number;
  }>;
  activityTotal: number;
  monthIncomeCents: number;
  monthExpenseCents: number;
  monthNetCents: number;
  liability: {
    kind: string;
    nextPaymentDueDate: string | null;
    minimumPaymentCents: number | null;
    statementBalanceCents: number | null;
    statementDate: string | null;
    nextMonthlyPaymentCents: number | null;
    aprBps: number | null;
    lastPaymentAmountCents: number | null;
    lastPaymentDate: string | null;
    rawStatus: string | null;
    syncedAt: string;
  } | null;
  holdings: Array<{
    id: string;
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
  }>;
}

const TOOLTIP_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  color: "var(--foreground)",
  fontSize: 13,
};

function dollars(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function pct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function qty(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

function isLiability(type: string | null): boolean {
  return type === "credit" || type === "loan";
}

function typeLabel(type: string | null): string {
  switch (type) {
    case "depository": return "Cash / checking";
    case "credit": return "Credit card";
    case "investment": return "Investment";
    case "loan": return "Loan / debt";
    case "other": return "Other";
    default: return "Account";
  }
}

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [rangeDays, setRangeDays] = useState(90);

  const query = useQuery({
    queryKey: ["accounts", id, "detail"],
    queryFn: () => api.get<AccountDetail>(`/api/accounts/${encodeURIComponent(id)}`),
  });
  const data = query.data;
  usePageTitle(data?.account.name ?? "Account");

  const chartData = useMemo(() => {
    if (!data) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return data.history
      .filter((p) => p.date >= cutoffIso)
      .map((p) => ({ ...p, balance: p.balanceCents / 100 }));
  }, [data, rangeDays]);

  if (query.isLoading && !data) {
    return (
      <Page>
        <div className="skeleton h-20" role="status" aria-label="Loading account detail" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="skeleton h-28" />
          <div className="skeleton h-28" />
          <div className="skeleton h-28" />
        </div>
        <div className="skeleton h-80" />
      </Page>
    );
  }

  if (query.isError || !data) {
    return (
      <Page>
        <Link href="/accounts" className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline">
          <ArrowLeft size={15} aria-hidden /> Back to accounts
        </Link>
        <Card className="border-danger/30 bg-[var(--danger-soft)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-sm text-danger">
              Couldn&apos;t load this account — {query.error instanceof Error ? query.error.message : "Request failed"}.
            </p>
            <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? "Retrying…" : "Try again"}
            </Button>
          </div>
        </Card>
      </Page>
    );
  }

  const a = data.account;
  const liability = isLiability(a.type);
  const description = [
    a.institution_name,
    a.subtype?.replace(/-/g, " "),
    a.mask ? `••••${a.mask}` : null,
  ].filter(Boolean).join(" · ") || typeLabel(a.type);

  return (
    <Page>
      <Link href="/accounts" className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline">
        <ArrowLeft size={15} aria-hidden /> Back to accounts
      </Link>

      <PageHeader
        title={a.name}
        description={description}
        action={
          <Link
            href={`/transactions?accountId=${encodeURIComponent(a.id)}`}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm font-medium text-text transition-colors hover:bg-surface-muted"
          >
            <ArrowLeftRight size={16} aria-hidden />
            All activity
          </Link>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Badge className="bg-surface-muted text-text-muted">{typeLabel(a.type)}</Badge>
        <Badge className="bg-surface-muted text-text-muted">{a.visibility === "private" ? "Private" : "Household"}</Badge>
        <Badge className="bg-surface-muted text-text-muted">{a.include_in_net_worth === 1 ? "In net worth" : "Excluded from net worth"}</Badge>
        {!a.is_owner && a.owner_display_name ? (
          <Badge className="bg-surface-muted text-text-muted">Owned by {a.owner_display_name}</Badge>
        ) : null}
      </div>

      <section aria-label="Account summary" className="grid gap-3 sm:grid-cols-3">
        <MetricCard
          label="Current balance"
          value={<Money cents={a.current_balance_cents ?? 0} currency={a.currency} signed={liability} />}
          hint={a.pending_balance_cents ? <><Money cents={a.pending_balance_cents} currency={a.currency} signed /> pending</> : "No pending activity"}
          icon={a.type === "investment" ? <TrendingUp size={17} /> : liability ? <CreditCard size={17} /> : <Landmark size={17} />}
          tone={liability && (a.current_balance_cents ?? 0) < 0 ? "danger" : "default"}
        />
        <MetricCard
          label="Available"
          value={a.available_balance_cents == null ? "—" : <Money cents={a.available_balance_cents} currency={a.currency} signed={liability} />}
          hint={a.available_balance_cents == null ? "Provider does not report available balance" : "Provider-reported available balance"}
          icon={<WalletCards size={17} />}
        />
        <MetricCard
          label="This month"
          value={<Money cents={data.monthNetCents} currency={a.currency} signed />}
          hint={<><Money cents={data.monthIncomeCents} currency={a.currency} /> in · <Money cents={data.monthExpenseCents} currency={a.currency} /> out</>}
          icon={<CalendarDays size={17} />}
          tone={data.monthNetCents > 0 ? "positive" : data.monthNetCents < 0 ? "danger" : "default"}
        />
      </section>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Balance history</CardTitle>
            <p className="mt-1 text-xs text-text-muted">Provider and manual balance snapshots for this account.</p>
          </div>
          <div className="flex rounded-lg border border-border bg-surface-muted p-0.5" aria-label="Balance history range">
            {[30, 90, 365].map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={rangeDays === days}
                onClick={() => setRangeDays(days)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${rangeDays === days ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text"}`}
              >
                {days === 365 ? "1 year" : `${days} days`}
              </button>
            ))}
          </div>
        </div>

        {chartData.length < 2 ? (
          <div className="mt-4 flex h-56 items-center justify-center rounded-xl border border-dashed border-border">
            <p className="max-w-md px-4 text-center text-sm text-text-muted">
              Not enough balance history yet. Another sync or balance update will start the trend.
            </p>
          </div>
        ) : (
          <div className="mt-4 h-64 w-full" role="img" aria-label={`Balance history for ${a.name} over the last ${rangeDays} days`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={28} stroke="var(--text-muted)" />
                <YAxis tickFormatter={(v) => dollars(Number(v) * 100, a.currency)} tick={{ fontSize: 11 }} width={72} stroke="var(--text-muted)" />
                <Tooltip formatter={(value) => dollars(Number(value) * 100, a.currency)} contentStyle={TOOLTIP_STYLE} wrapperStyle={{ pointerEvents: "none" }} />
                <Line type="monotone" dataKey="balance" stroke="var(--chart-1)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {data.liability ? (
        <Card>
          <CardTitle>Debt details</CardTitle>
          <p className="mt-1 text-xs text-text-muted">Latest provider-confirmed liability information.</p>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-text-muted">Next payment</dt>
              <dd className="mt-1 font-medium text-text">
                {data.liability.minimumPaymentCents != null
                  ? <Money cents={data.liability.minimumPaymentCents} currency={a.currency} />
                  : data.liability.nextMonthlyPaymentCents != null
                    ? <Money cents={data.liability.nextMonthlyPaymentCents} currency={a.currency} />
                    : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Due date</dt>
              <dd className="mt-1 font-medium text-text">{data.liability.nextPaymentDueDate ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Statement balance</dt>
              <dd className="mt-1 font-medium text-text">{data.liability.statementBalanceCents == null ? "—" : <Money cents={data.liability.statementBalanceCents} currency={a.currency} />}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">APR</dt>
              <dd className="mt-1 font-medium text-text">{data.liability.aprBps == null ? "—" : `${(data.liability.aprBps / 100).toFixed(2)}%`}</dd>
            </div>
          </dl>
        </Card>
      ) : null}

      {data.holdings.length > 0 ? (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Holdings</CardTitle>
              <p className="mt-1 text-xs text-text-muted">Positions currently synced for this account.</p>
            </div>
            <Link href="/investments" className="text-sm font-medium text-accent-text hover:underline">Portfolio</Link>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[650px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-muted">
                  <th className="pb-2 font-medium">Holding</th>
                  <th className="pb-2 text-right font-medium">Quantity</th>
                  <th className="pb-2 text-right font-medium">Price</th>
                  <th className="pb-2 text-right font-medium">Value</th>
                  <th className="pb-2 text-right font-medium">Gain</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.map((holding) => (
                  <tr key={holding.id} className="border-b border-border/70 last:border-0">
                    <td className="py-3">
                      <div className="font-medium text-text">{holding.ticker ?? holding.securityName}</div>
                      {holding.ticker ? <div className="text-xs text-text-muted">{holding.securityName}</div> : null}
                    </td>
                    <td className="py-3 text-right text-text">{qty(holding.quantity)}</td>
                    <td className="py-3 text-right text-text-muted">{holding.priceCents == null ? "—" : <Money cents={holding.priceCents} currency={holding.currency} />}</td>
                    <td className="py-3 text-right font-medium text-text"><Money cents={holding.valueCents} currency={holding.currency} /></td>
                    <td className={`py-3 text-right font-medium ${(holding.gainCents ?? 0) < 0 ? "text-danger" : (holding.gainCents ?? 0) > 0 ? "text-success" : "text-text-muted"}`}>
                      {holding.gainCents == null ? "—" : <><Money cents={holding.gainCents} currency={holding.currency} signed /> <span className="text-xs">({pct(holding.gainPct)})</span></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card className="p-0">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <CardTitle>Recent activity</CardTitle>
            <p className="mt-1 text-xs text-text-muted">{data.activityTotal} transaction{data.activityTotal === 1 ? "" : "s"} on this account.</p>
          </div>
          {data.activityTotal > 0 ? (
            <Link href={`/transactions?accountId=${encodeURIComponent(a.id)}`} className="text-sm font-medium text-accent-text hover:underline">
              View all
            </Link>
          ) : null}
        </div>
        {data.recentActivity.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-text-muted">No activity on this account yet.</div>
        ) : (
          <div className="mt-4 divide-y divide-border">
            {data.recentActivity.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-5 py-3.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.category_color ?? "var(--border)" }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-text">{t.name}</p>
                    {t.pending === 1 ? <Badge className="bg-[var(--warning-soft)] text-[var(--warning)]">Pending</Badge> : null}
                    {t.is_transfer === 1 ? <Badge className="bg-surface-muted text-text-muted">Transfer</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">{t.date}{t.category_name ? ` · ${t.category_name}` : ""}</p>
                </div>
                <span className={`money shrink-0 text-sm font-semibold ${t.amount_cents < 0 ? "text-danger" : "text-success"}`}>
                  <Money cents={t.amount_cents} currency={a.currency} signed />
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Account details</CardTitle>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-text-muted">Institution</dt>
            <dd className="mt-1 font-medium text-text">{a.institution_name ?? "Manual account"}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Account type</dt>
            <dd className="mt-1 font-medium text-text">{typeLabel(a.type)}{a.subtype ? ` · ${a.subtype.replace(/-/g, " ")}` : ""}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Visibility</dt>
            <dd className="mt-1 font-medium text-text">{a.visibility === "private" ? "Private" : "Household"}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Net worth</dt>
            <dd className="mt-1 font-medium text-text">{a.include_in_net_worth === 1 ? "Included" : "Excluded"}</dd>
          </div>
        </dl>
        {a.description ? <p className="mt-4 border-t border-border pt-4 text-sm text-text-muted">{a.description}</p> : null}
      </Card>
    </Page>
  );
}
