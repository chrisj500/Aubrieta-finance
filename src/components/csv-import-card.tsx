"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { api } from "@/lib/api-client";
import { Card, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/custom-select";

export function CsvImportCard({
  setMsg,
  setErr,
}: {
  setMsg: (value: string | null) => void;
  setErr: (value: string | null) => void;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState("");
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<{ accounts: Array<{ id: string; name: string }> }>("/api/accounts"),
  });

  const importCsv = useMutation({
    mutationFn: async () => {
      const file = fileRef.current?.files?.[0];
      if (!file || !accountId) throw new Error("Choose an account and CSV file first.");
      const contents = await file.text();
      return api.post<{ imported: number; skipped: number; totalParsed: number }>("/api/import/csv", { accountId, contents });
    },
    onSuccess: (result) => {
      setErr(null);
      setMsg(
        `CSV import complete — ${result.imported} transaction${result.imported === 1 ? "" : "s"} imported${result.skipped ? `; ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped` : ""}.`,
      );
      if (fileRef.current) fileRef.current.value = "";
      for (const key of ["transactions", "summary", "reports", "planning", "accounts"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "CSV import failed."),
  });

  return (
    <Card className="lg:col-span-2" id="csv-import">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-surface-muted p-2 text-text-muted"><FileUp size={18} aria-hidden /></div>
        <div>
          <CardTitle>Import transaction history</CardTitle>
          <p className="mt-1 text-sm text-text-muted">
            Use a bank statement CSV when a provider cannot supply older history. Pick the destination account first; Aubrieta skips matching duplicates automatically.
          </p>
        </div>
      </div>

      {accounts.isError && !accounts.data ? (
        <div role="alert" className="mt-4 rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-sm text-danger">
          Couldn&apos;t load accounts.
          <Button className="ml-3" size="sm" variant="secondary" onClick={() => accounts.refetch()}>Try again</Button>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-[minmax(14rem,0.8fr)_minmax(16rem,1.2fr)_auto] md:items-end">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">Destination account</label>
            <CustomSelect
              ariaLabel="CSV destination account"
              value={accountId}
              onChange={setAccountId}
              placeholder="Select account…"
              options={(accounts.data?.accounts ?? []).map((account) => ({ value: account.id, label: account.name }))}
            />
          </div>
          <div>
            <label htmlFor="data-sync-csv" className="mb-1 block text-xs font-medium text-text-muted">Bank CSV file</label>
            <input
              ref={fileRef}
              id="data-sync-csv"
              type="file"
              accept=".csv,text/csv"
              className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-text"
            />
          </div>
          <Button disabled={importCsv.isPending || !accountId} onClick={() => importCsv.mutate()}>
            {importCsv.isPending ? "Importing…" : "Import CSV"}
          </Button>
        </div>
      )}

      <p className="mt-3 text-xs text-text-muted">
        Supported common layouts include Date / Description / Amount and Date / Description / Debit / Credit. Imported rows remain tied to the account you select.
      </p>
    </Card>
  );
}
