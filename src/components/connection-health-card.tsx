"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import type { ConnectionHealthResult } from "@/server/domain/connection-health";

function when(value: string | null): string {
  if (!value) return "No successful sync recorded";
  return `Last successful sync ${new Date(value).toLocaleString()}`;
}

function providerAnchor(provider: string): string | null {
  return provider === "plaid" || provider === "teller" || provider === "simplefin" || provider === "akoya"
    ? `#provider-${provider}`
    : null;
}

export function ConnectionHealthCard({
  setMsg,
  setErr,
}: {
  setMsg: (value: string | null) => void;
  setErr: (value: string | null) => void;
}) {
  const qc = useQueryClient();
  const health = useQuery({
    queryKey: ["connection-health"],
    queryFn: () => api.get<ConnectionHealthResult>("/api/connections/health"),
  });

  const sync = useMutation({
    mutationFn: () =>
      api.post<{
        results: Array<{
          provider?: string;
          institutionName?: string | null;
          institution_name?: string | null;
          ok: boolean;
          error?: string;
          added: number;
          modified: number;
        }>;
      }>("/api/transactions/sync"),
    onSuccess: (data) => {
      const failed = data.results.filter((r) => !r.ok);
      const changed = data.results.reduce((n, r) => n + r.added + r.modified, 0);
      if (failed.length) {
        setErr(
          `Sync finished with ${failed.length} connection issue${failed.length === 1 ? "" : "s"}. Review Connection health for details.`,
        );
      } else {
        setErr(null);
        setMsg(`Connections refreshed — ${changed === 0 ? "nothing new" : `${changed} transaction(s) updated`}.`);
      }
      for (const key of [
        "connection-health",
        "plaid-items",
        "teller-connections",
        "simplefin-connections",
        "akoya-connections",
        "accounts",
        "transactions",
        "summary",
      ]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not refresh connections."),
  });

  if (health.isError && !health.data) {
    return (
      <Card className="lg:col-span-2" id="connection-health">
        <CardTitle>Connection health</CardTitle>
        <div role="alert" className="mt-3 rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-sm text-danger">
          Couldn&apos;t load connection health.
          <Button className="ml-3" size="sm" variant="secondary" disabled={health.isFetching} onClick={() => health.refetch()}>
            {health.isFetching ? "Retrying…" : "Try again"}
          </Button>
        </div>
      </Card>
    );
  }

  const data = health.data;
  const summary = data?.summary;

  return (
    <Card className="lg:col-span-2" id="connection-health">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Connection health</CardTitle>
          <p className="mt-1 text-sm text-text-muted">
            One view of every linked financial-data connection. Health comes from Aubrieta&apos;s recorded provider status and sync results.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={sync.isPending || !summary?.connectionCount}
          onClick={() => sync.mutate()}
        >
          <RefreshCw size={14} aria-hidden className={sync.isPending ? "animate-spin" : undefined} />
          {sync.isPending ? "Refreshing…" : "Refresh all"}
        </Button>
      </div>

      {health.isLoading && !data ? (
        <p className="mt-4 text-sm text-text-muted">Checking connections…</p>
      ) : summary?.connectionCount === 0 ? (
        <div className="mt-4 rounded-xl border border-border bg-surface-muted/50 p-4">
          <p className="font-medium text-text">
            {summary.manualAccountCount > 0 ? "Manual accounts only" : "No institutions connected yet"}
          </p>
          <p className="mt-1 text-sm text-text-muted">
            {summary.manualAccountCount > 0
              ? `${summary.manualAccountCount} manual account${summary.manualAccountCount === 1 ? " is" : "s are"} working without a data provider. Connect a provider below whenever you want automatic updates.`
              : "Connect Plaid, Teller, SimpleFIN, or Akoya below when you want automatic account updates."}
          </p>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <Badge className="bg-success/10 text-success">{summary?.healthyCount ?? 0} healthy</Badge>
            {(summary?.needsAttentionCount ?? 0) > 0 && (
              <Badge className="bg-danger/10 text-danger">{summary?.needsAttentionCount} need attention</Badge>
            )}
            {(summary?.neverSyncedCount ?? 0) > 0 && (
              <Badge className="bg-surface-muted text-text-muted">{summary?.neverSyncedCount} without a successful sync</Badge>
            )}
            {summary?.lastSuccessfulSyncAt && (
              <span className="self-center text-text-muted">Latest success {new Date(summary.lastSuccessfulSyncAt).toLocaleString()}</span>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {data?.connections.map((connection) => {
              const anchor = providerAnchor(connection.provider);
              const attention = connection.state === "needs_attention";
              return (
                <div key={connection.id} className="rounded-xl border border-border px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {attention ? (
                          <AlertTriangle size={16} className="text-danger" aria-hidden />
                        ) : (
                          <CheckCircle2 size={16} className="text-success" aria-hidden />
                        )}
                        <p className="font-medium text-text">{connection.institutionName}</p>
                        <Badge className="bg-surface-muted text-text-muted">{connection.providerName}</Badge>
                        {connection.environment && <span className="text-xs text-text-muted">{connection.environment}</span>}
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        {connection.accountCount === 0
                          ? "No linked accounts"
                          : `${connection.accountCount} account${connection.accountCount === 1 ? "" : "s"}: ${connection.accountNames.join(", ")}`}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">{when(connection.lastSuccessfulSyncAt)}</p>
                      {connection.lastError && <p className="mt-1 text-sm text-danger">{connection.lastError}</p>}
                      {connection.capabilities.length > 0 && (
                        <p className="mt-1 text-[11px] text-text-muted">Capabilities: {connection.capabilities.join(" · ")}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge className={attention ? "bg-danger/10 text-danger" : "bg-success/10 text-success"}>
                        {attention ? "Needs attention" : "Healthy"}
                      </Badge>
                      {anchor && (
                        <a className="text-xs font-medium text-accent-text hover:underline" href={anchor}>
                          {attention ? "Review connection" : "Manage"}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
