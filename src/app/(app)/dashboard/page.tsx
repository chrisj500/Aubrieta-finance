"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { TrendingDown, TrendingUp, Wallet, Scale, Settings2, ChevronUp, ChevronDown, EyeOff, Eye, RotateCcw, CalendarClock, AlertTriangle, Target } from "lucide-react";
import { api } from "@/lib/api-client";
import { Card, CardLabel, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Page, PageHeader } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { AgentWidgets } from "@/components/agent-widgets";
import { ReviewWidget } from "@/components/review-widget";
import { usePageTitle } from "@/lib/use-page-title";
import { useIncludePending } from "@/lib/pending-pref";
import { useDashboardLayout, type DashboardWidgetId } from "@/lib/dashboard-pref";

interface OverviewGoal {
  id: string;
  name: string;
  type: string;
  target_cents: number;
  current_cents: number;
  pct: number;
  target_date: string | null;
}

interface Summary {
  totalBalanceCents: number;
  byType: Record<string, number>;
  monthIncomeCents: number;
  monthExpenseCents: number;
  monthNetCents: number;
  budgetOverview: Array<{ id: string; name: string; spentCents: number; amountCents: number; pct: number }>;
  upcomingBills: Array<{
    occurrenceId: string;
    billId: string;
    name: string;
    dueDate: string;
    amountCents: number;
    status: string;
    source: string;
    sourceConfidence: string;
  }>;
  overdueBillCount: number;
  upcomingBillsTotalCents: number;
  recentTransactions: Array<{
    id: string;
    accountName: string;
    amountCents: number;
    date: string;
    name: string;
    categoryName: string | null;
    categoryColor: string | null;
  }>;
}

function OverviewSkeleton() {
  return (
    <Page role="status" aria-busy="true" aria-label="Loading your overview">
      <div className="skeleton h-28" />
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-24" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="skeleton h-56" />
        <div className="skeleton h-56" />
      </div>
    </Page>
  );
}

function formatShortDate(iso: string) {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const WIDGET_LABELS = {
  balance: "Net worth",
  stats: "Monthly stats",
  budgets: "Budgets",
  recent: "Recent transactions",
} satisfies Record<DashboardWidgetId, string>;

function BalanceCard({ s }: { s: Summary }) {
  const netPositive = s.monthNetCents >= 0;
  return (
    <Card
      className="border-accent/20"
      style={{ background: "linear-gradient(135deg, var(--accent-soft), transparent 55%), var(--surface)" }}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <CardLabel>Net worth</CardLabel>
          <p className="money mt-1 text-4xl font-bold tracking-tight">
            <Money cents={s.totalBalanceCents} />
          </p>
          <p className="mt-1.5 text-sm text-text-muted">
            Net this month:{" "}
            <span className={netPositive ? "font-medium text-success" : "font-medium text-danger"}>
              <Money cents={s.monthNetCents} signed />
            </span>
          </p>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent-text" aria-hidden>
          <Wallet size={24} />
        </div>
      </div>
    </Card>
  );
}

function StatsRow({ s }: { s: Summary }) {
  const netPositive = s.monthNetCents >= 0;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <MetricCard
        label="Income this month"
        value={<Money cents={s.monthIncomeCents} />}
        icon={<TrendingUp size={17} />}
        tone="positive"
      />
      <MetricCard
        label="Spent this month"
        value={<Money cents={s.monthExpenseCents} />}
        icon={<TrendingDown size={17} />}
      />
      <MetricCard
        label="Net this month"
        value={<Money cents={s.monthNetCents} signed />}
        icon={<Scale size={17} />}
        tone={netPositive ? "positive" : "danger"}
      />
    </div>
  );
}

