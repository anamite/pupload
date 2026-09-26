import * as React from "react";
import {
  ArrowLeft,
  Check,
  Download,
  Lock,
  LockOpen,
  Monitor,
  Moon,
  Search,
  Settings,
  ShieldOff,
  Sun,
  SunMoon,
  X,
} from "lucide-react";
import { useApp } from "@/components/app-context";
import { useVaultUi } from "@/components/vault/vault";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Theme } from "@/lib/api";
import { useIsPhone } from "@/lib/hooks";
import { useInstall } from "@/lib/pwa";
import { hrefFor, type View } from "@/lib/router";
import { applyTheme, currentThemeChoice, THEMES } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { BrandMark } from "./nav";

const PLACEHOLDER: Partial<Record<View, string>> = {
  links: "Search links, notes and tags",
  bin: "Search the recycle bin",
};

const THEME_ICON: Record<Theme, typeof Sun> = { system: Monitor, light: Sun, slate: Moon, ink: SunMoon };

export function TopBar({ view }: { view: View }) {
  const { query, setQuery, settings, setSettingsOpen, saveSettings } = useApp();
  const phone = useIsPhone();
  const install = useInstall();
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [local, setLocal] = React.useState(query);
  const [theme, setTheme] = React.useState<Theme>(currentThemeChoice());
  const input = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => setLocal(query), [query]);
  React.useEffect(() => {
    const t = setTimeout(() => setQuery(local), 220);
    return () => clearTimeout(t);
  }, [local, setQuery]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement)?.tagName ?? "");
      if (e.key === "/" && !typing && !document.querySelector("[role=dialog]")) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pickTheme = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
    saveSettings({ theme: t }).catch(() => undefined);
  };

  const showSearch = !phone || searchOpen;
  const ThemeIcon = THEME_ICON[theme];

  return (
    <div className="sticky top-0 z-30 border-b bg-background/80 pt-safe backdrop-blur-xl md:border-b-0 md:bg-background/70">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-6 md:h-16 lg:px-8">
        {phone && !searchOpen && (
          <a href={hrefFor("files")} className="mr-auto flex min-w-0 items-center gap-2.5">
            <BrandMark className="size-8" />
            <span className="truncate font-display text-lg font-bold">{settings.app_name}</span>
          </a>
        )}
        {phone && searchOpen && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              setLocal("");
            }}
          >
            <ArrowLeft />
          </Button>
        )}
        {showSearch && (
          <div className={cn("relative min-w-0 flex-1 md:max-w-xl", phone && "animate-in fade-in-0 slide-in-from-right-4")}>
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={input}
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setLocal(""), input.current?.blur())}
              type="search"
              autoFocus={phone && searchOpen}
              placeholder={PLACEHOLDER[view] ?? "Search files and folders"}
              className="h-10 w-full rounded-full border bg-card pr-16 pl-10 text-base shadow-xs transition-[box-shadow,border-color] outline-none placeholder:text-muted-foreground focus:border-primary/50 focus:ring-[3px] focus:ring-ring/30 md:text-sm [&::-webkit-search-cancel-button]:hidden"
            />
            {local ? (
              <button
                onClick={() => setLocal("")}
                aria-label="Clear search"
                className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
              >
                <X className="size-4" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground md:block">
                /
              </kbd>
            )}
          </div>
        )}
        <div className={cn("flex shrink-0 items-center gap-1", !phone && "ml-auto")}>
          {phone && !searchOpen && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search"
              onClick={() => {
                setSearchOpen(true);
                requestAnimationFrame(() => input.current?.focus());
              }}
            >
              <Search />
            </Button>
          )}
          {install.available && !(phone && searchOpen) && (
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => install.install()}>
              <Download />
              <span className="hidden sm:inline">Install app</span>
            </Button>
          )}
          {!(phone && searchOpen) && (
            <>
              <VaultButton />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Theme">
                    <ThemeIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Theme</DropdownMenuLabel>
                  {THEMES.map((t) => {
                    const Icon = THEME_ICON[t.id];
                    return (
                      <DropdownMenuItem key={t.id} onSelect={() => pickTheme(t.id)}>
                        <Icon />
                        <span className="flex-1">{t.label}</span>
                        {theme === t.id && <Check className="!text-primary" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => setSettingsOpen(true)} className="hidden md:inline-flex">
                <Settings />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Secure folders: unlock from here, or see that this device is unlocked and lock it. */
function VaultButton() {
  const vault = useVaultUi();
  const status = vault.status;
  if (!status?.configured) return null;
  if (!status.unlocked)
    return (
      <Button variant="ghost" size="icon" aria-label="Unlock secure folders" title="Unlock secure folders" onClick={() => vault.ensureUnlocked()}>
        <Lock />
      </Button>
    );
  const until = status.expires
    ? new Date(status.expires * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Secure folders are unlocked" title="Secure folders are unlocked" className="text-primary hover:text-primary">
          <LockOpen />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <div className="px-2 py-1.5">
          <div className="text-sm font-medium">Secure folders unlocked</div>
          {until && <div className="text-xs text-muted-foreground">on this device until {until}</div>}
        </div>
        <DropdownMenuItem onSelect={() => vault.lock()}>
          <Lock /> Lock this device
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => vault.lock(true)}>
          <ShieldOff /> Lock every device
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
