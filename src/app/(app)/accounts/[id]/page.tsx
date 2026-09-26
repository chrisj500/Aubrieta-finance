"use client";

import { useParams } from "next/navigation";
import { AccountDetailView } from "@/components/account-detail/account-detail-view";

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>();
  return <AccountDetailView id={params.id} />;
}
