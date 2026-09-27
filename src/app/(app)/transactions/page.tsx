"use client";

import { useEffect, useMemo, useState } from "react";
import { usePageTitle } from "@/lib/use-page-title";
import { useEscapeToClose } from "@/lib/use-escape-to-close";
import { useDialogA11y } from "@/lib/use-dialog-a11y";
import Link from "next/link";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, X, Trash2, Pencil, ChevronDown, RefreshCw,
  CalendarDays, ALargeSmall, DollarSign, ArrowUp, ArrowDown,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { Card, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomDatePicker } from "@/components/ui/custom-date-picker";
import { CustomSelect } from "@/components/ui/custom-select";
import { UndoSnackbar } from "@/components/ui/undo-snackbar";
import { FloatingAddButton } from "@/components/ui/floating-add-button";
import { Money } from "@/components/money";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";

interface Txn {
  id: string;
  account_id: string;
  account_name: string;
  amount_cents: number;
  date: string;
  name: string;
  user_category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  exclude_from_budgets: number;
  pending: number;
  source: string;
}

interface Account {
  id: string;
  name: string;
}

interface Category {
  id: string;
  name: string;
}

const UNCATEGORIZED_FILTER = "__uncategorized__";
type TransactionSortBy = "date" | "vendor" | "amount";
type TransactionSortDir = "asc" | "desc";

const DEFAULT_SORT_DIR: Record<TransactionSortBy, TransactionSortDir> = {
  date: "desc",
  vendor: "asc",
  amount: "desc",
};

