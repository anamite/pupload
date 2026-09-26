import * as React from "react";
import type { LucideIcon } from "lucide-react";

export function PageHeader({
  eyebrow,
  title,
  count,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 px-4 pt-4 pb-4 sm:flex-row sm:items-end sm:justify-between sm:px-6 sm:pt-7 sm:pb-5 lg:px-8">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 flex min-w-0 items-center text-xs text-muted-foreground sm:text-sm">{eyebrow}</div>}
        <h1 className="flex min-w-0 items-baseline gap-3 font-display text-[1.75rem] leading-none font-semibold sm:text-4xl">
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="shrink-0 font-mono text-sm font-normal text-muted-foreground tabular">{count}</span>
          )}
        </h1>
      </div>
      {actions && <div className="flex shrink-0 items-center justify-end">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-16 text-center animate-rise sm:py-24">
      <div className="relative mb-1">
        <div className="absolute inset-0 rotate-6 rounded-2xl bg-primary/15" />
        <div className="relative flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
          <Icon className="size-6 text-primary" strokeWidth={1.75} />
        </div>
      </div>
      <h3 className="font-display text-xl font-semibold">{title}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
