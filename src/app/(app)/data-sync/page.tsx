"use client";

import { useEffect, useState } from "react";
import { usePageTitle } from "@/lib/use-page-title";
import { SettingsGroup } from "@/components/ui/settings-group";
import { ConnectionHealthCard } from "@/components/connection-health-card";
import { PlaidSettingsCard } from "@/components/plaid-settings-card";
import { SimpleFinSettingsCard } from "@/components/simplefin-settings-card";
import { AkoyaSettingsCard } from "@/components/akoya-settings-card";
import { CsvImportCard } from "@/components/csv-import-card";
import { DataQualityCard } from "@/components/data-quality-card";

export default function DataSyncPage() {
  usePageTitle("Data & Sync");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!msg) return;
    const timer = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [msg]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-text">Data & Connection Health</h1>
        <p className="mt-1 text-sm text-text-muted">
          Manage financial-data providers, connection health, refreshes, historical backfills, and manual data imports.
        </p>
      </div>

      {msg && <p role="status" className="rounded-xl bg-[var(--success-soft)] px-4 py-3 text-sm font-medium text-success">{msg}</p>}
      {err && <p role="alert" className="rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-sm font-medium text-danger">{err}</p>}

      <SettingsGroup title="Status & refresh" description="See every linked institution, the accounts it supplies, and whether anything needs attention.">
        <ConnectionHealthCard setMsg={setMsg} setErr={setErr} />
      </SettingsGroup>

      <SettingsGroup title="Data quality & coverage" description="Normalize institution names, review card identity confidence, and audit provider/account integrity.">
        <DataQualityCard setMsg={setMsg} setErr={setErr} />
      </SettingsGroup>

      <SettingsGroup title="Financial data providers" description="Connect institutions and use provider-specific recovery or historical-data tools.">
        <PlaidSettingsCard setMsg={setMsg} setErr={setErr} />
        <SimpleFinSettingsCard setMsg={setMsg} setErr={setErr} />
        <AkoyaSettingsCard setMsg={setMsg} setErr={setErr} />
      </SettingsGroup>

      <SettingsGroup title="Imports & migration" description="Bring in transaction history that an aggregator cannot provide.">
        <CsvImportCard setMsg={setMsg} setErr={setErr} />
      </SettingsGroup>
    </div>
  );
}
