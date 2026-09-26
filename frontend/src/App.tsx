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
import { SettingsDialog } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useConfig, useStats } from "@/lib/queries";
import { useRoute } from "@/lib/router";
import { applyTheme, savedTheme } from "@/lib/theme";

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
  const [shared] = React.useState(takeSharedLink);

  // A search belongs to the view it was typed in.
  React.useEffect(() => {
    setQuery("");
  }, [route.view, setQuery]);
  React.useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.view, route.path]);

  let body: React.ReactNode;
  if (route.view === "links") body = <LinksView shared={shared} />;
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
          {body}
        </main>
      </div>
      <MobileNav view={route.view} />
      <AudioBar />
      <UploadPanel />
      <SettingsDialog />
    </div>
  );
}

function Boot() {
  const { data, error, refetch, isFetching } = useConfig();
  useStats(data?.stats);

  React.useEffect(() => {
    if (data && !savedTheme()) applyTheme(data.settings.theme, false);
  }, [data]);

  if (error && !data) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <WifiOff className="size-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold">Cannot reach the server</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Make sure the Pi is on and this device is on the same network. {(error as Error).message}
        </p>
        <Button onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? "animate-spin" : ""} /> Try again
        </Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <BrandMark className="size-12 animate-pulse" />
      </div>
    );
  }
  return (
    <AppProvider settings={data.settings} version={data.version}>
      <DialogsProvider>
        <Shell />
      </DialogsProvider>
    </AppProvider>
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

