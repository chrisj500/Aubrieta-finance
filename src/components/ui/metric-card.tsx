import type { ReactNode } from "react";
import { Card, CardLabel } from "@/components/ui/card";
import { cn } from "@/lib/cn";

export function MetricCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "positive" | "danger";
}) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardLabel>{label}</CardLabel>
          <div
            className={cn(
              "money mt-1.5 text-2xl font-bold tracking-tight text-text",
              tone === "positive" && "text-success",
              tone === "danger" && "text-danger",
            )}
          >
            {value}
          </div>
          {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
        </div>
        {icon ? (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-text-muted" aria-hidden>
            {icon}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