function RowSkeleton() {
  return (
    <div className="space-y-1 divide-y divide-border" role="status" aria-busy="true" aria-label="Loading your transactions">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-4">
          <div className="skeleton h-9 flex-1" />
          <div className="skeleton h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

export default function TransactionsPage() {
  usePageTitle("Transactions");
  const kbdHeight = useKeyboardHeight();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [sortBy, setSortBy] = useState<TransactionSortBy>("date");
  const [sortDir, setSortDir] = useState<TransactionSortDir>("desc");

  useEffect(() => {
    const url = new URLSearchParams(window.location.search);
    const accountFromUrl = url.get("accountId");
    const categoryFromUrl = url.get("categoryId");
    const fromUrl = url.get("from");
    const toUrl = url.get("to");
    const sortFromUrl = url.get("sort");
    const dirFromUrl = url.get("dir");
    if (accountFromUrl) setAccountId(accountFromUrl);
    if (url.get("uncategorized") === "1") setCategoryId(UNCATEGORIZED_FILTER);
    else if (categoryFromUrl) setCategoryId(categoryFromUrl);
    if (fromUrl) setFrom(fromUrl);
    if (toUrl) setTo(toUrl);
    if (sortFromUrl === "date" || sortFromUrl === "vendor" || sortFromUrl === "amount") {
      setSortBy(sortFromUrl);
      if (dirFromUrl === "asc" || dirFromUrl === "desc") setSortDir(dirFromUrl);
      else setSortDir(DEFAULT_SORT_DIR[sortFromUrl]);
    }
  }, []);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  useEscapeToClose(() => { if (!add.isPending) setShowAdd(false); }, showAdd);
  const addDialogA11yRef = useDialogA11y(showAdd, () => {
    if (!add.isPending) setShowAdd(false);
  });
  const [undoTxn, setUndoTxn] = useState<Txn | null>(null);

  // Manual-transaction edit modal (name/amount/date). Bank-imported rows are
  // owned by the source and shouldn't be hand-edited, so only `source==="manual"`
  // rows get the Edit affordance — the PATCH endpoint already accepts these fields.
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDate, setEditDate] = useState(new Date().toISOString().slice(0, 10));
  const [editTouched, setEditTouched] = useState(false);
  const editNum = Number(editAmount);
  const editAmountError =
    editAmount !== "" && (!Number.isFinite(editNum) || editNum === 0)
      ? !Number.isFinite(editNum)
        ? "Enter a valid number."
        : "Amount cannot be zero."
      : null;
  useEscapeToClose(() => { if (!edit.isPending) setEditId(null); }, editId !== null);
  const editDialogA11yRef = useDialogA11y(editId !== null, () => {
    if (!edit.isPending) setEditId(null);
  });

  // Debounce the search term so we don't fire a /api/transactions query on every
  // keystroke — the input stays responsive (driven by `q`) but the query only
  // runs once the user pauses typing.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ.trim()) p.set("q", debouncedQ.trim());
    if (accountId) p.set("accountId", accountId);
    if (categoryId === UNCATEGORIZED_FILTER) p.set("uncategorized", "1");
    else if (categoryId) p.set("categoryId", categoryId);
    if (pendingOnly) p.set("pending", "1");
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("sort", sortBy);
    p.set("dir", sortDir);
    return p.toString();
  }, [debouncedQ, accountId, categoryId, pendingOnly, from, to, sortBy, sortDir]);

  // Paginated via offset (server clamps `limit` to 200, so growing `limit`
  // never revealed more rows — switch to cursor-style offset pages instead).
  const PAGE_SIZE = 200;
  const txQuery = useInfiniteQuery({
    queryKey: ["transactions", params],
    queryFn: ({ pageParam }) =>
      api.get<{ rows: Txn[]; total: number }>(
        `/api/transactions?${params}&limit=${PAGE_SIZE}&offset=${pageParam}`
      ),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  // Synthesize the flat list the rest of the page expects (resets on filter
  // change because `params` is part of the query key).
  const data = {
    rows: txQuery.data?.pages.flatMap((p) => p.rows) ?? [],
    total: txQuery.data?.pages[0]?.total ?? 0,
  };
  const isLoading = txQuery.isLoading;
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<{ accounts: Account[] }>("/api/accounts") });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api.get<{ categories: Category[] }>("/api/categories") });

  // Surface fetch failures instead of leaving the user stuck on RowSkeleton with
  // zero feedback. Gated on !data so a background refetch error never blanks
  // already-rendered rows (mirrors the dashboard/reports/budgets/agents pattern).
  const failedQueries = [txQuery, accounts, categories].filter((q) => q.isError && !q.data);
  const hasFailed = failedQueries.length > 0;
  const isRetrying = failedQueries.some((q) => q.isFetching);
  const retry = () => failedQueries.forEach((q) => q.refetch());

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
    qc.invalidateQueries({ queryKey: ["budgets"] });
    // Categorizing here must refresh the dashboard's review queue — otherwise
    // "N need a category" shows transactions already categorized in this tab.
    qc.invalidateQueries({ queryKey: ["review-queue"] });
  };

  const setCategory = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string | null }) =>
      api.patch(`/api/transactions/${id}`, { userCategoryId: categoryId }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : "Update failed."),
  });

  const toggleExclude = useMutation({
    mutationFn: ({ id, exclude }: { id: string; exclude: boolean }) =>
      api.patch(`/api/transactions/${id}`, { excludeFromBudgets: exclude }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to update exclude flag."),
  });

  const remove = useMutation({
    mutationFn: (txn: Txn) => api.del(`/api/transactions/${txn.id}`),
    onSuccess: (_d, txn) => {
      setUndoTxn(txn);
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to delete transaction."),
  });
  const undoDelete = useMutation({
    mutationFn: (txn: Txn) =>
      api.post("/api/transactions", {
        accountId: txn.account_id,
        amountCents: txn.amount_cents,
        date: txn.date,
        name: txn.name,
        userCategoryId: txn.user_category_id,
        excludeFromBudgets: txn.exclude_from_budgets === 1,
      }),
    onSuccess: () => {
      setUndoTxn(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to restore transaction."),
  });

  // Manual-row edit (name/amount/date) — PATCH /api/transactions/:id already
  // accepts exactly these fields; the server stays authoritative for the int +
  // non-zero amount checks. Only manual rows get the affordance (bank rows are
  // source-owned and would be clobbered on the next sync).
  const edit = useMutation({
    mutationFn: () =>
      api.patch(`/api/transactions/${editId}`, {
        name: editName,
        amountCents: Math.round(editNum * 100),
        date: editDate,
      }),
    onSuccess: () => {
      setEditId(null);
      setEditName("");
      setEditAmount("");
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Update failed."),
  });

  // Manual refresh: pull posted + pending transactions straight from the bank.
  // Works in solo mode (native Plaid proxy) and on the hub. In solo mode the
  // sync also fires the global "of:data-synced" event, but we invalidate here
  // too so hub-mode refreshes update the list immediately.
  const syncNow = useMutation({
    mutationFn: () => api.post<{ results: Array<{ institution_name: string | null; added: number; modified: number; removed: number; ok: boolean; error?: string }> }>("/api/transactions/sync"),
    onSuccess: (d) => {
      const changed = d.results.reduce((n, r) => n + r.added + r.modified, 0);
      const failed = d.results.filter((r) => !r.ok);
      if (failed.length > 0) {
        const needsLogin = failed.some((f) => /ITEM_LOGIN_REQUIRED|login details of this item have changed|user login is required/i.test(f.error ?? ""));
        if (needsLogin) {
          setError(
            `Some banks need you to sign in again. Go to Data & Sync and tap “Reconnect” on the institution that needs it, then sync again. (${
              failed.map((f) => f.institution_name ?? "an institution").join("; ")
            })`
          );
        } else {
          setError(`Refresh finished with errors: ${failed.map((f) => `${f.institution_name ?? "an institution"}${f.error ? `: ${f.error}` : ""}`).join("; ")}`);
        }
      } else {
        setError(null);
        setRefreshMsg(changed === 0 ? "Up to date — nothing new." : `Synced — ${changed} transaction${changed === 1 ? "" : "s"} updated.`);
      }
      invalidate();
      qc.invalidateQueries({ queryKey: ["reports"] });
      qc.invalidateQueries({ queryKey: ["planning"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Refresh failed."),
    });

    // Manual add form
    const [addName, setAddName] = useState("");
    const [addAmount, setAddAmount] = useState("");
    const [addDate, setAddDate] = useState(new Date().toISOString().slice(0, 10));
    const [addAccount, setAddAccount] = useState("");
    const [addCategory, setAddCategory] = useState("");
    const [addExclude, setAddExclude] = useState(false);
  const [amountTouched, setAmountTouched] = useState(false);

  // Inline amount validation (run-59 budgets pattern): catch non-numeric /
  // zero amounts before they round-trip to the server's generic 400. Number()
  // — not parseFloat — so "1,000" is rejected as invalid instead of silently
  // recording $1.00 (parseFloat stops at the comma). Server stays authoritative
  // for the final int + non-zero checks.
  const addAmountNum = Number(addAmount);
  const addAmountError =
    addAmount !== "" && (!Number.isFinite(addAmountNum) || addAmountNum === 0)
      ? !Number.isFinite(addAmountNum)
        ? "Enter a valid amount."
        : "Amount cannot be zero."
      : null;

  const add = useMutation({
    mutationFn: () =>
      api.post("/api/transactions", {
        accountId: addAccount,
        amountCents: Math.round(addAmountNum * 100),
        date: addDate,
        name: addName,
        userCategoryId: addCategory || null,
        excludeFromBudgets: addExclude,
      }),
    onSuccess: () => {
      setAddName("");
      setAddAmount("");
      setAmountTouched(false);
      setAddCategory("");
      setError(null);
      setShowAdd(false);
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Add failed."),
  });

  const sortDirectionLabel = (field: TransactionSortBy, dir: TransactionSortDir) => {
    if (field === "date") return dir === "desc" ? "newest first" : "oldest first";
    if (field === "vendor") return dir === "asc" ? "A to Z" : "Z to A";
    return dir === "desc" ? "largest first" : "smallest first";
  };

  const applySort = (field: TransactionSortBy) => {
    const nextDir = field === sortBy
      ? (sortDir === "asc" ? "desc" : "asc")
      : DEFAULT_SORT_DIR[field];
    setSortBy(field);
    setSortDir(nextDir);

    const url = new URL(window.location.href);
    if (field === "date" && nextDir === "desc") {
      url.searchParams.delete("sort");
      url.searchParams.delete("dir");
    } else {
      url.searchParams.set("sort", field);
      url.searchParams.set("dir", nextDir);
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  const hasFilters = Boolean(q || accountId || categoryId || pendingOnly || from || to);
  const filterCount = [q.trim(), accountId, categoryId, pendingOnly ? "pending" : "", from, to].filter(Boolean).length;
  const clearFilters = () => {
    setQ("");
    setDebouncedQ("");
    setAccountId("");
    setCategoryId("");
    setPendingOnly(false);
    setFrom("");
    setTo("");
    const sortParams = new URLSearchParams();
    if (!(sortBy === "date" && sortDir === "desc")) {
      sortParams.set("sort", sortBy);
      sortParams.set("dir", sortDir);
    }
    const sortQuery = sortParams.toString();
    window.history.replaceState(null, "", `/transactions${sortQuery ? `?${sortQuery}` : ""}`);
  };

  return (
    <Page>
      <PageHeader
        title="Transactions"
        description="Search, review, and organize activity across every account."
      />

      {hasFailed && (
        <Card className="border-danger/30 bg-[var(--danger-soft)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-sm text-danger">
              Couldn&apos;t load your transactions —{" "}
              {failedQueries.flatMap((q) => (q.error instanceof Error ? [q.error.message] : [])).join("; ") ||
                "Request failed"}
            </p>
            <Button variant="outline" disabled={isRetrying} onClick={retry}>
              {isRetrying ? "Retrying…" : "Try again"}
            </Button>
          </div>
        </Card>
      )}

      {/* Everyday transaction controls stay prominent; history/import tools are
          deliberately separated below so the primary workflow remains calm. */}
      <Card className="sticky top-2 z-20 p-3 shadow-sm sm:p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3" role="search">
            <div className="relative min-w-0 flex-1 basis-64">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
              <Input
                type="search"
                aria-label="Search transactions"
                aria-controls="tx-list"
                placeholder="Search transactions…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-9 pr-8 [&::-webkit-search-cancel-button]:hidden"
              />
              {q && (
                <button
                  aria-label="Clear search"
                  onClick={() => setQ("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <span role="status" aria-live="polite" className="shrink-0 text-sm text-text-muted">
              {data ? `${data.total} transaction${data.total === 1 ? "" : "s"}` : "…"}
            </span>
            <Button
              variant="outline"
              onClick={() => {
                setRefreshMsg(null);
                syncNow.mutate();
              }}
              disabled={syncNow.isPending}
              title="Refresh from your bank (posted + pending)"
              className="shrink-0"
            >
              <RefreshCw size={14} className={syncNow.isPending ? "animate-spin" : ""} aria-hidden />
              {syncNow.isPending ? "Refreshing…" : "Refresh"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <div className="min-w-40 flex-1 sm:flex-none">
              <CustomSelect
                ariaLabel="Filter by account"
                value={accountId}
                onChange={setAccountId}
                placeholder="All accounts"
                options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
              />
            </div>
            <div className="min-w-40 flex-1 sm:flex-none">
              <CustomSelect
                ariaLabel="Filter by category"
                value={categoryId}
                onChange={setCategoryId}
                placeholder="All categories"
                options={[
                  { value: UNCATEGORIZED_FILTER, label: "Uncategorized" },
                  ...(categories.data?.categories ?? []).map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            </div>
            <button
              type="button"
              aria-pressed={pendingOnly}
              onClick={() => setPendingOnly((v) => !v)}
              className={`flex h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
                pendingOnly
                  ? "border-accent bg-accent/15 text-accent-text"
                  : "border-border bg-surface text-text-muted hover:text-text"
              }`}
            >
              {pendingOnly && (
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 6.5L4.5 9L10 3" />
                </svg>
              )}
              Pending
            </button>
            <div className="min-w-36 flex-1 sm:flex-none">
              <CustomDatePicker ariaLabel="From date" value={from} onChange={setFrom} max={to || undefined} />
            </div>
            <div className="min-w-36 flex-1 sm:flex-none">
              <CustomDatePicker ariaLabel="To date" value={to} onChange={setTo} min={from || undefined} />
            </div>
            <div
              role="group"
              aria-label="Sort transactions"
              className="flex h-10 shrink-0 items-center rounded-xl border border-border bg-surface p-1"
            >
              {([
                { field: "date" as const, label: "Date", Icon: CalendarDays },
                { field: "vendor" as const, label: "Vendor", Icon: ALargeSmall },
                { field: "amount" as const, label: "Amount", Icon: DollarSign },
              ]).map(({ field, label, Icon }) => {
                const active = sortBy === field;
                const direction = active ? sortDir : DEFAULT_SORT_DIR[field];
                const directionLabel = sortDirectionLabel(field, direction);
                return (
                  <button
                    key={field}
                    type="button"
                    aria-pressed={active}
                    aria-label={`Sort by ${label.toLowerCase()}, ${directionLabel}`}
                    title={`${label} · ${directionLabel}`}
                    onClick={() => applySort(field)}
                    className={`relative flex h-8 w-10 items-center justify-center rounded-lg transition-colors ${
                      active
                        ? "bg-accent/15 text-accent-text"
                        : "text-text-muted hover:bg-surface-muted hover:text-text"
                    }`}
                  >
                    <Icon size={16} aria-hidden />
                    {active && (
                      sortDir === "asc"
                        ? <ArrowUp size={10} className="absolute right-1 top-1" aria-hidden />
                        : <ArrowDown size={10} className="absolute right-1 top-1" aria-hidden />
                    )}
                  </button>
                );
              })}
            </div>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="flex h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
              >
                <X size={14} aria-hidden />
                Clear filters{filterCount > 0 ? ` (${filterCount})` : ""}
              </button>
            )}
          </div>

          {(refreshMsg || error) && (
            <div className={`border-t border-border pt-3 text-xs ${error ? "text-danger" : "text-text-muted"}`}>
              {error ?? refreshMsg}
            </div>
          )}
        </div>
      </Card>

      {/* Add-transaction modal */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm md:items-center md:p-6"
          onClick={() => !add.isPending && setShowAdd(false)}
          style={{ paddingBottom: kbdHeight > 0 ? `${kbdHeight}px` : undefined }}
        >
          <div
            ref={addDialogA11yRef}
            role="dialog"
            aria-modal="true"
            aria-label="Add a transaction"
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
              <CardTitle>Add a transaction</CardTitle>
              <button
                aria-label="Close"
                onClick={() => !add.isPending && setShowAdd(false)}
                className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
              >
                <X size={18} />
              </button>
            </div>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                add.mutate();
              }}
            >
              <div>
                <label htmlFor="add-name" className="mb-1 block text-xs font-medium text-text-muted">
                  Name
                </label>
                <Input id="add-name" placeholder="e.g. Coffee" value={addName} onChange={(e) => setAddName(e.target.value)} autoFocus />
              </div>
              <div>
                <label htmlFor="add-amount" className="mb-1 block text-xs font-medium text-text-muted">
                  Amount ($)
                </label>
                <Input
                  id="add-amount"
                  placeholder="0.00"
                  inputMode="decimal"
                  enterKeyHint="done"
                  value={addAmount}
                  onChange={(e) => setAddAmount(e.target.value)}
                  onBlur={() => setAmountTouched(true)}
                  aria-invalid={amountTouched && !!addAmountError}
                />
                {amountTouched && addAmountError && (
                  <p role="alert" className="mt-1 text-xs text-danger">{addAmountError}</p>
                )}
              </div>
              <div>
                <label htmlFor="add-date" className="mb-1 block text-xs font-medium text-text-muted">
                  Date
                </label>
                <CustomDatePicker ariaLabel="Transaction date" value={addDate} onChange={setAddDate} max={new Date().toISOString().slice(0, 10)} />
              </div>
              <div>
                <label id="add-account-label" className="mb-1 block text-xs font-medium text-text-muted">
                  Account
                </label>
                <CustomSelect
                  ariaLabel="Account"
                  value={addAccount}
                  onChange={setAddAccount}
                  placeholder="Select…"
                  options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
                />
              </div>
              <div>
                <label id="add-category-label" className="mb-1 block text-xs font-medium text-text-muted">
                  Category
                </label>
                <CustomSelect
                  ariaLabel="Category"
                  value={addCategory}
                  onChange={setAddCategory}
                  placeholder="Uncategorized"
                  options={(categories.data?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
                />
              </div>
              <p className="text-xs text-text-muted">Expenses are negative, income is positive — e.g. -45.00 for a purchase, 2500.00 for a paycheck.</p>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text select-none">
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                    addExclude ? "border-accent bg-accent text-[var(--accent-foreground)]" : "border-border bg-surface"
                  }`}
                >
                  {addExclude && (
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 6.5L4.5 9L10 3" />
                    </svg>
                  )}
                </span>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={addExclude}
                  onChange={(e) => setAddExclude(e.target.checked)}
                />
                Keep this transaction out of budgets
              </label>
              {error && (
                <p role="alert" className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={add.isPending || !addName || !addAmount || !addAccount || !!addAmountError}>
                {add.isPending ? "Adding…" : "Add transaction"}
              </Button>
            </form>
            </div>
          </div>
        </div>
      )}

      {/* Edit-transaction modal — manual rows only (name/amount/date). */}
      {editId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm md:items-center md:p-6"
          onClick={() => !edit.isPending && setEditId(null)}
          style={{ paddingBottom: kbdHeight > 0 ? `${kbdHeight}px` : undefined }}
        >
          <div
            ref={editDialogA11yRef}
            role="dialog"
            aria-modal="true"
            aria-label="Edit transaction"
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
              <CardTitle>Edit transaction</CardTitle>
              <button
                aria-label="Close"
                onClick={() => !edit.isPending && setEditId(null)}
                className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
              >
                <X size={18} />
              </button>
            </div>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                edit.mutate();
              }}
            >
              <div>
                <label htmlFor="edit-name" className="mb-1 block text-xs font-medium text-text-muted">
                  Name
                </label>
                <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
              </div>
              <div>
                <label htmlFor="edit-amount" className="mb-1 block text-xs font-medium text-text-muted">
                  Amount ($)
                </label>
                <Input
                  id="edit-amount"
                  inputMode="decimal"
                  enterKeyHint="done"
                  value={editAmount}
                  onChange={(e) => setEditAmount(e.target.value)}
                  onBlur={() => setEditTouched(true)}
                  aria-invalid={editTouched && !!editAmountError}
                />
                {editTouched && editAmountError && (
                  <p role="alert" className="mt-1 text-xs text-danger">{editAmountError}</p>
                )}
              </div>
              <div>
                <label htmlFor="edit-date" className="mb-1 block text-xs font-medium text-text-muted">
                  Date
                </label>
                <CustomDatePicker ariaLabel="Transaction date" value={editDate} onChange={setEditDate} max={new Date().toISOString().slice(0, 10)} />
              </div>
              <p className="text-xs text-text-muted">Expenses are negative, income is positive.</p>
              {error && (
                <p role="alert" className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={edit.isPending || !editName || !editAmount || !!editAmountError}>
                {edit.isPending ? "Saving…" : "Save changes"}
              </Button>
            </form>
            </div>
          </div>
        </div>
      )}

      {/* Floating action button — bottom right, above the mobile tab bar.
          Hidden while the add modal is open; rises above the keyboard. */}
      <FloatingAddButton label="Add transaction" onClick={() => setShowAdd(true)} hidden={showAdd} />

      {/* Reversible delete: remove immediately, offer a timed Undo (Q38: undo > warning) */}
      <UndoSnackbar
        open={undoTxn !== null}
        message={undoTxn ? `"${undoTxn.name}" deleted.` : ""}
        onUndo={() => undoTxn && undoDelete.mutate(undoTxn)}
        onClose={() => setUndoTxn(null)}
      />

      {/* List */}
      <Card className="p-0">
        {isLoading || !data ? (
          <RowSkeleton />
        ) : data.rows.length === 0 ? (
          <div className="px-6 py-12 text-center">
            {hasFilters ? (
              <>
                <p className="text-sm text-text-muted">No transactions match your filters.</p>
                <button
                  className="mt-1 text-sm font-medium text-accent-text hover:underline"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              </>
            ) : (accounts.data?.accounts ?? []).length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8">
                <p className="text-sm text-text-muted">No transactions yet.</p>
                <p className="mt-1 text-sm">
                  <Link href="/data-sync" className="font-medium text-accent-text hover:underline">
                    Connect a bank
                  </Link>
                  <span className="text-text-muted">
                    {" "}or add an account first, then add transactions with the + button.
                  </span>
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-4 py-8">
                <p className="text-sm text-text-muted">No transactions yet.</p>
                <p className="mt-1 text-sm text-text-muted">
                  Add one with the + button, or import older history from{" "}
                  <Link href="/data-sync#csv-import" className="font-medium text-accent-text hover:underline">
                    Data & Sync
                  </Link>.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div
            id="tx-list"
            className="divide-y divide-border md:grid md:grid-cols-[minmax(0,1fr)_max-content_max-content_max-content_2rem] md:divide-y-0"
          >
            {data.rows.map((t) => {
              const isExpense = t.amount_cents < 0;
              const expanded = expandedId === t.id;
              return (
                <div
                  key={t.id}
                  className="md:col-span-5 md:grid md:grid-cols-subgrid md:border-b md:border-border md:last:border-b-0"
                >
                  {/* Primary transaction row. Category + budget exclusion stay
                      visible so routine review never requires opening details. */}
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3.5 transition-colors hover:bg-surface-muted/30 md:col-span-5 md:grid-cols-subgrid md:gap-x-4 md:px-5">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedId(expanded ? null : t.id)}
                      className="col-start-1 row-start-1 flex min-w-0 items-center gap-3 text-left md:col-start-1 md:row-start-1"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: t.category_color ?? "var(--border)" }}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate text-[15px] font-medium text-text">{t.name}</span>
                          {t.pending === 1 && (
                            <span className="shrink-0 rounded bg-[var(--warning-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--warning)]">
                              pending
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-text-muted">
                          {t.date} · {t.account_name}
                        </span>
                      </span>
                    </button>

                    <div className="col-start-1 row-start-2 min-w-0 md:col-start-2 md:row-start-1 md:justify-self-end">
                      <CustomSelect
                        ariaLabel={`Category for ${t.name}`}
                        className="w-full md:min-w-44"
                        value={t.user_category_id ?? ""}
                        onChange={(v) => setCategory.mutate({ id: t.id, categoryId: v || null })}
                        placeholder="Uncategorized"
                        options={(categories.data?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
                      />
                    </div>

                    <button
                      type="button"
                      aria-pressed={t.exclude_from_budgets === 1}
                      aria-label={`${t.exclude_from_budgets === 1 ? "Include" : "Exclude"} ${t.name} ${t.exclude_from_budgets === 1 ? "in" : "from"} budgets`}
                      onClick={() => toggleExclude.mutate({ id: t.id, exclude: t.exclude_from_budgets !== 1 })}
                      className={`col-start-2 row-start-2 flex h-10 select-none items-center justify-self-end gap-2 rounded-xl border px-3 text-xs font-medium transition-colors md:col-start-3 md:row-start-1 ${
                        t.exclude_from_budgets === 1
                          ? "border-danger bg-[var(--danger-soft)] text-danger"
                          : "border-border bg-surface text-text-muted hover:border-danger/50 hover:text-danger"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-4 w-4 items-center justify-center rounded-[3px] border ${
                          t.exclude_from_budgets === 1
                            ? "border-danger bg-danger text-[var(--danger-foreground)]"
                            : "border-border bg-surface"
                        }`}
                      >
                        {t.exclude_from_budgets === 1 && (
                          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
                            <path d="M3 3L9 9M9 3L3 9" />
                          </svg>
                        )}
                      </span>
                      Exclude
                    </button>

                    <div className="col-start-2 row-start-1 flex items-center justify-end gap-2 md:contents">
                      <span
                        className={`money shrink-0 justify-self-end text-right text-[15px] font-semibold tabular-nums md:col-start-4 md:row-start-1 ${
                          isExpense ? "text-danger" : "text-success"
                        }`}
                      >
                        <Money cents={t.amount_cents} signed />
                      </span>
                      <button
                        type="button"
                        aria-label={`${expanded ? "Hide" : "Show"} details for ${t.name}`}
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : t.id)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text md:col-start-5 md:row-start-1 md:justify-self-end"
                      >
                        <ChevronDown
                          size={16}
                          aria-hidden
                          className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                        />
                      </button>
                    </div>
                  </div>

                  {/* Secondary details / manual-row actions only. */}
                  {expanded && (
                    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-surface-muted/40 px-4 py-2.5 md:col-span-5 md:px-5">
                      <span className="text-xs text-text-muted">Source: {t.source === "manual" ? "Manual" : t.source}</span>
                      <div className="flex-1" />
                      {t.source === "manual" && (
                        <button
                          aria-label={`Edit ${t.name}`}
                          title="Edit transaction"
                          onClick={() => {
                            setError(null);
                            setEditId(t.id);
                            setEditName(t.name);
                            setEditAmount((t.amount_cents / 100).toFixed(2));
                            setEditDate(t.date);
                          }}
                          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
                        >
                          <Pencil size={14} />
                          Edit
                        </button>
                      )}
                      {t.source === "manual" && (
                        <button
                          aria-label={`Delete ${t.name}`}
                          title="Delete transaction"
                          onClick={() => remove.mutate(t)}
                          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted transition-colors hover:bg-[var(--danger-soft)] hover:text-danger"
                        >
                          <Trash2 size={14} />
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {data.rows.length < data.total && (
              <button
                type="button"
                onClick={() => txQuery.fetchNextPage()}
                disabled={txQuery.isFetchingNextPage}
                className="mt-2 w-full rounded-lg border border-border bg-surface py-2.5 text-sm font-medium text-text-muted transition-colors hover:text-text"
              >
                {txQuery.isFetchingNextPage
                  ? "Loading…"
                  : `Load more (${data.total - data.rows.length} more)`}
              </button>
            )}
          </div>
        )}
      </Card>
    </Page>
  );
}
