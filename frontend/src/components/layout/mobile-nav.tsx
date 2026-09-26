import * as React from "react";
import { Clock, HardDrive, Link2, Menu, Settings, Trash2 } from "lucide-react";
import { useApp } from "@/components/app-context";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { hrefFor, type View } from "@/lib/router";
import { cn } from "@/lib/utils";
import { BrandMark, NavList, StorageGauge } from "./nav";

const TABS: { view: View; label: string; icon: typeof HardDrive }[] = [
  { view: "files", label: "Files", icon: HardDrive },
  { view: "recent", label: "Recent", icon: Clock },
  { view: "links", label: "Links", icon: Link2 },
  { view: "bin", label: "Bin", icon: Trash2 },
];

/** Thumb-reachable tab bar for phones; everything else lives in the "More" sheet. */
export function MobileNav({ view }: { view: View }) {
  const [open, setOpen] = React.useState(false);
  const { settings, setSettingsOpen } = useApp();
  const inTabs = TABS.some((t) => t.view === view);

  React.useEffect(() => setOpen(false), [view]);

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-background/90 pb-safe backdrop-blur-xl md:hidden"
        style={{ height: "var(--bottom-nav-h)" }}
      >
        {TABS.map((t) => {
          const active = view === t.view;
          return (
            <a
              key={t.view}
              href={hrefFor(t.view)}
              className={cn(
                "flex h-[62px] flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors",
                active && "text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-14 items-center justify-center rounded-full transition-all duration-300",
                  active && "bg-primary/15 text-primary",
                )}
              >
                <t.icon className="size-[19px]" strokeWidth={active ? 2.3 : 1.9} />
              </span>
              {t.label}
            </a>
          );
        })}
        <button
          onClick={() => setOpen(true)}
          className={cn(
            "flex h-[62px] flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground",
            !inTabs && "text-foreground",
          )}
        >
          <span className={cn("flex h-7 w-14 items-center justify-center rounded-full", !inTabs && "bg-primary/15 text-primary")}>
            <Menu className="size-[19px]" />
          </span>
          More
        </button>
      </nav>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="gap-4 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden />
          <div className="flex items-center gap-3">
            <BrandMark className="size-8" />
            <SheetTitle className="font-display text-lg font-bold">{settings.app_name}</SheetTitle>
            <SheetDescription className="sr-only">Navigation and storage</SheetDescription>
          </div>
          <div className="scrollbar-thin grid gap-4 overflow-y-auto">
            <NavList view={view} />
            <button
              onClick={() => {
                setOpen(false);
                setSettingsOpen(true);
              }}
              className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Settings className="size-[18px]" /> Settings
            </button>
            <StorageGauge />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
