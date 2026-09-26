"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { hasWindow } from "@/lib/browser-env";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface HouseholdData {
  household: {
    id: string;
    name: string;
    role: "owner" | "member";
    members: Array<{
      userId: string;
      displayName: string;
      username: string | null;
      email: string | null;
      role: "owner" | "member";
      joinedAt: string;
      isCurrentUser: boolean;
    }>;
    invitations: Array<{
      id: string;
      inviteeEmail: string | null;
      expiresAt: string;
      createdAt: string;
    }>;
  };
}

export function HouseholdSettingsCard({
  setMsg,
  setErr,
}: {
  setMsg: (value: string | null) => void;
  setErr: (value: string | null) => void;
}) {
  const qc = useQueryClient();
  const household = useQuery({
    queryKey: ["household"],
    queryFn: () => api.get<HouseholdData>("/api/household"),
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);

  useEffect(() => {
    if (household.data?.household.name && !name) {
      setName(household.data.household.name);
    }
  }, [household.data?.household.name, name]);

  const rename = useMutation({
    mutationFn: () => api.patch("/api/household", { name }),
    onSuccess: () => {
      setMsg("Household name updated.");
      qc.invalidateQueries({ queryKey: ["household"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not rename household."),
  });

  const invite = useMutation({
    mutationFn: () =>
      api.post<{ invitation: { token: string; expiresAt: string } }>(
        "/api/household/invitations",
        { email: email.trim() || null },
      ),
    onSuccess: (r) => {
      const origin = hasWindow() ? window.location.origin : "";
      setInviteLink(`${origin}/register?invite=${encodeURIComponent(r.invitation.token)}`);
      setEmail("");
      setMsg("Invitation created. The link is shown once.");
      qc.invalidateQueries({ queryKey: ["household"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not create invitation."),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/household/invitations/${id}`),
    onSuccess: () => {
      setMsg("Invitation revoked.");
      qc.invalidateQueries({ queryKey: ["household"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not revoke invitation."),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.del(`/api/household/members/${userId}`),
    onSuccess: () => {
      setMsg("Household member removed.");
      setMemberToRemove(null);
      qc.invalidateQueries({ queryKey: ["household"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Could not remove household member."),
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

  if (household.isLoading) {
    return <Card><div className="skeleton h-32" /></Card>;
  }
  if (household.isError || !household.data) {
    return (
      <Card>
        <CardTitle>Household</CardTitle>
        <p className="mt-2 text-sm text-danger">Couldn&apos;t load household settings.</p>
        <Button className="mt-3" variant="secondary" onClick={() => household.refetch()}>
          Try again
        </Button>
      </Card>
    );
  }

  const h = household.data.household;
  const isOwner = h.role === "owner";

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{h.name}</CardTitle>
            <p className="mt-1 text-sm text-text-muted">
              Shared accounts and household planning are visible to every member. Private accounts stay visible only to their owner.
            </p>
          </div>
          <Badge className="bg-accent/10 text-accent-text">
            {isOwner ? "Household owner" : "Household member"}
          </Badge>
        </div>

        {isOwner && (
          <form
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate();
            }}
          >
            <div className="min-w-52 flex-1">
              <label className="mb-1 block text-xs text-text-muted">Household name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </div>
            <Button type="submit" variant="secondary" disabled={rename.isPending || !name.trim()}>
              Save
            </Button>
          </form>
        )}

        <div className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Members</p>
          <div className="mt-2 divide-y divide-border">
            {h.members.map((member) => (
              <div key={member.userId} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">
                    {member.displayName}
                    {member.isCurrentUser ? " · You" : ""}
                  </p>
                  <p className="truncate text-xs text-text-muted">
                    {member.username ? `@${member.username}` : "No username"}
                    {member.email ? ` · ${member.email}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge>{member.role}</Badge>
                  {isOwner && !member.isCurrentUser && member.role !== "owner" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      onClick={() =>
                        setMemberToRemove({
                          userId: member.userId,
                          displayName: member.displayName,
                        })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {isOwner && (
        <Card>
          <CardTitle>Invite a household member</CardTitle>
          <p className="mt-1 text-sm text-text-muted">
            Aubrieta is invitation-only after the first account. Each person gets their own login.
          </p>
          <form
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setInviteLink(null);
              invite.mutate();
            }}
          >
            <div className="min-w-52 flex-1">
              <label className="mb-1 block text-xs text-text-muted">Email label (optional)</label>
              <Input
                type="email"
                placeholder="person@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? "Creating…" : "Create invite link"}
            </Button>
          </form>

          {inviteLink && (
            <div className="mt-4 rounded-xl border border-border bg-surface-muted p-3">
              <p className="break-all font-mono text-xs text-text">{inviteLink}</p>
              <Button className="mt-2" size="sm" variant="secondary" onClick={copyInvite}>
                {copied ? "Copied" : "Copy invite link"}
              </Button>
              <p className="mt-2 text-xs text-text-muted">
                The secret token is only shown here once. The invitation expires in seven days.
              </p>
            </div>
          )}

          {h.invitations.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Pending invitations</p>
              <div className="mt-2 divide-y divide-border">
                {h.invitations.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-text">{item.inviteeEmail ?? "Invitation link"}</p>
                      <p className="text-xs text-text-muted">
                        Expires {new Date(item.expiresAt).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(item.id)}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={memberToRemove !== null}
        title="Remove household member?"
        message={
          memberToRemove
            ? `${memberToRemove.displayName} will leave this household. Their accounts and planning items move with them into a new private household.`
            : undefined
        }
        confirmLabel="Remove member"
        busy={removeMember.isPending}
        onCancel={() => setMemberToRemove(null)}
        onConfirm={() => {
          if (memberToRemove) removeMember.mutate(memberToRemove.userId);
        }}
      />
    </>
  );
}