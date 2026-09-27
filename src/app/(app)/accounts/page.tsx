"use client";

import { useMemo, useState } from "react";
import { usePageTitle } from "@/lib/use-page-title";
import { useEscapeToClose } from "@/lib/use-escape-to-close";
import { useDialogA11y } from "@/lib/use-dialog-a11y";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  CreditCard, Landmark, PiggyBank, TrendingUp, Wallet, CircleHelp, X, ChevronDown,
  RotateCcw, ALargeSmall, DollarSign, CalendarClock, ArrowUp, ArrowDown, Check, Trash2, Pencil,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { accountDetailHref } from "@/lib/account-detail-href";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/custom-select";
import { Money } from "@/components/money";
import { AccountBrandTile } from "@/components/account-brand-tile";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useIncludePending } from "@/lib/pending-pref";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FloatingAddButton } from "@/components/ui/floating-add-button";

interface Account {
  id: string;
  household_id: string | null;
  owner_user_id: string | null;
  owner_display_name?: string | null;
  visibility: "shared" | "private";
  is_owner?: boolean;
  item_id: string | null;
  name: string;
  name_override: string | null;
  official_name: string | null;
  type: string | null;
  subtype: string | null;
  mask: string | null;
  current_balance_cents: number | null;
  currency: string;
  institution_name: string | null;
  is_demo: number;
  include_in_net_worth: number;
  sort_order: number;
  description: string | null;
  deleted_at: string | null;
  pending_balance_cents?: number;
  balance_with_pending_cents?: number;
  next_payment_due_date?: string | null;
  manual_due_day?: number | null;
}

const TYPES = ["depository", "credit", "investment", "loan", "other"];
const TYPE_LABELS: Record<string, string> = {
  depository: "Cash / checking",
  credit: "Credit card",
  investment: "Investment",
  loan: "Loan / debt",
  other: "Other",
};

type AccountFilter = "all" | "credit" | "depository" | "investment" | "loan" | "other";
type AccountSort = "name" | "balance" | "due";
type SortDir = "asc" | "desc";

const FILTERS: Array<{ value: AccountFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "credit", label: "Credit cards" },
  { value: "depository", label: "Cash" },
  { value: "investment", label: "Investments" },
  { value: "loan", label: "Loans" },
  { value: "other", label: "Other" },
];

const DEFAULT_SORT_DIR: Record<AccountSort, SortDir> = { name: "asc", balance: "desc", due: "asc" };

function isLiability(a: Pick<Account, "type" | "subtype">): boolean {
  return a.type === "credit" || a.type === "loan" || a.subtype === "credit card" || a.subtype === "auto loan";
}

const TYPE_ICONS: Record<string, typeof Landmark> = {
  depository: Landmark,
  credit: CreditCard,
  investment: TrendingUp,
  loan: PiggyBank,
  other: Wallet,
};

function typeIcon(type: string | null) {
  return (type && TYPE_ICONS[type]) || CircleHelp;
}

function AccountsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-busy="true" aria-label="Loading your accounts">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton h-32" />
      ))}
    </div>
  );
}