function BudgetsCard({ s }: { s: Summary }) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center justify-between">
        <CardTitle>Budgets</CardTitle>
        <Link href="/budgets" className="text-sm font-medium text-accent-text hover:underline">
          View all
        </Link>
      </div>
      <div className="mt-4 space-y-4">
        {s.budgetOverview.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm text-text-muted">No budgets yet.</p>
            <Link href="/budgets" className="mt-1 inline-block text-sm font-medium text-accent-text hover:underline">
              Create your first budget →
            </Link>
          </div>
        )}
        {s.budgetOverview.map((b) => (
          <div key={b.id} className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium text-text">{b.name}</span>
              <span className={`money shrink-0 ${b.pct > 1 ? "font-medium text-danger" : "text-text-muted"}`}>
                <Money cents={b.spentCents} /> / <Money cents={b.amountCents} />
              </span>
            </div>
            <Progress value={b.pct} label={`${b.name} budget usage`} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function UpcomingBillsCard({ s }: { s: Summary }) {
  const labelFor = (bill: Summary["upcomingBills"][number]) => {
    if (bill.sourceConfidence === "confirmed") return "Confirmed";
    if (bill.source === "provider_recurring" || bill.sourceConfidence === "provider") return "Provider";
    if (bill.sourceConfidence === "user") return "User override";
    return "Detected";
  };

  return (
    <Card className={s.overdueBillCount > 0 ? "border-warning/40" : ""}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-muted text-text-muted" aria-hidden>
            <CalendarClock size={17} />
          </span>
          <div>
            <CardTitle>Upcoming bills</CardTitle>
            <p className="text-xs text-text-muted">
              Next 30 days · <Money cents={s.upcomingBillsTotalCents} /> expected
            </p>
          </div>
        </div>
        <Link href="/plan" className="text-sm font-medium text-accent-text hover:underline">
          View calendar
        </Link>
      </div>

      {s.overdueBillCount > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle size={15} aria-hidden />
          {s.overdueBillCount} overdue {s.overdueBillCount === 1 ? "bill" : "bills"}
        </div>
      )}

      <div className="mt-3 divide-y divide-border">
        {s.upcomingBills.length === 0 && (
          <p className="py-5 text-sm text-text-muted">No bills due in the next 30 days.</p>
        )}
        {s.upcomingBills.map((bill) => (
          <div key={bill.occurrenceId} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text">{bill.name}</p>
              <p className="text-xs text-text-muted">
                {formatShortDate(bill.dueDate)} · {labelFor(bill)}
              </p>
            </div>
            <span className="money shrink-0 text-sm font-semibold">
              <Money cents={bill.amountCents} />
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function GoalsCard({ goals, loading, failed }: { goals: OverviewGoal[]; loading: boolean; failed: boolean }) {
  const savings = goals.filter((g) => g.type !== "expense");
  const ordered = [...savings].sort((a, b) => {
    const aComplete = a.current_cents >= a.target_cents;
    const bComplete = b.current_cents >= b.target_cents;
    if (aComplete !== bComplete) return aComplete ? 1 : -1;
    return (a.target_date ?? "9999-12-31").localeCompare(b.target_date ?? "9999-12-31");
  });
  const visible = ordered.slice(0, 3);

  return (
    <Card className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-muted text-text-muted" aria-hidden>
            <Target size={17} />
          </span>
          <div>
            <CardTitle>Goals</CardTitle>
            <p className="text-xs text-text-muted">Progress toward your household savings targets.</p>
          </div>
        </div>
        <Link href="/plan#goals-overview-heading" className="text-sm font-medium text-accent-text hover:underline">
          View goals
        </Link>
      </div>
      <div className="mt-4 space-y-4">
        {loading && <div className="skeleton h-20" role="status" aria-label="Loading goals" />}
        {failed && (
          <div className="rounded-xl border border-border px-4 py-5 text-sm text-text-muted">Goals are unavailable right now. Open Plan to try again.</div>
        )}
        {!loading && !failed && visible.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
            <p className="text-sm text-text-muted">No savings goals yet.</p>
            <Link href="/plan#goals-overview-heading" className="mt-1 inline-block text-sm font-medium text-accent-text hover:underline">
              Create your first goal →
            </Link>
          </div>
        )}
        {!failed && visible.map((g) => {
          const complete = g.current_cents >= g.target_cents;
          return (
            <div key={g.id} className="min-w-0">
              <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium text-text">{g.name}</span>
                <span className={complete ? "shrink-0 font-medium text-success" : "shrink-0 text-text-muted"}>
                  {complete ? "Complete" : `${Math.round(Math.min(1, g.pct) * 100)}%`}
                </span>
              </div>
              <Progress value={Math.min(1, g.pct)} label={`${g.name} goal progress on overview`} />
              <p className="mt-1 text-xs text-text-muted">
                <Money cents={g.current_cents} /> of <Money cents={g.target_cents} />
                {g.target_date ? ` · ${formatShortDate(g.target_date)}` : ""}
              </p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function RecentCard({ s }: { s: Summary }) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center justify-between">
        <CardTitle>Recent transactions</CardTitle>
        <Link href="/transactions" className="text-sm font-medium text-accent-text hover:underline">
          View all
        </Link>
      </div>
      <div className="mt-2 divide-y divide-border">
        {s.recentTransactions.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm text-text-muted">Nothing here yet.</p>
            <p className="mt-1 text-sm">
              <Link href="/settings" className="font-medium text-accent-text hover:underline">
                Connect a bank
              </Link>
              <span className="text-text-muted"> or </span>
              <Link href="/transactions" className="font-medium text-accent-text hover:underline">
                add a transaction manually
              </Link>
            </p>
          </div>
        )}
        {s.recentTransactions.map((t) => (
          <div key={t.id} className="flex min-w-0 items-center justify-between gap-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: t.categoryColor ?? "var(--border)" }}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{t.name}</p>
                <p className="truncate text-xs text-text-muted">
                  {t.categoryName ?? "Uncategorized"} · {t.accountName} · {formatShortDate(t.date)}
                </p>
              </div>
            </div>
            <span className={`money shrink-0 text-sm font-semibold ${t.amountCents < 0 ? "text-danger" : "text-success"}`}>
              <Money cents={t.amountCents} signed />
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function LayoutControls({
  id,
  index,
  count,
  hidden,
  onMove,
  onToggleHidden,
}: {
  id: DashboardWidgetId;
  index: number;
  count: number;
  hidden: boolean;
  onMove: (id: DashboardWidgetId, dir: -1 | 1) => void;
  onToggleHidden: (id: DashboardWidgetId) => void;
}) {
  const label = WIDGET_LABELS[id];
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onMove(id, -1)}
        disabled={index === 0}
        aria-label={`Move ${label} up`}
        className="rounded-lg p-1.5 text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-30"
      >
        <ChevronUp size={16} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onMove(id, 1)}
        disabled={index === count - 1}
        aria-label={`Move ${label} down`}
        className="rounded-lg p-1.5 text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-30"
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onToggleHidden(id)}
        aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
        aria-pressed={hidden}
        className="rounded-lg p-1.5 text-text-muted hover:bg-surface-muted hover:text-text"
      >
        {hidden ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />}
      </button>
    </div>
  );
}

export default function OverviewPage() {
  usePageTitle("Overview");
  const [includePending] = useIncludePending();
  const { layout, move, toggleHidden, reset } = useDashboardLayout();
  const [customizing, setCustomizing] = useState(false);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["summary", includePending],
    queryFn: () =>
      api.get<{ summary: Summary }>(`/api/summary${includePending ? "" : "?includePending=0"}`),
  });
  const goals = useQuery({
    queryKey: ["planning", "goals", "overview"],
    queryFn: () => api.get<{ goals: OverviewGoal[] }>("/api/planning/goals"),
    retry: false,
  });

  if (error && !data) {
    return (
      <Card className="mx-auto max-w-md p-6 text-center">
        <p role="alert" className="text-sm text-danger">
          Couldn&apos;t load your overview{error instanceof Error && error.message ? ` — ${error.message}` : ""}.
        </p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Retrying…" : "Try again"}
        </Button>
      </Card>
    );
  }
  if (isLoading || !data) return <OverviewSkeleton />;
  const s = data.summary;

  const widgets = {
    balance: <BalanceCard s={s} />,
    stats: <StatsRow s={s} />,
    budgets: <BudgetsCard s={s} />,
    recent: <RecentCard s={s} />,
  } satisfies Record<DashboardWidgetId, ReactNode>;

  const visible = layout.order.filter((id) => !layout.hidden.includes(id));
  // Budgets + recent render side-by-side (as before) when adjacent in the
  // user's order; a reordered widget becomes a full-width block.
  const blocks: ReactNode[] = [];
  for (let i = 0; i < visible.length; i++) {
    const id = visible[i];
    const next = visible[i + 1];
    const isPair =
      (id === "budgets" && next === "recent") || (id === "recent" && next === "budgets");
    if (isPair) {
      blocks.push(
        <div key={`pair-${id}`} className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">{widgets[id]}</div>
          <div className="min-w-0">{widgets[next]}</div>
        </div>,
      );
      i++;
    } else {
      blocks.push(<div key={id}>{widgets[id]}</div>);
    }
  }

  const customizeAction = (
    <button
      type="button"
      onClick={() => setCustomizing((c) => !c)}
      aria-pressed={customizing}
      aria-label={customizing ? "Done customizing overview layout" : "Customize overview layout"}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium ${
        customizing ? "bg-accent/10 text-accent-text" : "text-text-muted hover:bg-surface-muted hover:text-text"
      }`}
    >
      <Settings2 size={16} aria-hidden />
      {customizing ? "Done" : "Customize"}
    </button>
  );

  return (
    <Page className="overflow-x-clip">
      <PageHeader
        title="Overview"
        description="Your household finances, upcoming obligations, and recent activity at a glance."
        action={customizeAction}
      />

      {/* Widgets your AI added (dev:ui) — removable inline */}
      <AgentWidgets tab="dashboard" />

      {/* One-tap review of transactions that still need a human-set category */}
      <ReviewWidget />

      <UpcomingBillsCard s={s} />

      <GoalsCard goals={goals.data?.goals ?? []} loading={goals.isLoading} failed={goals.isError} />

      {customizing && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Overview layout</CardTitle>
            <button
              type="button"
              onClick={reset}
              aria-label="Reset overview layout to default"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-text-muted hover:bg-surface-muted hover:text-text"
            >
              <RotateCcw size={14} aria-hidden />
              Reset layout
            </button>
          </div>
          <div className="mt-3 divide-y divide-border">
            {layout.order.map((id, i) => {
              const hidden = layout.hidden.includes(id);
              return (
                <div key={id} className="flex items-center justify-between gap-3 py-2">
                  <span className={`text-sm font-medium ${hidden ? "text-text-muted line-through" : "text-text"}`}>
                    {WIDGET_LABELS[id]}
                  </span>
                  <LayoutControls
                    id={id}
                    index={i}
                    count={layout.order.length}
                    hidden={hidden}
                    onMove={move}
                    onToggleHidden={toggleHidden}
                  />
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {blocks}
    </Page>
  );
}
