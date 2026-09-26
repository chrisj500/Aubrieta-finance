"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { hasWindow } from "@/lib/browser-env";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface InstanceStatus {
  isInstanceAdmin: boolean;
}

interface HouseholdSummary {
  id: string;
  name: string;
  memberCount: number;
  ownerName: string | null;
  ownerUsername: string | null;
  createdAt: string;
}

interface ProvisionResult {
  household: HouseholdSummary;
  invitation: { id: string; token: string; expiresAt: string };
}

function invitationUrl(token: string): string {
  const origin = hasWindow() ? window.location.origin : "";
  return `${origin}/register?invite=${encodeURIComponent(token)}`;
}

export function InstanceAdminCard({
  setMsg,
  setErr,
}: {
  setMsg: (value: string | null) => void;
  setErr: (value: string | null) => void;
}) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["instance-admin-status"],
    queryFn: () => api.get<InstanceStatus>("/api/admin/status"),
  });
  const households = useQuery({
    queryKey: ["instance-households"],
    queryFn: () => api.get<{ households: HouseholdSummary[] }>("/api/admin/households"),
    enabled: status.data?.isInstanceAdmin === true,
  });
  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteHousehold, setInviteHousehold] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const provision = useMutation({
    mutationFn: () =>
      api.post<ProvisionResult>("/api/admin/households", {
        name: name.trim(),
        ownerEmail: ownerEmail.trim() || null,
      }),
    onSuccess: (result) => {
      setInviteHousehold(result.household.name);
      setInviteLink(invitationUrl(result.invitation.token));
      setName("");
      setOwnerEmail("");
      setMsg("Household created. Share the owner invitation link shown below.");
      qc.invalidateQueries({ queryKey: ["instance-households"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not create household."),
  });

  const reissue = useMutation({
    mutationFn: ({ householdId, householdName }: { householdId: string; householdName: string }) =>
      api.post<{ invitation: { token: string } }>(
        `/api/admin/households/${householdId}/invitations`,
        { ownerEmail: null },
      ).then((result) => ({ ...result, householdName })),
    onSuccess: (result) => {
      setInviteHousehold(result.householdName);
      setInviteLink(invitationUrl(result.invitation.token));
      setMsg("A new owner invitation was created. The link is shown once.");
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not create owner invitation."),
  });

  async function copyInvite() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (status.isLoading || status.data?.isInstanceAdmin !== true) return null;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Instance administration</CardTitle>
            <p className="mt-1 text-sm text-text-muted">
              Provision independent households on this Aubrieta server. Instance administration does not grant access to another household&apos;s financial data.
            </p>
          </div>
          <Badge className="bg-accent/10 text-accent-text">Instance admin</Badge>
        </div>

        <form
          className="mt-4 grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setInviteLink(null);
            setInviteHousehold(null);
            provision.mutate();
          }}
        >
          <div>
            <label className="mb-1 block text-xs text-text-muted">New household name</label>
            <Input
              value={name}
              maxLength={80}
              placeholder="Smith Household"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">Owner email label (optional)</label>
            <Input
              type="email"
              value={ownerEmail}
              placeholder="owner@example.com"
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
          </div>
          <div className="md:col-span-2">
            <Button type="submit" disabled={provision.isPending || !name.trim()}>
              {provision.isPending ? "Creating…" : "Create household"}
            </Button>
          </div>
        </form>

        {inviteLink && (
          <div className="mt-4 rounded-xl border border-border bg-surface-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Owner invitation{inviteHousehold ? ` · ${inviteHousehold}` : ""}
            </p>
            <p className="mt-2 break-all font-mono text-xs text-text">{inviteLink}</p>
            <Button className="mt-2" size="sm" variant="secondary" onClick={copyInvite}>
              {copied ? "Copied" : "Copy owner invite"}
            </Button>
            <p className="mt-2 text-xs text-text-muted">
              The token is shown once and expires in seven days. The invited user becomes this household&apos;s owner.
            </p>
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Hosted households</CardTitle>
        <p className="mt-1 text-sm text-text-muted">
          Only household metadata is visible here; balances, transactions, bills, budgets, and goals stay behind each household&apos;s tenant boundary.
        </p>
        {households.isLoading ? (
          <div className="mt-4 skeleton h-24" />
        ) : households.isError ? (
          <div role="alert" className="mt-4 text-sm text-danger">
            Couldn&apos;t load hosted households.
            <Button className="ml-2" size="sm" variant="secondary" onClick={() => households.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="mt-4 divide-y divide-border">
            {households.data?.households.map((household) => (
              <div key={household.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">{household.name}</p>
                  <p className="text-xs text-text-muted">
                    {household.ownerName
                      ? `Owner: ${household.ownerName}${household.ownerUsername ? ` (@${household.ownerUsername})` : ""}`
                      : "Awaiting owner"}
                    {` · ${household.memberCount} member${household.memberCount === 1 ? "" : "s"}`}
                  </p>
                </div>
                {!household.ownerName && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={reissue.isPending}
                    onClick={() => reissue.mutate({ householdId: household.id, householdName: household.name })}
                  >
                    New owner invite
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
