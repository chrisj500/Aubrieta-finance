"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface SimpleFinConnection {
  id: string;
  external_connection_id: string | null;
  institution_name: string | null;
  institution_external_id: string | null;
  environment: string | null;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  accounts: Array<{ id: string; name: string }>;
}

interface PendingGrant {
  id: string;
  host: string;
  claimedAt: string;
}

type ConnectResult =
  | {
      connected: true;
      connectionCount: number;
      accountCount: number;
      synced: number;
    }
  | {
      connected: false;
      pendingGrantId: string;
      error: string;
    };

export function SimpleFinSettingsCard({
  setMsg,
  setErr,
}: {
  setMsg: (value: string | null) => void;
  setErr: (value: string | null) => void;
}) {
  const qc = useQueryClient();
  const [setupToken, setSetupToken] = useState("");

  const state = useQuery({
    queryKey: ["simplefin-connections"],
    queryFn: () =>
      api.get<{
        connections: SimpleFinConnection[];
        pendingGrants: PendingGrant[];
      }>("/api/simplefin/connections"),
  });

  function refreshFinance() {
    qc.invalidateQueries({ queryKey: ["simplefin-connections"] });
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  }

  function handleConnectResult(result: ConnectResult) {
    refreshFinance();
    if (result.connected) {
      setSetupToken("");
      setErr(null);
      setMsg(
        `SimpleFIN connected — ${result.connectionCount} connection(s), ${result.accountCount} account(s), ${result.synced} transaction(s) synced.`,
      );
      return;
    }
    setErr(
      `The one-time SimpleFIN token was claimed safely, but setup could not finish: ${result.error} Use “Retry setup” below; you do not need another token.`,
    );
  }

  const connect = useMutation({
    mutationFn: () => api.post<ConnectResult>("/api/simplefin/connect", { setupToken }),
    onSuccess: handleConnectResult,
    onError: (e) =>
      setErr(
        e instanceof Error
          ? e.message
          : "Could not claim the SimpleFIN setup token.",
      ),
  });

  const retry = useMutation({
    mutationFn: (id: string) =>
      api.post<ConnectResult>(`/api/simplefin/grants/${id}/retry`),
    onSuccess: handleConnectResult,
    onError: (e) =>
      setErr(
        e instanceof Error ? e.message : "Could not retry SimpleFIN setup.",
      ),
  });

  const discard = useMutation({
    mutationFn: (id: string) => api.del(`/api/simplefin/grants/${id}`),
    onSuccess: () => {
      setMsg("Saved SimpleFIN claim discarded.");
      qc.invalidateQueries({ queryKey: ["simplefin-connections"] });
    },
    onError: (e) =>
      setErr(
        e instanceof Error ? e.message : "Could not discard the saved claim.",
      ),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/simplefin/connections/${id}`),
    onSuccess: () => {
      setMsg(
        "SimpleFIN connection removed from Aubrieta. Existing account and transaction history was retained.",
      );
      refreshFinance();
    },
    onError: (e) =>
      setErr(
        e instanceof Error ? e.message : "Could not remove SimpleFIN connection.",
      ),
  });

  return (
    <Card className="lg:col-span-2">
      <CardTitle>SimpleFIN connections</CardTitle>
      <p className="mt-1 text-sm text-text-muted">
        SimpleFIN is a low-cost, provider-neutral fallback for balances and
        transactions. Generate a one-time Setup Token in your SimpleFIN Bridge
        or compatible server and paste it here. Aubrieta claims it once, then
        encrypts the returned Access URL at rest.
      </p>

      <div className="mt-4">
        <label className="mb-1 block text-xs text-text-muted">
          One-time Setup Token
        </label>
        <textarea
          aria-label="SimpleFIN setup token"
          value={setupToken}
          onChange={(e) => setSetupToken(e.target.value)}
          placeholder="Paste the setup token from SimpleFIN Bridge"
          autoComplete="off"
          spellCheck={false}
          className="min-h-24 w-full rounded-lg border border-border bg-background p-3 font-mono text-xs text-text"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            disabled={connect.isPending || !setupToken.trim()}
            onClick={() => connect.mutate()}
          >
            {connect.isPending ? "Connecting…" : "Connect SimpleFIN"}
          </Button>
          <p className="text-xs text-text-muted">
            Setup Tokens are single-use. Aubrieta never displays the resulting
            Access URL.
          </p>
        </div>
      </div>

      {(state.data?.pendingGrants ?? []).length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Claimed setup awaiting completion
          </p>
          <div className="mt-2 space-y-2">
            {(state.data?.pendingGrants ?? []).map((grant) => (
              <div
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-text">{grant.host}</p>
                  <p className="text-xs text-text-muted">
                    Claimed {new Date(grant.claimedAt).toLocaleString()} ·
                    Access URL stored encrypted
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate(grant.id)}
                  >
                    Retry setup
                  </Button>
                  <button
                    className="text-xs text-text-muted hover:text-danger"
                    disabled={discard.isPending}
                    onClick={() => discard.mutate(grant.id)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(state.data?.connections ?? []).length > 0 && (
        <div className="mt-5 space-y-2 border-t border-border pt-4">
          {(state.data?.connections ?? []).map((connection) => (
            <div
              key={connection.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <div>
                <p className="font-medium text-text">
                  {connection.institution_name || "SimpleFIN institution"}
                </p>
                <p className="text-xs text-text-muted">
                  {connection.accounts.map((a) => a.name).join(", ") ||
                    "no accounts"}
                  {connection.last_sync_at
                    ? ` · synced ${new Date(
                        connection.last_sync_at,
                      ).toLocaleString()}`
                    : ""}
                </p>
                {connection.last_error && (
                  <p className="mt-0.5 text-xs text-danger">
                    {connection.last_error}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Badge
                  className={
                    connection.status === "active"
                      ? "bg-success/10 text-success"
                      : "bg-danger/10 text-danger"
                  }
                >
                  {connection.status}
                </Badge>
                <button
                  className="text-xs text-text-muted hover:text-danger"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(connection.id)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
