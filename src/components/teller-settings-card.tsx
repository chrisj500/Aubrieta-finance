"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CustomSelect } from "@/components/ui/custom-select";
import { TellerConnectLauncher, type TellerEnrollment } from "@/components/teller-connect-launcher";

type TellerEnvironment = "sandbox" | "development" | "production";

interface ConnectConfig {
  applicationId: string;
  environment: TellerEnvironment;
  nonce: string;
  products: string[];
  enrollmentId: string | null;
}

export function TellerSettingsCard({
  setMsg,
  setErr,
}: {
  setMsg: (value: string | null) => void;
  setErr: (value: string | null) => void;
}) {
  const qc = useQueryClient();
  const [environment, setEnvironment] = useState<TellerEnvironment>("sandbox");
  const [applicationId, setApplicationId] = useState("");
  const [tokenSigningKey, setTokenSigningKey] = useState("");
  const [certificatePem, setCertificatePem] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [connectConfig, setConnectConfig] = useState<ConnectConfig | null>(null);

  const creds = useQuery({
    queryKey: ["teller-creds"],
    queryFn: () => api.get<{
      environments: Array<{
        environment: TellerEnvironment;
        hasKeys: boolean;
        updatedAt: string;
        publicConfig: { applicationId?: string };
      }>;
    }>("/api/teller/credentials"),
  });
  const connections = useQuery({
    queryKey: ["teller-connections"],
    queryFn: () => api.get<{
      connections: Array<{
        id: string;
        external_connection_id: string | null;
        institution_name: string | null;
        environment: TellerEnvironment | null;
        status: string;
        last_sync_at: string | null;
        last_error: string | null;
        accounts: Array<{ id: string; name: string }>;
      }>;
    }>("/api/teller/connections"),
  });

  const save = useMutation({
    mutationFn: () =>
      api.put("/api/teller/credentials", {
        environment,
        applicationId,
        tokenSigningKey,
        certificatePem: certificatePem || null,
        privateKeyPem: privateKeyPem || null,
      }),
    onSuccess: () => {
      setApplicationId("");
      setTokenSigningKey("");
      setCertificatePem("");
      setPrivateKeyPem("");
      setMsg("Teller configuration saved.");
      qc.invalidateQueries({ queryKey: ["teller-creds"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not save Teller configuration."),
  });

  async function startConnect(env = environment, enrollmentId?: string) {
    setErr(null);
    try {
      const q = new URLSearchParams({ environment: env });
      if (enrollmentId) q.set("enrollmentId", enrollmentId);
      setConnectConfig(await api.get<ConnectConfig>(`/api/teller/connect-config?${q.toString()}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start Teller Connect.");
    }
  }

  async function finishConnect(enrollment: TellerEnrollment) {
    if (!connectConfig) return;
    setErr(null);
    try {
      const result = await api.post<{ connectionId: string; accountCount: number; synced: number }>("/api/teller/exchange", {
        environment: connectConfig.environment,
        nonce: connectConfig.nonce,
        accessToken: enrollment.accessToken,
        tellerUserId: enrollment.user.id,
        enrollmentId: enrollment.enrollment.id,
        institutionName: enrollment.enrollment.institution?.name ?? null,
        signatures: enrollment.signatures,
      });
      setConnectConfig(null);
      setMsg(`Teller connected — ${result.accountCount} account(s), ${result.synced} transaction(s) synced.`);
      qc.invalidateQueries({ queryKey: ["teller-connections"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    } catch (e) {
      setConnectConfig(null);
      setErr(e instanceof Error ? e.message : "Could not complete Teller connection.");
    }
  }

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/teller/connections/${id}`),
    onSuccess: () => {
      setMsg("Teller connection removed. Existing transaction history was retained where possible.");
      qc.invalidateQueries({ queryKey: ["teller-connections"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not remove Teller connection."),
  });

  const configured = creds.data?.environments.find((e) => e.environment === environment);

  return (
    <Card className="lg:col-span-2">
      <CardTitle>Teller connections</CardTitle>
      <p className="mt-1 text-sm text-text-muted">
        Optional second bank-data provider. Teller supports balances and categorized transactions; development connects
        real banks for free up to Teller&apos;s development enrollment limit. Certificates and access tokens are encrypted
        at rest.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Application ID</label>
          <Input value={applicationId} onChange={(e) => setApplicationId(e.target.value)} placeholder={configured?.publicConfig.applicationId || "app_…"} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Token Signing Key</label>
          <PasswordInput value={tokenSigningKey} onChange={(e) => setTokenSigningKey(e.target.value)} placeholder="Ed25519 public key" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Environment</label>
          <CustomSelect
            ariaLabel="Teller environment"
            value={environment}
            onChange={(v) => setEnvironment(v as TellerEnvironment)}
            options={[
              { value: "sandbox", label: "Sandbox", hint: "test data" },
              { value: "development", label: "Development", hint: "real banks" },
              { value: "production", label: "Production", hint: "live" },
            ]}
          />
        </div>
        <div className="flex items-end gap-2">
          <Button
            variant="secondary"
            disabled={save.isPending || !applicationId || !tokenSigningKey || (environment !== "sandbox" && (!certificatePem || !privateKeyPem))}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save Teller configuration"}
          </Button>
          <Button disabled={!configured} onClick={() => startConnect()}>
            Connect bank
          </Button>
        </div>
      </div>

      {environment !== "sandbox" && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Client certificate (PEM)</label>
            <textarea className="min-h-28 w-full rounded-lg border border-border bg-background p-2 font-mono text-xs text-text" value={certificatePem} onChange={(e) => setCertificatePem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">Private key (PEM)</label>
            <textarea className="min-h-28 w-full rounded-lg border border-border bg-background p-2 font-mono text-xs text-text" value={privateKeyPem} onChange={(e) => setPrivateKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" />
          </div>
        </div>
      )}

      <div className="mt-2 text-xs text-text-muted">
        {creds.data?.environments.map((e) => (
          <span key={e.environment} className="mr-3">✓ {e.environment}: {e.publicConfig.applicationId || "configured"}</span>
        ))}
      </div>

      {(connections.data?.connections ?? []).length > 0 && (
        <div className="mt-5 space-y-2 border-t border-border pt-4">
          {(connections.data?.connections ?? []).map((connection) => (
            <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-text">{connection.institution_name || "Teller institution"}</p>
                <p className="text-xs text-text-muted">
                  {connection.environment || "unknown"} · {connection.accounts.map((a) => a.name).join(", ") || "no accounts"}
                  {connection.last_sync_at ? ` · synced ${new Date(connection.last_sync_at).toLocaleString()}` : ""}
                </p>
                {connection.last_error && <p className="mt-0.5 text-xs text-danger">{connection.last_error}</p>}
              </div>
              <div className="flex items-center gap-3">
                <Badge className={connection.status === "active" ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}>{connection.status}</Badge>
                {connection.status !== "active" && connection.external_connection_id && connection.environment && (
                  <button className="text-xs text-accent-text hover:underline" onClick={() => startConnect(connection.environment!, connection.external_connection_id!)}>Reconnect</button>
                )}
                <button className="text-xs text-text-muted hover:text-danger" disabled={remove.isPending} onClick={() => remove.mutate(connection.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {connectConfig && (
        <TellerConnectLauncher
          config={connectConfig}
          onSuccess={finishConnect}
          onExit={() => setConnectConfig(null)}
          onError={(message) => {
            setConnectConfig(null);
            setErr(message);
          }}
        />
      )}
    </Card>
  );
}
