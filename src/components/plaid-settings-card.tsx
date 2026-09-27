"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api-client";
import { useEscapeToClose } from "@/lib/use-escape-to-close";
import { PlaidLinkLauncher } from "@/components/plaid-link-launcher";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CustomSelect } from "@/components/ui/custom-select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface PlaidItem {
  id: string;
  institution_name: string | null;
  environment: string;
  status: string;
  accounts: Array<{ name: string }>;
}

export function PlaidSettingsCard({
  setMsg,
  setErr,
}: {
  setMsg: (value: string | null) => void;
  setErr: (value: string | null) => void;
}) {
  const qc = useQueryClient();
  const creds = useQuery({
    queryKey: ["plaid-creds"],
    queryFn: () => api.get<{ environments: Array<{ environment: string; hasKeys: boolean; updatedAt: string }> }>("/api/plaid/credentials"),
  });
  const items = useQuery({
    queryKey: ["plaid-items"],
    queryFn: () => api.get<{ items: PlaidItem[] }>("/api/plaid/items"),
  });

  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [environment, setEnvironment] = useState<"sandbox" | "production">("sandbox");
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [reconnectItemId, setReconnectItemId] = useState<string | null>(null);
  const [reconnectingItem, setReconnectingItem] = useState<string | null>(null);
  const [resyncingItem, setResyncingItem] = useState<string | null>(null);
  const [showPlaidHelp, setShowPlaidHelp] = useState(false);
  const [confirmRemoveItem, setConfirmRemoveItem] = useState<string | null>(null);
  useEscapeToClose(() => setShowPlaidHelp(false), showPlaidHelp);

  function refreshFinance() {
    for (const key of ["connection-health", "plaid-items", "accounts", "transactions", "summary", "reports", "planning"]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }

  const saveCreds = useMutation({
    mutationFn: () => api.put("/api/plaid/credentials", { clientId, secret, environment }),
    onSuccess: () => {
      setClientId("");
      setSecret("");
      setErr(null);
      setMsg("Plaid connection keys saved and checked.");
      qc.invalidateQueries({ queryKey: ["plaid-creds"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not save Plaid keys."),
  });

  async function startLink() {
    setLinking(true);
    setErr(null);
    try {
      const res = await api.get<{ linkToken: string }>(`/api/plaid/link-token?environment=${environment}`);
      setLinkToken(res.linkToken);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create a Plaid link token.");
      setLinking(false);
    }
  }

  const syncNow = useMutation({
    mutationFn: () => api.post<{ results: Array<{ institution_name: string | null; added: number; modified: number; removed: number; ok: boolean; error?: string }> }>("/api/transactions/sync"),
    onSuccess: (data) => {
      const failed = data.results.filter((result) => !result.ok);
      const changed = data.results.reduce((sum, result) => sum + result.added + result.modified, 0);
      if (failed.length) {
        setErr(`Sync finished with errors on ${failed.map((result) => result.institution_name ?? "an institution").join(", ")}.`);
      } else {
        setErr(null);
        setMsg(changed === 0 ? "Plaid is up to date." : `Plaid sync complete — ${changed} transaction(s) updated.`);
      }
      refreshFinance();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Plaid sync failed."),
  });

  const resyncItem = useMutation({
    mutationFn: async (id: string) => {
      setResyncingItem(id);
      try {
        return await api.post<{ ok: boolean; added: number; modified: number; removed: number; oldestDate?: string | null; error?: string | null; note?: string }>(
          "/api/plaid/resync",
          { itemId: id },
        );
      } finally {
        setResyncingItem(null);
      }
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setErr(result.error ? `History re-import failed: ${result.error}` : "History re-import failed.");
        return;
      }
      setErr(null);
      const changed = result.added + result.modified;
      setMsg(
        result.note ??
          `Plaid history re-import complete — ${changed === 0 ? "no new transactions" : `${changed} transaction(s) added/updated`}${result.oldestDate ? `; oldest available ${result.oldestDate}` : ""}.`,
      );
      refreshFinance();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "History re-import failed."),
  });

  const removeItem = useMutation({
    mutationFn: (id: string) => api.del(`/api/plaid/items/${id}`),
    onSuccess: () => {
      setConfirmRemoveItem(null);
      setErr(null);
      setMsg("Plaid connection removed. Existing transactions were retained.");
      refreshFinance();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not remove the Plaid connection."),
  });

  return (
    <Card className="lg:col-span-2" id="provider-plaid">
      <CardTitle>Plaid connections</CardTitle>
      <p className="mt-1 text-sm text-text-muted">
        Connect banks through Plaid, refresh current activity, or re-import the history Plaid still exposes for an institution.
      </p>

      {(creds.isError && !creds.data) || (items.isError && !items.data) ? (
        <div role="alert" className="mt-3 rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-sm text-danger">
          Couldn&apos;t load all Plaid connection details.
          <Button className="ml-3" size="sm" variant="secondary" onClick={() => { creds.refetch(); items.refetch(); }}>
            Try again
          </Button>
        </div>
      ) : null}

      <div className="mt-3">
        {!showPlaidHelp ? (
          <button
            type="button"
            onClick={() => setShowPlaidHelp(true)}
            className="flex items-center gap-1.5 text-sm font-medium text-accent-text transition-colors hover:underline"
          >
            <ExternalLink size={14} aria-hidden /> Need keys? Walk me through getting them
          </button>
        ) : (
          <div className="rounded-xl border border-border bg-surface-muted/50 p-4 text-sm">
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium text-text">Getting Plaid keys</p>
              <button type="button" onClick={() => setShowPlaidHelp(false)} className="text-xs text-text-muted hover:text-text">Hide</button>
            </div>
            <ol className="mt-2 list-inside list-decimal space-y-1.5 text-text-muted">
              <li>Create an account at <a href="https://dashboard.plaid.com/signup" target="_blank" rel="noreferrer" className="font-medium text-accent-text">dashboard.plaid.com/signup</a>.</li>
              <li>Open Dashboard → Developers → Keys.</li>
              <li>Copy the Client ID and the matching Sandbox or Production secret.</li>
              <li>Save the keys below, then connect an institution.</li>
            </ol>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label className="mb-1 block text-xs text-text-muted">Client ID</label>
          <Input aria-label="Plaid client ID" placeholder="6543a1b2…" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="min-w-48 flex-1">
          <label className="mb-1 block text-xs text-text-muted">Secret</label>
          <PasswordInput aria-label="Plaid secret" placeholder="sandbox_… / production_…" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
        <div className="min-w-32">
          <label className="mb-1 block text-xs text-text-muted">Environment</label>
          <CustomSelect
            ariaLabel="Plaid environment"
            value={environment}
            onChange={(value) => setEnvironment(value as "sandbox" | "production")}
            options={[
              { value: "sandbox", label: "Sandbox", hint: "test data" },
              { value: "production", label: "Production", hint: "real banks" },
            ]}
          />
        </div>
        <Button variant="secondary" disabled={saveCreds.isPending || !clientId || !secret} onClick={() => saveCreds.mutate()}>
          {saveCreds.isPending ? "Checking…" : "Save & check keys"}
        </Button>
      </div>

      <div className="mt-2 text-xs text-text-muted">
        {creds.data?.environments.map((entry) => (
          <span key={entry.environment} className="mr-3">
            {entry.environment}: {entry.hasKeys ? "keys saved" : "no keys"}
          </span>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button disabled={linking} onClick={startLink}>{linking ? "Opening…" : "+ Connect a bank"}</Button>
        {(items.data?.items.length ?? 0) > 0 && (
          <Button variant="secondary" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
            {syncNow.isPending ? "Syncing…" : "Sync now"}
          </Button>
        )}
      </div>

      {linkToken && (
        <PlaidLinkLauncher
          token={linkToken}
          onSuccess={async (publicToken, institutionName) => {
            const reconnecting = reconnectItemId !== null;
            await api.post("/api/plaid/exchange", {
              publicToken,
              environment,
              institutionId: null,
              institutionName: institutionName ?? null,
              updateItemId: reconnectItemId ?? undefined,
            });
            setLinkToken(null);
            setReconnectItemId(null);
            setLinking(false);
            refreshFinance();
            setMsg(reconnecting ? "Bank reconnected — refresh to pull the latest activity." : "Bank connected — refresh to pull transactions.");
          }}
          onExit={() => {
            setLinkToken(null);
            setReconnectItemId(null);
            setLinking(false);
          }}
        />
      )}

      <div className="mt-4 space-y-2">
        {(items.data?.items ?? []).map((item) => (
          <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-muted px-4 py-2.5 text-sm">
            <span className="min-w-0">
              <span className="block truncate text-text">
                {item.institution_name ?? (item.accounts.length ? item.accounts.map((account) => account.name).join(", ") : "Institution")}
                <span className="text-text-muted"> · {item.environment}</span>
              </span>
              {!item.institution_name && item.accounts.length > 0 && (
                <span className="block text-xs text-text-muted">Bank name not captured — showing account names</span>
              )}
            </span>
            <span className="flex flex-wrap items-center justify-end gap-3">
              <Badge className={item.status === "active" || item.status === "linked" ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}>
                {item.status}
              </Badge>
              {item.status !== "active" && item.status !== "linked" && (
                <button
                  type="button"
                  onClick={async () => {
                    setReconnectingItem(item.id);
                    setErr(null);
                    try {
                      const res = await api.get<{ linkToken: string }>(`/api/plaid/link-token?environment=${item.environment}&updateItemId=${item.id}`);
                      setLinkToken(res.linkToken);
                      setReconnectItemId(item.id);
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : "Could not start reconnect.");
                    } finally {
                      setReconnectingItem(null);
                    }
                  }}
                  disabled={reconnectingItem === item.id}
                  className="text-xs text-accent-text hover:underline disabled:opacity-50"
                >
                  {reconnectingItem === item.id ? "Opening…" : "Reconnect"}
                </button>
              )}
              <button
                type="button"
                onClick={() => resyncItem.mutate(item.id)}
                disabled={resyncingItem === item.id}
                className="text-xs text-text-muted hover:text-accent-text disabled:opacity-50"
                title="Re-import all transaction history currently available from Plaid for this institution"
              >
                {resyncingItem === item.id ? "Importing…" : "Re-import history"}
              </button>
              <button type="button" onClick={() => setConfirmRemoveItem(item.id)} className="text-xs text-text-muted hover:text-danger">Remove</button>
            </span>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmRemoveItem !== null}
        title="Remove this bank connection?"
        message="The connection will be removed. Synced accounts and transaction history stay in Aubrieta."
        confirmLabel="Remove"
        busy={removeItem.isPending}
        onCancel={() => setConfirmRemoveItem(null)}
        onConfirm={() => { if (confirmRemoveItem) removeItem.mutate(confirmRemoveItem); }}
      />
    </Card>
  );
}
