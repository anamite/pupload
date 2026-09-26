import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Layout, type Settings, type Sort, type Stats } from "@/lib/api";
import { absorbStats, keys } from "@/lib/queries";

interface AppState {
  settings: Settings;
  version: string;
  query: string;
  setQuery: (q: string) => void;
  sort: Sort;
  setSort: (s: Sort) => void;
  layout: Layout;
  setLayout: (l: Layout) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

const AppContext = React.createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

export function AppProvider({
  settings,
  version,
  children,
}: {
  settings: Settings;
  version: string;
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = React.useState("");
  const [sort, setSortState] = React.useState<Sort>(settings.sort);
  const [layout, setLayoutState] = React.useState<Layout>(settings.view);
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  const saveSettings = React.useCallback(
    async (patch: Partial<Settings>) => {
      const data = await api<{ settings: Settings; stats: Stats }>("/api/settings", patch);
      qc.setQueryData(keys.config, (old: { settings: Settings; stats: Stats; version: string } | undefined) =>
        old ? { ...old, settings: data.settings, stats: data.stats } : old,
      );
      absorbStats(qc, data);
      return data.settings;
    },
    [qc],
  );

  const setSort = React.useCallback(
    (s: Sort) => {
      setSortState(s);
      saveSettings({ sort: s }).catch(() => undefined);
    },
    [saveSettings],
  );
  const setLayout = React.useCallback(
    (l: Layout) => {
      setLayoutState(l);
      saveSettings({ view: l }).catch(() => undefined);
    },
    [saveSettings],
  );

  React.useEffect(() => {
    document.title = settings.app_name;
  }, [settings.app_name]);

  const value = React.useMemo(
    () => ({
      settings,
      version,
      query,
      setQuery,
      sort,
      setSort,
      layout,
      setLayout,
      saveSettings,
      settingsOpen,
      setSettingsOpen,
    }),
    [settings, version, query, sort, setSort, layout, setLayout, saveSettings, settingsOpen],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