export default function AccountsPage() {
  usePageTitle("Accounts");
  const kbdHeight = useKeyboardHeight();
  const qc = useQueryClient();
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<{ accounts: Account[] }>("/api/accounts"),
  });
  const { data, isLoading } = accountsQuery;
  const deleted = useQuery({
    queryKey: ["accounts", "deleted"],
    queryFn: () => api.get<{ accounts: Account[] }>("/api/accounts?deleted=1"),
  });
  // Page-level failure sweep (mirrors dashboard/reports/budgets/transactions):
  // gated on no-data so a background refetch error never blanks rendered accounts.
  const failedQueries = [accountsQuery, deleted].filter((q) => q.isError && !q.data);
  const hasFailed = failedQueries.length > 0;
  const isRetrying = failedQueries.some((q) => q.isFetching);
  const retry = () => failedQueries.forEach((q) => q.refetch());

  const [name, setName] = useState("");
  const [type, setType] = useState("depository");
  const [visibility, setVisibility] = useState<"shared" | "private">("private");
  const [balance, setBalance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const balanceNum = balance.trim() === "" ? null : Number(balance);
  const balanceError =
    balanceNum !== null && !Number.isFinite(balanceNum) ? "Enter a valid balance." : null;
  const [showAdd, setShowAdd] = useState(false);
  useEscapeToClose(() => { if (!create.isPending) setShowAdd(false); }, showAdd);
  const dialogA11yRef = useDialogA11y(showAdd, () => {
    if (!create.isPending) setShowAdd(false);
  });
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string; error?: string } | null>(null);
  const [includePending, setIncludePending] = useIncludePending();
  const [actionError, setActionError] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<AccountFilter>("all");
  const [sortBy, setSortBy] = useState<AccountSort>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkType, setBulkType] = useState("");
  const [bulkVisibility, setBulkVisibility] = useState("");
  const [bulkNetWorth, setBulkNetWorth] = useState("");
  const [editingAccount, setEditingAccount] = useState<{ id: string; name: string; description: string } | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  useEscapeToClose(() => { if (!updateAccountMeta.isPending) setEditingAccount(null); }, editingAccount !== null);
  const editDialogA11yRef = useDialogA11y(editingAccount !== null, () => {
    if (!updateAccountMeta.isPending) setEditingAccount(null);
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.post("/api/accounts", {
        name,
        type,
        currentBalanceCents:
          balanceError || balanceNum === null ? null : Math.round(balanceNum * 100),
        visibility,
      }),
    onSuccess: () => {
      setName("");
      setBalance("");
      setVisibility("private");
      setError(null);
      setShowAdd(false);
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to add account."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/accounts/${id}`),
    onSuccess: async () => {
      setConfirmDelete(null);
      await qc.refetchQueries({ queryKey: ["accounts"] });
      await qc.refetchQueries({ queryKey: ["accounts", "deleted"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
    onError: (e) =>
      setConfirmDelete((c) => (c ? { ...c, error: e instanceof Error ? e.message : "Failed to remove account." } : c)),
  });

  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/api/accounts/${id}/restore`),
    onSuccess: () => {
      setActionError(null);
      invalidate();
      qc.invalidateQueries({ queryKey: ["accounts", "deleted"] });
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to restore account."),
  });

  const updateAccountMeta = useMutation({
    mutationFn: async ({ id, name, description }: { id: string; name: string; description: string }) => {
      await api.patch(`/api/accounts/${id}`, { name });
      await api.patch(`/api/accounts/${id}`, { description: description.trim() || null });
    },
    onSuccess: () => {
      setActionError(null);
      setEditingAccount(null);
      invalidate();
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to update account details."),
  });

  const bulkUpdate = useMutation({
    mutationFn: () =>
      api.patch<{ updated: number }>("/api/accounts/bulk", {
        ids: selectedIds,
        type: bulkType || undefined,
        visibility: bulkVisibility || undefined,
        includeInNetWorth:
          bulkNetWorth === "include" ? true : bulkNetWorth === "exclude" ? false : undefined,
      }),
    onSuccess: (result) => {
      setActionError(null);
      setSelectedIds([]);
      setBulkType("");
      setBulkVisibility("");
      setBulkNetWorth("");
      invalidate();
      qc.invalidateQueries({ queryKey: ["planning"] });
      qc.invalidateQueries({ queryKey: ["reports"] });
      if (result.updated === 0) setActionError("No accounts were changed.");
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to update selected accounts."),
  });

  function removeAccount(a: Account) {
    setConfirmDelete({ id: a.id, name: a.name });
  }

  const visibleAccounts = useMemo(() => {
    const rows = (data?.accounts ?? []).filter((account) =>
      accountFilter === "all" || (account.type ?? "other") === accountFilter,
    );
    const direction = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortBy === "balance") {
        const av = Math.abs(includePending ? (a.balance_with_pending_cents ?? a.current_balance_cents ?? 0) : (a.current_balance_cents ?? 0));
        const bv = Math.abs(includePending ? (b.balance_with_pending_cents ?? b.current_balance_cents ?? 0) : (b.current_balance_cents ?? 0));
        return (av - bv) * direction || a.name.localeCompare(b.name);
      }
      if (sortBy === "due") {
        if (!a.next_payment_due_date && !b.next_payment_due_date) return a.name.localeCompare(b.name);
        if (!a.next_payment_due_date) return 1;
        if (!b.next_payment_due_date) return -1;
        return a.next_payment_due_date.localeCompare(b.next_payment_due_date) * direction || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) * direction;
    });
  }, [data?.accounts, accountFilter, sortBy, sortDir, includePending]);

  const hasDueDates = visibleAccounts.some((account) => Boolean(account.next_payment_due_date));

  const institutionGroups = useMemo(() => {
    const groups = new Map<string, Account[]>();
    for (const account of visibleAccounts) {
      const key = account.institution_name?.trim() || (account.is_demo ? "Demo accounts" : "Manual accounts");
      const rows = groups.get(key) ?? [];
      rows.push(account);
      groups.set(key, rows);
    }
    const rows = [...groups.entries()].map(([name, accounts]) => ({ name, accounts }));
    const direction = sortDir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      if (sortBy === "balance") {
        const total = (group: Account[]) => group.reduce((sum, account) => sum + Math.abs(includePending ? (account.balance_with_pending_cents ?? account.current_balance_cents ?? 0) : (account.current_balance_cents ?? 0)), 0);
        return (total(a.accounts) - total(b.accounts)) * direction || a.name.localeCompare(b.name);
      }
      if (sortBy === "due") {
        const earliest = (group: Account[]) => group.map((account) => account.next_payment_due_date).filter((date): date is string => Boolean(date)).sort()[0] ?? null;
        const ad = earliest(a.accounts);
        const bd = earliest(b.accounts);
        if (!ad && !bd) return a.name.localeCompare(b.name);
        if (!ad) return 1;
        if (!bd) return -1;
        return ad.localeCompare(bd) * direction || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) * direction;
    });
  }, [visibleAccounts, sortBy, sortDir, includePending]);

  function applySort(field: AccountSort) {
    if (field === "due" && !hasDueDates) return;
    if (field === sortBy) setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortBy(field);
      setSortDir(DEFAULT_SORT_DIR[field]);
    }
  }

  function toggleGroup(name: string) {
    setExpandedGroups((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  const deletedAccounts = deleted.data?.accounts ?? [];

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden">
      {actionError && (
        <p role="alert" className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      )}

      {hasFailed && (
        <Card className="border-danger/30 bg-[var(--danger-soft)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-sm text-danger">
              Couldn&apos;t load your accounts —{" "}
              {failedQueries.flatMap((q) => (q.error instanceof Error ? [q.error.message] : [])).join("; ") ||
                "Request failed"}
            </p>
            <Button variant="outline" disabled={isRetrying} onClick={retry}>
              {isRetrying ? "Retrying…" : "Try again"}
            </Button>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Accounts</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Running balances {includePending ? "include pending transactions" : "exclude pending transactions"}.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={includePending}
          onClick={() => setIncludePending(!includePending)}
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${includePending ? "border-accent/40 bg-accent/10 text-accent-text" : "border-border bg-surface-muted text-text-muted"}`}
        >
          <span className={`inline-block h-3 w-3 rounded-full ${includePending ? "bg-accent" : "bg-text-muted/40"}`} />
          Include pending
        </button>
      </div>
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="Filter accounts by type">
          {FILTERS.map((filter) => {
            const count = filter.value === "all"
              ? (data?.accounts.length ?? 0)
              : (data?.accounts.filter((account) => account.type === filter.value).length ?? 0);
            return (
              <button
                key={filter.value}
                type="button"
                aria-pressed={accountFilter === filter.value}
                onClick={() => { setAccountFilter(filter.value); setSelectedIds([]); }}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  accountFilter === filter.value
                    ? "border-accent/40 bg-accent/10 text-accent-text"
                    : "border-border bg-surface text-text-muted hover:bg-surface-muted hover:text-text"
                }`}
              >
                {filter.label} <span className="ml-1 opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
        <div role="group" aria-label="Sort accounts" className="flex h-10 shrink-0 self-end items-center rounded-xl border border-border bg-surface p-1 sm:self-auto">
          {[
            { field: "name" as const, label: "Name", Icon: ALargeSmall, enabled: true },
            { field: "balance" as const, label: "Balance", Icon: DollarSign, enabled: true },
            { field: "due" as const, label: "Due date", Icon: CalendarClock, enabled: hasDueDates },
          ].map(({ field, label, Icon, enabled }) => {
            const active = sortBy === field;
            return (
              <button
                key={field}
                type="button"
                disabled={!enabled}
                aria-pressed={active}
                aria-label={`Sort accounts by ${label.toLowerCase()}${!enabled ? ", unavailable" : ""}`}
                title={enabled ? `${label} · ${active && sortDir === "desc" ? "descending" : "ascending"}` : `${label} unavailable until due-date data is available`}
                onClick={() => applySort(field)}
                className={`relative flex h-8 w-10 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                  active ? "bg-accent/15 text-accent-text" : "text-text-muted hover:bg-surface-muted hover:text-text"
                }`}
              >
                <Icon size={16} aria-hidden />
                {active && (sortDir === "asc" ? <ArrowUp size={10} className="absolute right-1 top-1" aria-hidden /> : <ArrowDown size={10} className="absolute right-1 top-1" aria-hidden />)}
              </button>
            );
          })}
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-accent/25 bg-accent/5 p-3">
          <div className="mr-1 self-center text-sm font-semibold text-text">{selectedIds.length} selected</div>
          <div className="w-40"><CustomSelect ariaLabel="Bulk account type" value={bulkType} onChange={setBulkType} placeholder="Type…" options={TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))} /></div>
          <div className="w-40"><CustomSelect ariaLabel="Bulk visibility" value={bulkVisibility} onChange={setBulkVisibility} placeholder="Visibility…" options={[{ value: "private", label: "Private" }, { value: "shared", label: "Household" }]} /></div>
          <div className="w-44"><CustomSelect ariaLabel="Bulk net-worth inclusion" value={bulkNetWorth} onChange={setBulkNetWorth} placeholder="Net worth…" options={[{ value: "include", label: "Include in net worth" }, { value: "exclude", label: "Exclude from net worth" }]} /></div>
          <Button size="sm" disabled={bulkUpdate.isPending || (!bulkType && !bulkVisibility && !bulkNetWorth)} onClick={() => bulkUpdate.mutate()}>
            {bulkUpdate.isPending ? "Applying…" : "Apply"}
          </Button>
          <button type="button" onClick={() => setSelectedIds([])} className="h-9 px-2 text-xs font-medium text-text-muted hover:text-text">Clear selection</button>
        </div>
      )}

      {isLoading || !data ? (
        <AccountsSkeleton />
      ) : institutionGroups.length === 0 ? (
        <Card>
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
            <p className="text-sm text-text-muted">
              {data.accounts.length === 0
                ? "No accounts yet — accounts hold your balances and transactions so Aubrieta can track your finances."
                : "No accounts match this filter."}
            </p>
            {data.accounts.length === 0 && (
              <p className="mt-1 text-sm">
                <Link href="/data-sync" className="font-medium text-accent-text hover:underline">Connect a bank</Link>
                <span className="text-text-muted"> or add a manual account below.</span>
              </p>
            )}
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {institutionGroups.map((group) => {
            const expanded = expandedGroups.includes(group.name);
            const owned = group.accounts.filter((account) => account.is_owner);
            const selectedOwned = owned.filter((account) => selectedIds.includes(account.id));
            const allOwnedSelected = owned.length > 0 && selectedOwned.length === owned.length;
            const groupBalance = (account: Account) => includePending
              ? (account.balance_with_pending_cents ?? account.current_balance_cents ?? 0)
              : (account.current_balance_cents ?? 0);
            const owedCents = group.accounts.reduce((sum, account) => {
              const value = groupBalance(account);
              return sum + (isLiability(account) && value < 0 ? -value : 0);
            }, 0);
            const assetCents = group.accounts.reduce((sum, account) => {
              const value = groupBalance(account);
              return sum + (!isLiability(account) ? value : value > 0 ? value : 0);
            }, 0);
            const pendingCents = group.accounts.reduce((sum, account) => sum + (account.pending_balance_cents ?? 0), 0);
            const privateCount = group.accounts.filter((account) => account.visibility === "private").length;
            const householdCount = group.accounts.length - privateCount;
            const typeCounts = TYPES
              .map((type) => ({ type, count: group.accounts.filter((account) => (account.type ?? "other") === type).length }))
              .filter((entry) => entry.count > 0);
            const earliestDue = group.accounts.map((account) => account.next_payment_due_date).filter(Boolean).sort()[0] ?? null;

            return (
              <section key={group.name} className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group.name)}
                  className="grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-surface-muted/35 md:grid-cols-[minmax(12rem,1.4fr)_minmax(9rem,0.8fr)_minmax(9rem,0.8fr)_auto] md:items-center md:px-5"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-text-muted" aria-hidden><Landmark size={19} /></span>
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold text-text">{group.name}</span>
                      <span className="mt-0.5 block text-xs text-text-muted">
                        {group.accounts.length} account{group.accounts.length === 1 ? "" : "s"}
                        {typeCounts.map((entry) => ` · ${entry.count} ${TYPE_LABELS[entry.type]}`).join("")}
                      </span>
                    </span>
                  </span>

                  <span className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs md:block">
                    <span className="block text-text-muted">Assets</span>
                    <span className="money block text-sm font-semibold text-text"><Money cents={assetCents} /></span>
                    <span className="mt-1 block text-text-muted md:mt-2">Owed</span>
                    <span className={`money block text-sm font-semibold ${owedCents ? "text-danger" : "text-text"}`}><Money cents={owedCents} /></span>
                  </span>

                  <span className="text-xs text-text-muted">
                    <span className="block">{privateCount} Private{householdCount ? ` · ${householdCount} Household` : ""}</span>
                    {includePending && pendingCents !== 0 && <span className={`mt-1 block ${pendingCents < 0 ? "text-warning" : "text-success"}`}><Money cents={pendingCents} signed /> pending</span>}
                    {earliestDue && <span className="mt-1 block">Next due {new Date(`${earliestDue}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
                  </span>

                  <span className="flex items-center justify-end gap-2 text-xs font-medium text-accent-text">
                    {expanded ? "Hide accounts" : "Show accounts"}
                    <ChevronDown size={17} className={`text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
                  </span>
                </button>

                {expanded && (
                  <div className="border-t border-border">
                    {owned.length > 0 && (
                      <div className="flex flex-wrap items-end gap-2 border-b border-border bg-surface-muted/30 px-4 py-3 md:px-5">
                        <button
                          type="button"
                          onClick={() => setSelectedIds((current) => allOwnedSelected
                            ? current.filter((id) => !owned.some((account) => account.id === id))
                            : [...new Set([...current, ...owned.map((account) => account.id)])])}
                          className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-text-muted hover:text-text"
                        >
                          <span className={`flex h-4 w-4 items-center justify-center rounded border ${allOwnedSelected ? "border-accent bg-accent text-[var(--accent-foreground)]" : "border-border"}`}>
                            {allOwnedSelected && <Check size={11} aria-hidden />}
                          </span>
                          {allOwnedSelected ? "Clear all" : "Select all"}
                        </button>

                      </div>
                    )}

                    <div className="divide-y divide-border">
                      {group.accounts.map((account) => {
                        const Icon = typeIcon(account.type);
                        const selected = selectedIds.includes(account.id);
                        const balanceCents = groupBalance(account);
                        return (
                          <div key={account.id} className="grid gap-3 px-4 py-3 md:grid-cols-[auto_minmax(0,1fr)_9rem_8rem_7rem_auto] md:items-center md:px-5">
                            <div className="flex items-center gap-3">
                              {account.is_owner ? (
                                <button type="button" aria-pressed={selected} aria-label={`${selected ? "Deselect" : "Select"} ${account.name}`} onClick={() => toggleSelected(account.id)} className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? "border-accent bg-accent text-[var(--accent-foreground)]" : "border-border bg-surface"}`}>
                                  {selected && <Check size={12} aria-hidden />}
                                </button>
                              ) : <span className="h-5 w-5 shrink-0" />}
                              {account.type === "credit" ? (
                                <AccountBrandTile name={account.name} officialName={account.official_name} institutionName={account.institution_name} mask={account.mask} />
                              ) : (
                                <span className="flex h-10 w-16 shrink-0 items-center justify-center rounded-md bg-surface-muted text-text-muted"><Icon size={19} aria-hidden /></span>
                              )}
                            </div>

                            <div className="min-w-0">
                              <Link href={accountDetailHref(account.id)} className="block truncate text-sm font-semibold text-text hover:text-accent-text">{account.name}</Link>
                              <p className="mt-0.5 truncate text-xs text-text-muted">
                                {TYPE_LABELS[account.type ?? "other"]}{account.mask ? ` · ••••${account.mask}` : ""}{!account.is_owner && account.owner_display_name ? ` · Owned by ${account.owner_display_name}` : ""}
                              </p>
                            </div>

                            <div className="md:text-right">
                              <p className={`money text-sm font-semibold ${isLiability(account) && balanceCents < 0 ? "text-danger" : "text-text"}`}><Money cents={balanceCents} signed={isLiability(account)} /></p>
                              {includePending && (account.pending_balance_cents ?? 0) !== 0 && <p className="money text-[11px] text-text-muted"><Money cents={account.pending_balance_cents ?? 0} signed /> pending</p>}
                            </div>

                            <div className="text-xs text-text-muted md:text-right">
                              {account.next_payment_due_date ? (
                                <><span className="block">Due</span><span className="font-medium text-text">{new Date(`${account.next_payment_due_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></>
                              ) : <span>—</span>}
                            </div>

                            <div className="flex items-center gap-1 md:justify-end">
                              <Badge>{account.visibility === "private" ? "Private" : "Household"}</Badge>
                              {account.include_in_net_worth === 1 && <span title="Included in net worth" className="text-success"><Check size={14} aria-hidden /></span>}
                            </div>

                            <div className="flex items-center justify-end gap-1">
                              {account.is_owner && (
                                <button
                                  type="button"
                                  aria-label={`Edit ${account.name}`}
                                  title="Edit name or note"
                                  onClick={() => {
                                    setEditingAccount({ id: account.id, name: account.name, description: account.description ?? "" });
                                    setEditName(account.name);
                                    setEditDescription(account.description ?? "");
                                  }}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
                                >
                                  <Pencil size={13} aria-hidden />
                                </button>
                              )}
                              {account.is_owner && (
                                <button
                                  type="button"
                                  aria-label={`Remove ${account.name}`}
                                  title="Remove account"
                                  onClick={() => removeAccount(account)}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-[var(--danger-soft)] hover:text-danger"
                                >
                                  <Trash2 size={13} aria-hidden />
                                </button>
                              )}
                              <Link href={accountDetailHref(account.id)} aria-label={`Open ${account.name}`} className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-muted hover:text-text">›</Link>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* Recently removed — restore soft-deleted accounts */}
      {deletedAccounts.length > 0 && (
        <Card>
          <div className="mb-2 flex items-center gap-2">
            <RotateCcw size={15} className="text-text-muted" />
            <CardTitle>Recently removed</CardTitle>
          </div>
          <p className="mb-3 text-xs text-text-muted">
            Removed accounts keep their history so they can be brought back. Tap Restore to undo a removal.
          </p>
          <Link href="/reports?includeExcluded=1" className="mb-3 inline-flex text-sm font-medium text-accent-text hover:underline">
            Review reports including removed-account history →
          </Link>
          <ul className="divide-y divide-border">
            {deletedAccounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.official_name ?? a.name}</p>
                  <p className="truncate text-xs text-text-muted">
                    {a.institution_name ?? "Manual"} {a.mask ? `· ••••${a.mask}` : ""}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Restore ${a.official_name ?? a.name}`}
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(a.id)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {editingAccount && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => !updateAccountMeta.isPending && setEditingAccount(null)}
        >
          <div
            ref={editDialogA11yRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Edit ${editingAccount.name}`}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <CardTitle>Edit account</CardTitle>
              <button aria-label="Close account editor" onClick={() => !updateAccountMeta.isPending && setEditingAccount(null)} className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-muted hover:text-text"><X size={17} /></button>
            </div>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!editName.trim()) return;
                updateAccountMeta.mutate({ id: editingAccount.id, name: editName.trim(), description: editDescription });
              }}
            >
              <div>
                <label htmlFor="edit-account-name" className="mb-1 block text-xs font-medium text-text-muted">Name</label>
                <Input id="edit-account-name" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={100} required autoFocus />
              </div>
              <div>
                <label htmlFor="edit-account-note" className="mb-1 block text-xs font-medium text-text-muted">Note</label>
                <Input id="edit-account-note" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} maxLength={300} placeholder="Optional note about this account" />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" disabled={updateAccountMeta.isPending} onClick={() => setEditingAccount(null)}>Cancel</Button>
                <Button type="submit" disabled={updateAccountMeta.isPending || !editName.trim()}>{updateAccountMeta.isPending ? "Saving…" : "Save"}</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add-account modal */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm md:items-center md:p-6"
          onClick={() => !create.isPending && setShowAdd(false)}
          style={{ paddingBottom: kbdHeight > 0 ? `${kbdHeight}px` : undefined }}
        >
          <div
            ref={dialogA11yRef}
            role="dialog"
            aria-modal="true"
            aria-label="Add a manual account"
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-h-[calc(100dvh-1rem)] flex-col overflow-hidden rounded-t-3xl border border-border bg-surface shadow-2xl md:max-h-[calc(100dvh-3rem)] md:max-w-lg md:rounded-3xl"
            style={{
              maxHeight: `calc(100dvh - ${kbdHeight}px - 1rem)`,
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          >
            <div className="overflow-y-auto p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border md:hidden" />
            <div className="mb-4 flex items-center justify-between">
              <CardTitle>Add a manual account</CardTitle>
              <button
                aria-label="Close"
                onClick={() => !create.isPending && setShowAdd(false)}
                className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
              >
                <X size={18} />
              </button>
            </div>
            <p className="mb-4 text-sm text-text-muted">For cash, wallets, or anything not connected through Plaid.</p>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <div>
                <label htmlFor="acc-name" className="mb-1 block text-xs font-medium text-text-muted">
                  Name
                </label>
                <Input id="acc-name" placeholder="e.g. Cash wallet" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </div>
              <div>
                <label id="acc-type-label" className="mb-1 block text-xs font-medium text-text-muted">
                  Type
                </label>
                <CustomSelect
                  ariaLabel="Account type"
                  value={type}
                  onChange={setType}
                  options={TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Visibility
                </label>
                <CustomSelect
                  ariaLabel="Account visibility"
                  value={visibility}
                  onChange={(value) => setVisibility(value as "shared" | "private")}
                  options={[
                    { value: "shared", label: "Household", hint: "Visible to household members" },
                    { value: "private", label: "Private", hint: "Visible only to you" },
                  ]}
                />
              </div>
              <div>
                <label htmlFor="acc-balance" className="mb-1 block text-xs font-medium text-text-muted">
                  Balance ($)
                </label>
                <Input
                  id="acc-balance"
                  placeholder="0.00"
                  inputMode="decimal"
                  enterKeyHint="done"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  aria-invalid={!!balanceError}
                />
                {balanceError && (
                  <p role="alert" className="mt-1 text-xs text-danger">{balanceError}</p>
                )}
              </div>
              {error && (
                <p role="alert" className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={create.isPending || !name || !!balanceError}>
                {create.isPending ? "Adding…" : "Add account"}
              </Button>
            </form>
            </div>
          </div>
        </div>
      )}

      {/* Floating action button — bottom right, above the mobile tab bar */}
      <FloatingAddButton label="Add account" onClick={() => setShowAdd(true)} hidden={showAdd} />

      {/* Custom remove confirmation */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove account?"
        message={confirmDelete ? `"${confirmDelete.name}" will be hidden. You can restore it later from “Recently removed”.${confirmDelete.error ? ` ${confirmDelete.error}` : ""}` : undefined}
        confirmLabel="Remove"
        busy={remove.isPending}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) remove.mutate(confirmDelete.id);
        }}
      />
    </div>
  );
}