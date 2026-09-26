"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AccountDetailView } from "@/components/account-detail/account-detail-view";
import { Card } from "@/components/ui/card";
import { Page } from "@/components/ui/page";

export function AccountDetailFromQuery() {
  const params = useSearchParams();
  const id = params.get("id")?.trim() ?? "";
  if (!id) {
    return (
      <Page>
        <Card>
          <p className="text-sm text-text-muted">Choose an account from Accounts to view its details.</p>
          <Link href="/accounts" className="mt-3 inline-block text-sm font-medium text-accent-text hover:underline">
            Back to accounts
          </Link>
        </Card>
      </Page>
    );
  }
  return <AccountDetailView id={id} />;
}
