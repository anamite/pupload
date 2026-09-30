import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RefreshCw, WifiOff } from "lucide-react";
import { AppProvider, useApp } from "@/components/app-context";
import { BinView } from "@/components/bin/bin-view";
import { DialogsProvider } from "@/components/dialogs";
import { FilesView } from "@/components/files/files-view";
import { AudioBar } from "@/components/layout/audio-bar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { BrandMark, Sidebar } from "@/components/layout/nav";
import { TopBar } from "@/components/layout/top-bar";
import { UploadPanel } from "@/components/layout/upload-panel";
import { LinksView } from "@/components/links/links-view";
import { PrivateGuard, usePrivateAccess } from "@/components/private/access";
import { AuthProvider, LoginScreen, useSignedOutWatch } from "@/components/remote/auth";
import { SettingsDialog } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VaultProvider } from "@/components/vault/vault";
import type { AuthStatus } from "@/lib/api";
import { useAuth, useConfig, useStats } from "@/lib/queries";
import { PRIVATE_VIEWS, useRoute } from "@/lib/router";
import { applyTheme, savedTheme } from "@/lib/theme";
import { useUpdateNotice } from "@/lib/update-check";

// The private space loads only on devices that can open it.
const NotesView = React.lazy(() => import("@/components/private/notes-view").then((m) => ({ default: m.NotesView })));
const MemosView = React.lazy(() => import("@/components/private/memos-view").then((m) => ({ default: m.MemosView })));
const ListsView = React.lazy(() => import("@/components/private/lists-view").then((m) => ({ default: m.ListsView })));
const CalendarView = React.lazy(() => import("@/components/private/calendar-view").then((m) => ({ default: m.CalendarView })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true, staleTime: 5_000, retry: 1 },
  },
});

/** Links shared into the installed app from another app's share sheet. */
function takeSharedLink() {
  if (location.pathname !== "/share") return null;
  const params = new URLSearchParams(location.search);
  const text = params.get("text") ?? "";
  const url = params.get("url") || text.match(/https?:\/\/\S+/)?.[0] || "";
  history.replaceState(null, "", "/#/links");
  if (!url) return null;
  return { url, title: params.get("title") ?? "", note: url === text ? "" : text.replace(url, "").trim() };
}

function Shell() {
  const route = useRoute();
  const { setQuery } = useApp();
  const privateAccess = usePrivateAccess();
  const [shared] = React.useState(takeSharedLink);
  useUpdateNotice();

  // A search belongs to the view it was typed in.
  React.useEffect(() => {
    setQuery("");
  }, [route.view, setQuery]);
  React.useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.view, route.path]);

  let body: React.ReactNode;
  if (PRIVATE_VIEWS.includes(route.view) && !privateAccess) body = null;
  else if (route.view === "notes") body = <NotesView id={route.path} />;
  else if (route.view === "memos") body = <MemosView />;
  else if (route.view === "lists") body = <ListsView id={route.path} />;
  else if (route.view === "calendar") body = <CalendarView />;
  else if (route.view === "links") body = <LinksView shared={shared} />;
  else if (route.view === "bin") body = <BinView />;
  else body = <FilesView view={route.view} path={route.path} />;

  return (
    <div className="min-h-dvh">
      <Sidebar view={route.view} />
      <div className="flex min-h-dvh flex-col md:pl-[76px] lg:pl-[264px]">
        <TopBar view={route.view} />
        <main
          key={route.view}
          className="flex-1 animate-in fade-in-0 duration-300"
          style={{ paddingBottom: "calc(var(--bottom-nav-h) + var(--player-h, 0px) + 5rem)" }}
        >
          <React.Suspense fallback={null}>{body}</React.Suspense>
        </main>
      </div>
      <MobileNav view={route.view} />
      <AudioBar />
      <UploadPanel />
      <SettingsDialog />
      <PrivateGuard view={route.view} />
    </div>
  );
}

function Unreachable({ error, retry, busy }: { error: unknown; retry: () => void; busy: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <WifiOff className="size-6" />
      </div>
      <h1 className="font-display text-2xl font-semibold">Cannot reach the server</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Make sure the Pi is on and this device is on the same network. {(error as Error).message}
      </p>
      <Button onClick={retry} disabled={busy}>
        <RefreshCw className={busy ? "animate-spin" : ""} /> Try again
      </Button>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <BrandMark className="size-12 animate-pulse" />
    </div>
  );
}

/** Which door: on the home network straight in; remotely, signed in first. */
function Boot() {
  const { data, error, refetch, isFetching } = useAuth();
  useSignedOutWatch(!!data?.remote);
  if (error && !data) return <Unreachable error={error} retry={() => refetch()} busy={isFetching} />;
  if (!data) return <Splash />;
  if (data.remote && !data.signed_in) return <LoginScreen configured={!!data.configured} />;
  return <Main auth={data} />;
}

function Main({ auth }: { auth: AuthStatus }) {
  const { data, error, refetch, isFetching } = useConfig();
  useStats(data?.stats);

  React.useEffect(() => {
    if (data && !savedTheme()) applyTheme(data.settings.theme, false);
  }, [data]);

  if (error && !data) return <Unreachable error={error} retry={() => refetch()} busy={isFetching} />;
  if (!data) return <Splash />;
  return (
    <AuthProvider status={auth}>
      <AppProvider settings={data.settings} version={data.version}>
        <DialogsProvider>
          <VaultProvider>
            <Shell />
          </VaultProvider>
        </DialogsProvider>
      </AppProvider>
    </AuthProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <Boot />
        <Toaster position="top-center" closeButton richColors={false} offset={{ top: 72 }} mobileOffset={{ top: 64 }} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

