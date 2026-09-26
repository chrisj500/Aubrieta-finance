"use client";

import { useMemo, useState } from "react";
import { useEffect } from "react";
import { usePageTitle } from "@/lib/use-page-title";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronLeft, ChevronRight, CircleDollarSign, Scale, TrendingDown, TrendingUp } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api-client";
import { Card, CardLabel, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Page, PageHeader } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/money";
import { AgentWidgets } from "@/components/agent-widgets";
import { useIncludePending } from "@/lib/pending-pref";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

const TOOLTIP_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  color: "var(--foreground)",
  fontSize: 13,
};


function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function deltaLabel(value: number | null, positiveIsGood: boolean): { text: string; tone: "default" | "positive" | "danger" } {
  if (value === null) return { text: "No comparable prior-period baseline", tone: "default" };
  if (Math.abs(value) < 0.05) return { text: "Flat vs prior period", tone: "default" };
  const up = value > 0;
  const good = positiveIsGood ? up : !up;
  return { text: `${up ? "Up" : "Down"} ${Math.abs(value).toFixed(1)}% vs prior period`, tone: good ? "positive" : "danger" };
}

function ChartEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-border">
      <p className="text-sm text-text-muted">{children}</p>
    </div>
  );
}

/** Month start ISO for `offset` months relative to now (0 = this month). */
function monthStart(offset: number): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1).toISOString().slice(0, 10);
}

/** A reference date inside `offset` months relative to now. */
function refDate(offset: number): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 15).toISOString().slice(0, 10);
}

interface ProjectionPoint {
  month: string;
  balanceCents: number;
  flag: "danger" | "warning" | "ok";
}
interface Projection {
  baselineCents: number;
  monthlyIncomeCents: number;
  monthlyBillsCents: number;
  monthlyDebtCents: number;
  monthlyGoalCents: number;
  avgMonthlyExpensesCents: number;
  emergencyFund: { recommendedCents: number; monthsCovered: number | null };
  points: ProjectionPoint[];
  dangerMonths: string[];
  warningMonths: string[];
}

