"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CustomSelect } from "@/components/ui/custom-select";

type AkoyaEnvironment = "sandbox" | "production";

interface Connection {
  id: string;
  external_connection_id: string | null;
  institution_external_id: string | null;
  institution_name: string | null;
  environment: string | null;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  accounts: Array<{ id: string; name: string }>;
}

export function AkoyaSettingsCard({
  setMsg,
  setErr,
}: {
  setMsg: (value: string | null) => void;
  setErr: (value: string | null) => void;
}) {
  const qc = useQueryClient();
  const [environment, setEnvironment] = useState<AkoyaEnvironment>("sandbox");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [providerId, setProviderId] = useState("mikomo");

  useEffect(() => {
    if (!redirectUri && typeof window !== "undefined") {
      setRedirectUri(`${window.location.origin}/api/akoya/callback`);
    }
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const status = url.searchParams.get("akoya");
      if (status === "connected") {
        setMsg("Akoya connection completed and synced.");
      } else if (status === "connected_sync_error") {
        setErr("Akoya authorization succeeded, but the first data sync needs attention.");
      } else if (status === "error") {
        setErr("Akoya authorization was not completed. Check the registered redirect URI and try again.");
      }
      if (status) {
        url.searchParams.delete("akoya");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, [redirectUri, setErr, setMsg]);

  const creds = useQuery({
    queryKey: ["akoya-creds"],
    queryFn: () =>
      api.get<{
        environments: Array<{
          environment: AkoyaEnvironment;
          publicConfig: { clientId?: string; redirectUri?: string };
          updatedAt: string;
        }>;
      }>("/api/akoya/credentials"),
  });

  const connections = useQuery({
    queryKey: ["akoya-connections"],
    queryFn: () =>
      api.get<{ connections: Connection[] }>("/api/akoya/connections"),
  });

  const configured = useMemo(
    () => creds.data?.environments.find((e) => e.environment === environment),
    [creds.data, environment],
  );

  useEffect(() => {
    if (!configured) return;
    if (!clientId) setClientId(configured.publicConfig.clientId ?? "");
    if (configured.publicConfig.redirectUri) {
      setRedirectUri(configured.publicConfig.redirectUri);
    }
  }, [configured, clientId]);

  useEffect(() => {
    if (environment === "sandbox" && !providerId) setProviderId("mikomo");
  }, [environment, providerId]);

  const save = useMutation({
    mutationFn: () =>
      api.put("/api/akoya/credentials", {
        environment,
        clientId,
        clientSecret,
        redirectUri,
      }),
    onSuccess: () => {
      setClientSecret("");
      setMsg("Akoya configuration saved.");
      qc.invalidateQueries({ queryKey: ["akoya-creds"] });
    },
    onError: (e) =>
      setErr(e instanceof Error ? e.message : "Could not save Akoya configuration."),
  });

  const authorize = useMutation({
    mutationFn: () =>
      api.post<{ authorizationUrl: string }>("/api/akoya/authorize", {
        environment,
        providerId,
      }),
    onSuccess: ({ authorizationUrl }) => {
      window.location.assign(authorizationUrl);
    },
    onError: (e) =>
      setErr(e instanceof Error ? e.message : "Could not start Akoya authorization."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/akoya/connections/${id}`),
    onSuccess: () => {
      setMsg("Akoya connection removed and its refresh token revoked where possible.");
      qc.invalidateQueries({ queryKey: ["akoya-connections"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
    onError: (e) =>
      setErr(e instanceof Error ? e.message : "Could not remove Akoya connection."),
  });

  return (
    <Card className="lg:col-span-2">
      <CardTitle>Akoya / FDX connections</CardTitle>
      <p className="mt-1 text-sm text-text-muted">
        Connect through Akoya&apos;s consumer-permissioned FDX APIs. Aubrieta stores the client secret,
        ID token, and rotating refresh token encrypted at rest; data sync uses FDX v3 account,
        balance, liability, and transaction responses.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Environment</label>
          <CustomSelect
            ariaLabel="Akoya environment"
            value={environment}
            onChange={(value) => {
              const next = value as AkoyaEnvironment;
              setEnvironment(next);
              if (next === "sandbox") setProviderId("mikomo");
            }}
            options={[
              { value: "sandbox", label: "Sandbox", hint: "Mikomo test provider" },
              { value: "production", label: "Production", hint: "live providers" },
            ]}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-text-muted">Client ID</label>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={configured?.publicConfig.clientId || "Akoya client ID"}
            autoComplete="off"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-text-muted">Client secret</label>
          <PasswordInput
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Akoya client secret"
            autoComplete="new-password"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-text-muted">Registered redirect URI</label>
          <Input
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder="https://your-aubrieta.example/api/akoya/callback"
            inputMode="url"
          />
        </div>

        <div className="md:col-span-2 flex flex-wrap items-end gap-3">
          <Button
            variant="secondary"
            disabled={
              save.isPending ||
              !clientId.trim() ||
              !clientSecret.trim() ||
              !redirectUri.trim()
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save Akoya configuration"}
          </Button>

          {configured && (
            <span className="text-xs text-text-muted">
              ✓ {configured.environment}: {configured.publicConfig.clientId}
            </span>
          )}
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label className="mb-1 block text-xs text-text-muted">
              Akoya provider / connector ID
            </label>
            <Input
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              placeholder={environment === "sandbox" ? "mikomo" : "provider ID from Akoya Hub"}
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-text-muted">
              Sandbox uses <strong className="text-text">mikomo</strong>. Production connector IDs come
              from the Akoya Data Recipient Hub.
            </p>
          </div>
          <Button
            disabled={authorize.isPending || !configured || !providerId.trim()}
            onClick={() => authorize.mutate()}
          >
            {authorize.isPending ? "Opening Akoya…" : "Connect with Akoya"}
          </Button>
        </div>
      </div>

      {(connections.data?.connections ?? []).length > 0 && (
        <div className="mt-5 space-y-2 border-t border-border pt-4">
          {(connections.data?.connections ?? []).map((connection) => (
            <div
              key={connection.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <div>
                <p className="font-medium text-text">
                  {connection.institution_name ||
                    connection.institution_external_id ||
                    "Akoya institution"}
                </p>
                <p className="text-xs text-text-muted">
                  {connection.environment || "unknown"} ·{" "}
                  {connection.accounts.map((a) => a.name).join(", ") || "no accounts"}
                  {connection.last_sync_at
                    ? ` · synced ${new Date(connection.last_sync_at).toLocaleString()}`
                    : ""}
                </p>
                {connection.last_error && (
                  <p className="mt-0.5 text-xs text-danger">{connection.last_error}</p>
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
                {connection.status !== "active" && connection.institution_external_id && (
                  <button
                    className="text-xs text-accent-text hover:underline"
                    onClick={() => {
                      setEnvironment(
                        connection.environment === "production" ? "production" : "sandbox",
                      );
                      setProviderId(connection.institution_external_id!);
                    }}
                  >
                    Prepare reconnect
                  </button>
                )}
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
