"use client";

import { predictCardIdentity } from "@/lib/card-identity";

export function AccountBrandTile({
  name,
  officialName,
  institutionName,
  mask,
}: {
  name: string;
  officialName?: string | null;
  institutionName?: string | null;
  mask?: string | null;
}) {
  const identity = predictCardIdentity({ name, officialName, institutionName, mask });
  return (
    <div
      className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md shadow-sm ring-1 ring-black/10"
      style={{
        background: `linear-gradient(135deg, ${identity.primary}, ${identity.secondary})`,
        color: identity.foreground,
      }}
      aria-label={`${identity.issuer} ${identity.product} card${mask ? ` ending ${mask}` : ""}`}
      title={`${identity.issuer} ${identity.product}${identity.confidence === "low" ? " (estimated)" : ""}`}
    >
      <span className="absolute left-1.5 top-1 text-[7px] font-semibold uppercase tracking-wide opacity-90">{identity.issuer}</span>
      <span className="absolute bottom-1 left-1.5 max-w-[45px] truncate text-[7px] font-semibold">{identity.product}</span>
      <span className="absolute bottom-1 right-1 text-[6px] font-bold opacity-90">{identity.network ?? (mask ? `••${mask.slice(-2)}` : "")}</span>
    </div>
  );
}
