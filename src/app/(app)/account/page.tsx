import { Suspense } from "react";
import { AccountDetailFromQuery } from "@/components/account-detail/account-detail-query";
import { Page } from "@/components/ui/page";

export default function StaticAccountDetailPage() {
  return (
    <Suspense fallback={<Page><div className="skeleton h-80" role="status" aria-label="Loading account detail" /></Page>}>
      <AccountDetailFromQuery />
    </Suspense>
  );
}
