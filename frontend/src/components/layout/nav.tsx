import * as React from "react";
import { Clock, HardDrive, Hourglass, Link2, Music4, Smartphone, Trash2, type LucideIcon } from "lucide-react";
import { useApp } from "@/components/app-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtSize } from "@/lib/format";
import { useStats, useTrash } from "@/lib/queries";
import { hrefFor, type View } from "@/lib/router";
import { cn } from "@/lib/utils";

export interface NavEntry {
  view: View;
  label: string;
  icon: LucideIcon;
}

export const NAV_MAIN: NavEntry[] = [
  { view: "files", label: "All files", icon: HardDrive },
  { view: "recent", label: "Recent", icon: Clock },
  { view: "media", label: "Media", icon: Music4 },
  { view: "links", label: "Links", icon: Link2 },
];
export const NAV_MORE: NavEntry[] = [
  { view: "mine", label: "My uploads", icon: Smartphone },
  { view: "expiring", label: "Expiring soon", icon: Hourglass },
  { view: "bin", label: "Recycle bin", icon: Trash2 },
];

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-primary text-primary-foreground",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-[58%]" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 16V5m0 0-4.5 4.5M12 5l4.5 4.5" />
        <path d="M5 19h14" opacity={0.6} />
      </svg>
    </span>
  );
}

function BinCount() {
  const { data } = useTrash();
  if (!data?.length) return null;
  return (
    <span className="ml-auto rounded-md bg-muted px-1.5 font-mono text-[10px] text-muted-foreground tabular group-data-[active=true]:bg-primary/15 group-data-[active=true]:text-primary">
      {data.length}
    </span>
  );
}

function NavLink({ entry, active, compact }: { entry: NavEntry; active: boolean; compact: boolean }) {
  const link = (
    <a
      href={hrefFor(entry.view)}
      data-active={active}
      className={cn(
        "group relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        "data-[active=true]:bg-card data-[active=true]:text-foreground data-[active=true]:shadow-[0_1px_2px_rgb(0_0_0/0.06),0_0_0_1px_var(--border)]",
        compact && "justify-center px-0 lg:justify-start lg:px-3",
      )}
    >
      {active && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-primary" aria-hidden />}
      <entry.icon className={cn("size-[18px] shrink-0", active && "text-primary")} strokeWidth={active ? 2.2 : 1.9} />
      <span className={cn(compact && "hidden lg:inline")}>{entry.label}</span>
      {entry.view === "bin" && <span className={cn("ml-auto", compact && "hidden lg:inline")}><BinCount /></span>}
    </a>
  );
  if (!compact) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="lg:hidden">
        {entry.label}
      </TooltipContent>
    </Tooltip>
  );
}

export function NavList({ view, compact = false }: { view: View; compact?: boolean }) {
  return (
    <nav className="grid gap-0.5">
      {NAV_MAIN.map((e) => (
        <NavLink key={e.view} entry={e} active={view === e.view} compact={compact} />
      ))}
      <div className="my-2 h-px bg-border" />
      {NAV_MORE.map((e) => (
        <NavLink key={e.view} entry={e} active={view === e.view} compact={compact} />
      ))}
    </nav>
  );
}

const SEGMENTS = 28;

/** A segmented "LED" gauge: lit cells for files, dimmer cells for the recycle bin. */
export function StorageGauge({ compact = false }: { compact?: boolean }) {
  const { data: s } = useStats();
  const { settings } = useApp();
  if (!s) return null;
  const unlimited = s.quota === null;
  const limit = unlimited ? s.used + s.available : s.quota!;
  const pct = limit > 0 ? Math.min(100, (s.used / limit) * 100) : 0;
  const binPct = limit > 0 ? Math.min(pct, (s.trash_bytes / limit) * 100) : 0;
  const lit = Math.round((pct / 100) * SEGMENTS);
  const binLit = Math.round((binPct / 100) * SEGMENTS);
  const tone = pct >= 95 ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary";

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="mx-auto flex h-16 w-3 flex-col-reverse gap-[2px] rounded-full" aria-label={`${Math.round(pct)}% used`}>
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className={cn("flex-1 rounded-[2px]", i < Math.round(pct / 10) ? tone : "bg-muted-foreground/15")} />
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          {fmtSize(s.used)} used{unlimited ? "" : ` of ${fmtSize(s.quota)}`}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-3.5 shadow-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Storage</span>
        <span className="font-mono text-xs tabular">
          {fmtSize(s.used)}
          {!unlimited && <span className="text-muted-foreground"> / {fmtSize(s.quota)}</span>}
        </span>
      </div>
      <div className="mt-2.5 flex h-5 gap-[3px]" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const isBin = i >= lit - binLit && i < lit;
          const on = i < lit;
          return (
            <span
              key={i}
              style={{ animationDelay: `${i * 14}ms` }}
              className={cn(
                "flex-1 rounded-[3px] transition-colors duration-500 animate-in fade-in-0 fill-mode-both",
                on ? (isBin ? `${tone} opacity-40` : tone) : "bg-muted-foreground/12",
              )}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{unlimited ? `${fmtSize(s.disk_free)} free on disk` : `${fmtSize(Math.max(0, s.quota! - s.used))} left`}</span>
        <span className="tabular">{Math.round(pct)}%</span>
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-1.5 border-t pt-2.5 text-[11px] text-muted-foreground">
        <span className="tabular">
          <b className="font-mono font-semibold text-foreground">{s.files}</b> files
        </span>
        <span className="tabular">
          <b className="font-mono font-semibold text-foreground">{s.folders}</b> folders
        </span>
        {s.trash_bytes > 0 && (
          <span className="col-span-2 flex items-center gap-1.5">
            <span className={cn("size-2 rounded-[2px] opacity-40", tone)} /> {fmtSize(s.trash_bytes)} in recycle bin
          </span>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {settings.expiry_days > 0
          ? `Files expire ${settings.expiry_days} days after ${settings.expiry_mode === "accessed" ? "last use" : "upload"}. Folders and links never do.`
          : "Auto-expiry is off. Files stay until deleted."}
      </p>
    </div>
  );
}

export function Sidebar({ view }: { view: View }) {
  const { settings } = useApp();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[76px] flex-col border-r bg-sidebar md:flex lg:w-[264px]">
      <a href={hrefFor("files")} className="flex h-16 items-center gap-3 px-5 lg:px-5">
        <BrandMark />
        <span className="hidden truncate font-display text-xl font-bold lg:inline">{settings.app_name}</span>
      </a>
      <div className="scrollbar-thin flex flex-1 flex-col gap-4 overflow-y-auto px-3 pt-2 pb-4 lg:px-4">
        <NavList view={view} compact />
        <div className="mt-auto hidden lg:block">
          <StorageGauge />
        </div>
        <div className="mt-auto lg:hidden">
          <StorageGauge compact />
        </div>
      </div>
    </aside>
  );
}

export function useNavEntry(view: View): NavEntry | undefined {
  return React.useMemo(() => [...NAV_MAIN, ...NAV_MORE].find((e) => e.view === view), [view]);
}
