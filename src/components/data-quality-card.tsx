"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Database, Layers3 } from "lucide-react";
import { api } from "@/lib/api-client";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DataQualityResult {
  summary: {
    accountCount: number;
    providerAccountCount: number;
    manualAccountCount: number;
    rawInstitutionCount: number;
    canonicalInstitutionCount: number;
    normalizedAliasCount: number;
    potentialDuplicateCount: number;
    metadataGapCount: number;
    creditCardCount: number;
    exactIdentityCount: number;
    likelyIdentityCount: number;
    genericIdentityCount: number;
    identityOverrideCount: number;
    connectionCount: number;
    connectionIssueCount: number;
    oldestTransactionDate: string | null;
    newestTransactionDate: string | null;
  };
  institutionNormalizations: Array<{ rawName: string; canonicalName: string; accountCount: number }>;
  genericCards: Array<{ id: string; name: string; institutionName: string | null; mask: string | null }>;
  metadataGaps: Array<{ id: string; name: string; reasons: string[] }>;
  duplicateCandidates: Array<{ institutionName: string; mask: string; type: string; accountNames: string[] }>;
  history: Array<{
    connectionId: string;
    provider: string;
    institutionName: string;
    transactionCount: number;
    oldestDate: string | null;
    newestDate: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  }>;
  integrity: { orphanedAccountProviderRefs: number; missingConnectionRefs: number };
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function DataQualityCard({ setMsg, setErr }: { setMsg: (value: string | null) => void; setErr: (value: string | null) => void }) {
  const qc = useQueryClient();
  const [rawName, setRawName] = useState("");
  const [canonicalName, setCanonicalName] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const quality = useQuery({
    queryKey: ["data-quality"],
    queryFn: () => api.get<DataQualityResult>("/api/data-quality"),
  });

  const saveAlias = useMutation({
    mutationFn: () => api.put("/api/institution-aliases", { rawName, canonicalName }),
    onSuccess: () => {
      setRawName("");
      setCanonicalName("");
      setErr(null);
      setMsg("Institution alias saved. Account rollups will use the canonical name.");
      qc.invalidateQueries({ queryKey: ["data-quality"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not save institution alias."),
  });

  if (quality.isLoading && !quality.data) {
    return <Card className="lg:col-span-2"><div className="skeleton h-44" /></Card>;
  }
  if (quality.isError && !quality.data) {
    return (
      <Card className="lg:col-span-2">
        <CardTitle>Data quality</CardTitle>
        <div role="alert" className="mt-3 rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-sm text-danger">
          Couldn&apos;t run the data-quality audit.
          <Button size="sm" variant="secondary" className="ml-3" onClick={() => quality.refetch()}>Try again</Button>
        </div>
      </Card>
    );
  }

  const data = quality.data!;
  const refIntegrityClean = data.integrity.orphanedAccountProviderRefs === 0 && data.integrity.missingConnectionRefs === 0;
  const issueCount = data.summary.connectionIssueCount + data.summary.potentialDuplicateCount + data.summary.metadataGapCount + data.summary.genericIdentityCount;

  return (
    <Card className="lg:col-span-2" id="data-quality">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Data quality</CardTitle>
          <p className="mt-1 text-sm text-text-muted">
            Audit institution normalization, account metadata, card identity, duplicate candidates, and provider history coverage.
          </p>
        </div>
        <Badge className={issueCount === 0 && refIntegrityClean ? "bg-success/10 text-success" : "bg-[var(--warning-soft)] text-[var(--warning)]"}>
          {issueCount === 0 && refIntegrityClean ? "Clean" : `${issueCount} review item${issueCount === 1 ? "" : "s"}`}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface-muted/35 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-muted"><Layers3 size={14} /> Institutions</div>
          <p className="mt-1 text-lg font-semibold text-text">{data.summary.canonicalInstitutionCount}</p>
          <p className="text-xs text-text-muted">from {data.summary.rawInstitutionCount} raw name{data.summary.rawInstitutionCount === 1 ? "" : "s"} · {data.summary.normalizedAliasCount} account{data.summary.normalizedAliasCount === 1 ? "" : "s"} normalized</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-muted/35 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-muted"><Database size={14} /> Card identity</div>
          <p className="mt-1 text-sm font-semibold text-text">{data.summary.exactIdentityCount} exact · {data.summary.likelyIdentityCount} likely · {data.summary.genericIdentityCount} generic</p>
          <p className="mt-1 text-xs text-text-muted">{data.summary.identityOverrideCount} confirmed override{data.summary.identityOverrideCount === 1 ? "" : "s"}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-muted/35 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-muted">{data.summary.potentialDuplicateCount || data.summary.metadataGapCount ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />} Account integrity</div>
          <p className="mt-1 text-sm font-semibold text-text">{data.summary.potentialDuplicateCount} duplicate candidate{data.summary.potentialDuplicateCount === 1 ? "" : "s"}</p>
          <p className="mt-1 text-xs text-text-muted">{data.summary.metadataGapCount} metadata gap{data.summary.metadataGapCount === 1 ? "" : "s"} · refs {refIntegrityClean ? "clean" : "need review"}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-muted/35 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-muted"><Database size={14} /> History coverage</div>
          <p className="mt-1 text-sm font-semibold text-text">{fmtDate(data.summary.oldestTransactionDate)} → {fmtDate(data.summary.newestTransactionDate)}</p>
          <p className="mt-1 text-xs text-text-muted">{data.summary.connectionCount} connection{data.summary.connectionCount === 1 ? "" : "s"} · {data.summary.connectionIssueCount} with sync issues</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <p className="text-xs text-text-muted">Card-identity confidence is diagnostic only; the normal Accounts view stays uncluttered.</p>
        <Button size="sm" variant="secondary" onClick={() => setShowDetails((value) => !value)}>{showDetails ? "Hide audit details" : "Review audit details"}</Button>
      </div>

      {showDetails && (
        <div className="mt-4 space-y-5 border-t border-border pt-4">
          <section>
            <h4 className="text-sm font-semibold text-text">Institution normalization</h4>
            {data.institutionNormalizations.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs text-text-muted">
                {data.institutionNormalizations.map((item) => (
                  <li key={`${item.rawName}:${item.canonicalName}`} className="flex flex-wrap items-center gap-2">
                    <span className="text-text">{item.rawName}</span><span aria-hidden>→</span><span className="font-medium text-accent-text">{item.canonicalName}</span><span>({item.accountCount})</span>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-1 text-xs text-text-muted">No institution aliases are currently changing imported names.</p>}
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_auto] sm:items-end">
              <div><label htmlFor="alias-raw" className="mb-1 block text-xs text-text-muted">Imported name</label><Input id="alias-raw" value={rawName} onChange={(e) => setRawName(e.target.value)} placeholder="e.g. JPMorgan Chase" /></div>
              <div><label htmlFor="alias-canonical" className="mb-1 block text-xs text-text-muted">Canonical name</label><Input id="alias-canonical" value={canonicalName} onChange={(e) => setCanonicalName(e.target.value)} placeholder="e.g. Chase Bank" /></div>
              <Button size="sm" disabled={saveAlias.isPending || !rawName.trim() || !canonicalName.trim()} onClick={() => saveAlias.mutate()}>{saveAlias.isPending ? "Saving…" : "Save alias"}</Button>
            </div>
          </section>

          {data.genericCards.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold text-text">Generic card identities</h4>
              <p className="mt-1 text-xs text-text-muted">These cards only have a generic issuer/neutral identity. Click the card artwork in Accounts to confirm the product.</p>
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {data.genericCards.map((card) => (
                  <li key={card.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="min-w-0"><span className="block truncate font-medium text-text">{card.name}</span><span className="text-text-muted">{card.institutionName ?? "Unknown institution"}{card.mask ? ` · ••••${card.mask}` : ""}</span></span>
                    <Link href="/accounts" className="shrink-0 font-medium text-accent-text hover:underline">Review in Accounts</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(data.duplicateCandidates.length > 0 || data.metadataGaps.length > 0) && (
            <section className="grid gap-4 lg:grid-cols-2">
              <div>
                <h4 className="text-sm font-semibold text-text">Potential duplicates</h4>
                {data.duplicateCandidates.length === 0 ? <p className="mt-1 text-xs text-text-muted">None detected.</p> : (
                  <ul className="mt-2 space-y-2 text-xs">{data.duplicateCandidates.map((item) => <li key={`${item.institutionName}:${item.mask}:${item.type}`} className="rounded-lg border border-border p-2"><span className="font-medium text-text">{item.institutionName} ••••{item.mask}</span><span className="mt-0.5 block text-text-muted">{item.accountNames.join(" · ")}</span></li>)}</ul>
                )}
              </div>
              <div>
                <h4 className="text-sm font-semibold text-text">Metadata gaps</h4>
                {data.metadataGaps.length === 0 ? <p className="mt-1 text-xs text-text-muted">None detected.</p> : (
                  <ul className="mt-2 space-y-2 text-xs">{data.metadataGaps.map((item) => <li key={item.id} className="rounded-lg border border-border p-2"><span className="font-medium text-text">{item.name}</span><span className="mt-0.5 block text-text-muted">{item.reasons.join(" · ")}</span></li>)}</ul>
                )}
              </div>
            </section>
          )}

          <section>
            <h4 className="text-sm font-semibold text-text">Provider history coverage</h4>
            <div className="mt-2 overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[620px] text-left text-xs">
                <thead className="bg-surface-muted/50 text-text-muted"><tr><th className="px-3 py-2 font-medium">Connection</th><th className="px-3 py-2 font-medium">Provider</th><th className="px-3 py-2 text-right font-medium">Transactions</th><th className="px-3 py-2 font-medium">Oldest</th><th className="px-3 py-2 font-medium">Newest</th><th className="px-3 py-2 font-medium">Status</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {data.history.map((row) => <tr key={row.connectionId}><td className="px-3 py-2 font-medium text-text">{row.institutionName}</td><td className="px-3 py-2 text-text-muted">{row.provider}</td><td className="px-3 py-2 text-right text-text">{row.transactionCount}</td><td className="px-3 py-2 text-text-muted">{row.oldestDate ?? "—"}</td><td className="px-3 py-2 text-text-muted">{row.newestDate ?? "—"}</td><td className={`px-3 py-2 ${row.lastError ? "text-danger" : "text-success"}`}>{row.lastError ? "Needs attention" : "OK"}</td></tr>)}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </Card>
  );
}