export default function ReportsPage() {
  usePageTitle("Reports");
  const router = useRouter();
  // Selected month: 0 = current (month-to-date), negative = past, positive = future
  const [monthOffset, setMonthOffset] = useState(0);
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [includePending] = useIncludePending();
  const [trendMonths, setTrendMonths] = useState(6);
  useEffect(() => {
    setIncludeExcluded(new URLSearchParams(window.location.search).get("includeExcluded") === "1");
  }, []);

  function toggleExcluded(next: boolean) {
    setIncludeExcluded(next);
    router.replace(next ? "/reports?includeExcluded=1" : "/reports");
  }

  const monthLabel = useMemo(() => {
    const d = new Date();
    const m = new Date(d.getFullYear(), d.getMonth() + monthOffset, 1);
    return m.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }, [monthOffset]);

  const byCategory = useQuery({
    queryKey: ["reports", "by-category", monthOffset, includeExcluded, includePending],
    queryFn: () => {
      const from = monthStart(monthOffset);
      const to = monthStart(monthOffset + 1);
      const p = new URLSearchParams({ from, to });
      if (includeExcluded) p.set("includeExcluded", "1");
      if (!includePending) p.set("includePending", "0");
      return api.get<{ rows: Array<{ categoryName: string; spentCents: number; color: string | null }> }>(
        `/api/reports/spending-by-category?${p.toString()}`
      );
    },
  });

  const previousByCategory = useQuery({
    queryKey: ["reports", "by-category-previous", monthOffset, includeExcluded, includePending],
    queryFn: () => {
      const from = monthStart(monthOffset - 1);
      const to = monthStart(monthOffset);
      const p = new URLSearchParams({ from, to });
      if (includeExcluded) p.set("includeExcluded", "1");
      if (!includePending) p.set("includePending", "0");
      return api.get<{ rows: Array<{ categoryName: string; spentCents: number; color: string | null }> }>(
        `/api/reports/spending-by-category?${p.toString()}`
      );
    },
  });

  // Month summary (income / expense / net) for the selected month
  const monthSummary = useQuery({
    queryKey: ["summary", "ref", monthOffset, includeExcluded, includePending],
    queryFn: () => {
      const p = new URLSearchParams({ ref: refDate(monthOffset) });
      if (includeExcluded) p.set("includeExcluded", "1");
      if (!includePending) p.set("includePending", "0");
      return api.get<{ summary: { monthIncomeCents: number; monthExpenseCents: number; monthNetCents: number } }>(
        `/api/summary?${p.toString()}`
      );
    },
  });

  const cashflow = useQuery({
    queryKey: ["reports", "cashflow-trend", trendMonths, includeExcluded, includePending],
    queryFn: () => {
      const p = new URLSearchParams({ months: String(trendMonths * 2) });
      if (includeExcluded) p.set("includeExcluded", "1");
      if (!includePending) p.set("includePending", "0");
      return api.get<{ rows: Array<{ month: string; incomeCents: number; expenseCents: number; netCents: number }> }>(
        `/api/reports/cashflow?${p.toString()}`
      );
    },
  });
  const spendingTrend = useQuery({
    queryKey: ["reports", "spending-trend", trendMonths, includeExcluded, includePending],
    queryFn: () => {
      const p = new URLSearchParams({ months: String(trendMonths * 2) });
      if (includeExcluded) p.set("includeExcluded", "1");
      if (!includePending) p.set("includePending", "0");
      return api.get<{ rows: Array<{ month: string; spentCents: number }> }>(`/api/reports/spending-trend?${p.toString()}`);
    },
  });
  const netWorth = useQuery({
    queryKey: ["reports", "net-worth", includeExcluded, includePending],
    queryFn: () => {
      const p = new URLSearchParams();
      if (includeExcluded) p.set("includeExcluded", "1");
      if (!includePending) p.set("includePending", "0");
      const qs = p.toString();
      return api.get<{ netWorth: { assetsCents: number; liabilitiesCents: number; netCents: number } }>(`/api/reports/net-worth${qs ? `?${qs}` : ""}`);
    },
  });
  const netWorthTrend = useQuery({
    queryKey: ["reports", "net-worth-trend", trendMonths, includeExcluded],
    queryFn: () => {
      // Balance-history points are sync-time snapshots; no includePending param.
      return api.get<{ trend: Array<{ date: string; netCents: number; assetsCents: number; liabilitiesCents: number }> }>(
        `/api/reports/net-worth/trend?months=${trendMonths}${includeExcluded ? "&includeExcluded=1" : ""}`
      );
    },
  });
  const projection = useQuery({
    queryKey: ["planning", "projection", includePending],
    queryFn: () => api.get<Projection>(`/api/planning/projection?months=12${includePending ? "" : "&includePending=0"}`),
  });

  const pieData = (byCategory.data?.rows ?? []).map((r) => ({
    name: r.categoryName,
    value: r.spentCents,
  }));

  const previousCategoryMap = new Map((previousByCategory.data?.rows ?? []).map((r) => [r.categoryName, r.spentCents]));
  const currentCategoryMap = new Map((byCategory.data?.rows ?? []).map((r) => [r.categoryName, r.spentCents]));
  const categoryComparison = Array.from(new Set([...currentCategoryMap.keys(), ...previousCategoryMap.keys()]))
    .map((name) => {
      const currentCents = currentCategoryMap.get(name) ?? 0;
      const previousCents = previousCategoryMap.get(name) ?? 0;
      return { name, currentCents, previousCents, deltaCents: currentCents - previousCents };
    })
    .sort((a, b) => Math.max(b.currentCents, b.previousCents) - Math.max(a.currentCents, a.previousCents))
    .slice(0, 6);

  const allCashflowRows = cashflow.data?.rows ?? [];
  const currentCashflowRows = allCashflowRows.slice(-trendMonths);
  const priorCashflowRows = allCashflowRows.slice(-trendMonths * 2, -trendMonths);
  const barData = currentCashflowRows.map((r) => ({
    month: new Date(`${r.month}-01T00:00:00`).toLocaleDateString("en-US", { month: "short" }),
    Income: r.incomeCents / 100,
    Expenses: r.expenseCents / 100,
    Net: r.netCents / 100,
  }));
  const hasCashflow = barData.some((r) => r.Income !== 0 || r.Expenses !== 0 || r.Net !== 0);

  const allSpendingRows = spendingTrend.data?.rows ?? [];
  const currentSpendingRows = allSpendingRows.slice(-trendMonths);
  const priorSpendingRows = allSpendingRows.slice(-trendMonths * 2, -trendMonths);
  const spendingData = currentSpendingRows.map((r) => ({
    month: new Date(`${r.month}-01T00:00:00`).toLocaleDateString("en-US", { month: "short" }),
    Spending: r.spentCents / 100,
  }));
  const hasSpendingTrend = spendingData.some((r) => r.Spending !== 0);

  const currentSpendCents = currentSpendingRows.reduce((sum, r) => sum + r.spentCents, 0);
  const priorSpendCents = priorSpendingRows.reduce((sum, r) => sum + r.spentCents, 0);
  const currentNetCents = currentCashflowRows.reduce((sum, r) => sum + r.netCents, 0);
  const priorNetCents = priorCashflowRows.reduce((sum, r) => sum + r.netCents, 0);
  const avgMonthlySpendCents = trendMonths > 0 ? Math.round(currentSpendCents / trendMonths) : 0;
  const priorAvgMonthlySpendCents = trendMonths > 0 ? Math.round(priorSpendCents / trendMonths) : 0;
  const spendingDelta = deltaLabel(percentChange(avgMonthlySpendCents, priorAvgMonthlySpendCents), false);
  const cashflowDelta = deltaLabel(percentChange(currentNetCents, priorNetCents), true);

  const projData = (projection.data?.points ?? []).map((p) => ({
    month: new Date(`${p.month}-01T00:00:00`).toLocaleDateString("en-US", { month: "short" }),
    Balance: Math.round(p.balanceCents / 100),
  }));
  const hasProjection = projData.length > 0;

  const trendData = (netWorthTrend.data?.trend ?? []).map((r) => ({
    date: r.date,
    Net: r.netCents / 100,
    Assets: r.assetsCents / 100,
    Liabilities: r.liabilitiesCents / 100,
    netCents: r.netCents,
  }));
  const hasTrend = trendData.length > 0;
  const netWorthStartCents = trendData[0]?.netCents ?? null;
  const netWorthEndCents = trendData.at(-1)?.netCents ?? null;
  const netWorthChangeCents = netWorthStartCents !== null && netWorthEndCents !== null ? netWorthEndCents - netWorthStartCents : null;
  const netWorthChangePct = netWorthStartCents !== null && netWorthEndCents !== null ? percentChange(netWorthEndCents, netWorthStartCents) : null;
  const netWorthDelta = deltaLabel(netWorthChangePct, true);

  // Surface fetch failures instead of silently rendering "no data yet" empty
  // states. Gated on !data so a background refetch error never blanks charts
  // that already rendered.
  const failedQueries = [byCategory, previousByCategory, monthSummary, cashflow, spendingTrend, netWorth, netWorthTrend, projection].filter(
    (q) => q.isError && !q.data
  );
  const firstFailedError = failedQueries[0]?.error ?? null;
  const retryFailed = () => failedQueries.forEach((q) => q.refetch());
  const retrying = failedQueries.some((q) => q.isFetching);

  const s = monthSummary.data?.summary;
  const isCurrentMonth = monthOffset === 0;
  const isPast = monthOffset < 0;

  return (
    <Page>
      <PageHeader
        title="Reports"
        description="Understand how spending, cash flow, categories, and net worth are changing over time."
      />
      {/* Widgets your AI added (dev:ui) */}
      <AgentWidgets tab="reports" />

      {failedQueries.length > 0 && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-sm text-danger">
              Couldn&apos;t load {failedQueries.length === 1 ? "one report" : `${failedQueries.length} reports`}
              {firstFailedError instanceof Error && firstFailedError.message ? ` — ${firstFailedError.message}` : ""}.
            </p>
            <Button variant="secondary" size="sm" onClick={retryFailed} disabled={retrying}>
              {retrying ? "Retrying…" : "Try again"}
            </Button>
          </div>
        </Card>
      )}

      <section aria-labelledby="trends-overview-heading" className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="trends-overview-heading" className="text-lg font-semibold text-text">Trends overview</h2>
            <p className="mt-1 text-sm text-text-muted">Compare the latest {trendMonths} months with the prior {trendMonths}-month period.</p>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-muted p-0.5" role="group" aria-label="Trends range">
            {[3, 6, 12].map((m) => (
              <button key={m} type="button" aria-pressed={trendMonths === m} aria-label={`Last ${m} months`} onClick={() => setTrendMonths(m)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${trendMonths === m ? "bg-accent text-[var(--accent-foreground)]" : "text-text-muted hover:text-text"}`}>
                {m}m
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Average monthly spending" value={<Money cents={avgMonthlySpendCents} />} hint={spendingDelta.text} icon={spendingDelta.tone === "positive" ? <TrendingDown size={17} /> : spendingDelta.tone === "danger" ? <TrendingUp size={17} /> : <Activity size={17} />} tone={spendingDelta.tone} />
          <MetricCard label={`Net cash flow · ${trendMonths}m`} value={<Money cents={currentNetCents} signed />} hint={cashflowDelta.text} icon={<CircleDollarSign size={17} />} tone={currentNetCents < 0 ? "danger" : cashflowDelta.tone} />
          <MetricCard label={`Net worth change · ${trendMonths}m`} value={netWorthChangeCents === null ? "—" : <Money cents={netWorthChangeCents} signed />} hint={netWorthChangeCents === null ? "Balance history is still building" : netWorthDelta.text} icon={<Scale size={17} />} tone={netWorthChangeCents === null ? "default" : netWorthChangeCents < 0 ? "danger" : "positive"} />
        </div>
      </section>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Spending trend — last {trendMonths} months</CardTitle>
          <p className="mt-1 text-xs text-text-muted">Monthly spending, compared against the prior {trendMonths}-month period above.</p>
          {!hasSpendingTrend ? (
            <ChartEmpty>No spending trend yet — add transactions to start comparing periods.</ChartEmpty>
          ) : (
            <div className="mt-4 h-56 sm:h-64" role="img" aria-label={`Spending trend line chart — last ${trendMonths} months`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={spendingData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: "var(--text-muted)", fontSize: 12 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: "var(--text-muted)", fontSize: 12 }} tickFormatter={(v: number) => `$${v}`} tickLine={false} axisLine={false} width={60} />
                  <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} contentStyle={TOOLTIP_STYLE} wrapperStyle={{ pointerEvents: "none" }} />
                  <Line type="monotone" dataKey="Spending" stroke="var(--accent)" strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>Cash flow — last {trendMonths} months</CardTitle>
          <p className="mt-1 text-xs text-text-muted">Income, spending, and the resulting net cash flow by month.</p>
          {!hasCashflow ? (
            <ChartEmpty>No cash flow data yet — add transactions to see trends.</ChartEmpty>
          ) : (
            <div className="mt-4 h-56 sm:h-64" role="img" aria-label={`Cash flow bar chart — income, expenses, and net for the last ${trendMonths} months`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: "var(--text-muted)", fontSize: 12 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: "var(--text-muted)", fontSize: 12 }} tickFormatter={(v: number) => `$${v}`} tickLine={false} axisLine={false} width={50} />
                  <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} contentStyle={TOOLTIP_STYLE} wrapperStyle={{ pointerEvents: "none" }} cursor={false} />
                  <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-muted)" }} />
                  <Bar dataKey="Income" fill="var(--success)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Expenses" fill="var(--chart-6)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Net" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {/* Month navigator */}
      <Card>
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-muted px-3 py-2">
          <div>
            <p className="text-sm font-medium text-text">Include deleted accounts</p>
            <p className="text-xs text-text-muted">{includeExcluded ? "Included in these report totals." : "Deleted accounts are excluded from these report totals by default."}</p>
          </div>
          <Button size="sm" variant={includeExcluded ? "primary" : "secondary"} onClick={() => toggleExcluded(!includeExcluded)}>
            {includeExcluded ? "Exclude" : "Include"}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Button variant="secondary" size="sm" onClick={() => setMonthOffset((o) => o - 1)} aria-label="Previous month">
            <ChevronLeft size={16} />
          </Button>
          <div className="text-center" aria-live="polite" role="status">
            <p className="text-base font-semibold text-text">{monthLabel}</p>
            <p className="text-xs text-text-muted">
              {isPast ? "full month" : isCurrentMonth ? "month to date" : "future month (no transactions yet)"}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setMonthOffset((o) => o + 1)} aria-label="Next month">
            <ChevronRight size={16} />
          </Button>
        </div>
        {monthOffset !== 0 && (
          <div className="mt-3 text-center">
            <Button variant="secondary" size="sm" onClick={() => setMonthOffset(0)}>
              Jump to current month
            </Button>
          </div>
        )}
      </Card>

      {/* Month summary — one row on desktop, stacked stat cards on phone */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <Card className="p-4 sm:p-6">
          <CardLabel>Income</CardLabel>
          <p className="mt-1 text-xl font-bold text-success sm:text-2xl">
            <Money cents={s?.monthIncomeCents ?? 0} signed />
          </p>
        </Card>
        <Card className="p-4 sm:p-6">
          <CardLabel>Spent</CardLabel>
          <p className="mt-1 text-xl font-bold text-danger sm:text-2xl">
            <Money cents={-(s?.monthExpenseCents ?? 0)} signed />
          </p>
        </Card>
        <Card className="p-4 sm:p-6">
          <CardLabel>Net</CardLabel>
          <p className={`mt-1 text-xl font-bold sm:text-2xl ${(s?.monthNetCents ?? 0) >= 0 ? "text-text" : "text-danger"}`}>
            <Money cents={s?.monthNetCents ?? 0} signed />
          </p>
        </Card>
      </div>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Spending by category — {monthLabel}</CardTitle>
          {pieData.length === 0 ? (
            <ChartEmpty>{isCurrentMonth ? "No spending this month yet." : "No spending in this month."}</ChartEmpty>
          ) : (
            <div
              className="mt-4 h-56 sm:h-64"
              role="img"
              aria-label={`Spending by category bar chart for ${monthLabel}, ${pieData.length} categories`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={pieData}
                  margin={{ top: 4, right: 60, bottom: 4, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} vertical={false} />
                  <XAxis
                    type="number"
                    domain={[0, "auto"]}
                    tickFormatter={(v) => `$${v}`}
                    tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={110}
                    tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={(value) => `$${(Number(value) / 100).toFixed(2)}`}
                    contentStyle={TOOLTIP_STYLE}
                    wrapperStyle={{ pointerEvents: "none" }}
                    cursor={false}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                    <LabelList
                      dataKey="value"
                      position="right"
                      formatter={(v) => `$${(Number(v) / 100).toFixed(2)}`}
                      fill="var(--text-muted)"
                      fontSize={12}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>Category comparison</CardTitle>
          <p className="mt-1 text-xs text-text-muted">{monthLabel} versus the previous month · top categories by either period.</p>
          {categoryComparison.length === 0 ? (
            <ChartEmpty>No category spending to compare yet.</ChartEmpty>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="pb-2 font-medium">Category</th>
                    <th className="pb-2 text-right font-medium">This month</th>
                    <th className="pb-2 text-right font-medium">Prior</th>
                    <th className="pb-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {categoryComparison.map((row) => (
                    <tr key={row.name} className="border-b border-border/70 last:border-0">
                      <td className="py-2.5 font-medium text-text">{row.name}</td>
                      <td className="py-2.5 text-right text-text"><Money cents={row.currentCents} /></td>
                      <td className="py-2.5 text-right text-text-muted"><Money cents={row.previousCents} /></td>
                      <td className={`py-2.5 text-right font-medium ${row.deltaCents > 0 ? "text-danger" : row.deltaCents < 0 ? "text-success" : "text-text-muted"}`}>
                        <Money cents={row.deltaCents} signed />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Future projection */}
      <Card>
        <CardTitle>Projection — next 12 months</CardTitle>
        {!hasProjection ? (
          <ChartEmpty>Add transactions to build a projection.</ChartEmpty>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <span className="text-text-muted">
                Baseline: <span className="money text-text"><Money cents={projection.data?.baselineCents ?? 0} /></span>
              </span>
              <span className="text-text-muted">
                Est. income/mo: <span className="money text-success"><Money cents={projection.data?.monthlyIncomeCents ?? 0} /></span>
              </span>
              <span className="text-text-muted">
                Est. outflow/mo: <span className="money text-danger"><Money cents={projection.data?.avgMonthlyExpensesCents ?? 0} /></span>
              </span>
              <span className="text-text-muted">
                Emergency fund:{" "}
                <span className="money text-text">
                  {projection.data?.emergencyFund.monthsCovered != null
                    ? `${projection.data.emergencyFund.monthsCovered} months covered`
                    : "—"}
                </span>
              </span>
            </div>
            <div
              className="mt-4 h-56 sm:h-64"
              role="img"
              aria-label="Projected balance line chart for the next 12 months"
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={projData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: "var(--text-muted)", fontSize: 12 }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                    tickFormatter={(v: number) => `$${v}`}
                    tickLine={false}
                    axisLine={false}
                    width={60}
                  />
                  <Tooltip
                    formatter={(value) => `$${Number(value).toFixed(2)}`}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Line type="monotone" dataKey="Balance" stroke="var(--accent)" strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {(projection.data?.dangerMonths.length ?? 0) > 0 && (
              <p className="mt-3 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-sm text-danger">
                Balance is projected to go negative in: {projection.data?.dangerMonths.join(", ")}.
              </p>
            )}
          </>
        )}
      </Card>

      {/* Net worth — stacked on phone */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <Card className="p-4 sm:p-6">
          <CardLabel>Assets</CardLabel>
          <p className="mt-1 text-xl font-bold sm:text-2xl">
            <Money cents={netWorth.data?.netWorth.assetsCents ?? 0} />
          </p>
        </Card>
        <Card className="p-4 sm:p-6">
          <CardLabel>Liabilities</CardLabel>
          <p className="mt-1 text-xl font-bold text-danger sm:text-2xl">
            <Money cents={netWorth.data?.netWorth.liabilitiesCents ?? 0} />
          </p>
        </Card>
        <Card className="p-4 sm:p-6">
          <CardLabel>Net worth</CardLabel>
          <p className="mt-1 text-xl font-bold sm:text-2xl">
            <Money cents={netWorth.data?.netWorth.netCents ?? 0} />
          </p>
        </Card>
      </div>

      {/* Net worth trend — daily balance history */}
      <Card>
        <div className="mb-2">
          <CardTitle>Net worth trend — last {trendMonths} months</CardTitle>
          <p className="mt-1 text-xs text-text-muted">Assets, liabilities, and net worth from account balance history.</p>
        </div>
        {!hasTrend ? (
          <ChartEmpty>No balance history yet — sync a bank or add an account to start tracking.</ChartEmpty>
        ) : (
          <div
            className="mt-4 h-56 sm:h-64"
            role="img"
            aria-label={`Net worth trend line chart — last ${trendMonths} months`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                  tickFormatter={(d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  minTickGap={48}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                  tickFormatter={(v: number) => `$${v}`}
                  tickLine={false}
                  axisLine={false}
                  width={60}
                />
                <Tooltip
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                  contentStyle={TOOLTIP_STYLE}
                  wrapperStyle={{ pointerEvents: "none" }}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-muted)" }} />
                <Line type="monotone" dataKey="Net" stroke="var(--accent)" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="Assets" stroke="var(--success)" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="Liabilities" stroke="var(--danger)" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </Page>
  );
}
