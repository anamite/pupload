import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  api,
  type FolderInfo,
  type Item,
  type Link,
  type Settings,
  type Sort,
  type Stats,
  type TrashItem,
  type VaultStatus,
} from "./api";
import type { View } from "./router";

export const keys = {
  config: ["config"] as const,
  stats: ["stats"] as const,
  items: ["items"] as const,
  links: ["links"] as const,
  trash: ["trash"] as const,
  vault: ["vault"] as const,
  folders: ["folders"] as const,
};

interface ConfigResponse {
  settings: Settings;
  stats: Stats;
  version: string;
}

export function useConfig() {
  return useQuery({
    queryKey: keys.config,
    queryFn: () => api<ConfigResponse>("/api/config"),
    staleTime: 60_000,
  });
}

export function useStats(initial?: Stats) {
  return useQuery({
    queryKey: keys.stats,
    queryFn: async () => (await api<{ stats: Stats }>("/api/stats")).stats,
    initialData: initial,
    refetchInterval: 60_000,
  });
}

/** Any response carrying fresh stats updates the storage gauge immediately. */
export function absorbStats(qc: QueryClient, data: unknown) {
  const stats = (data as { stats?: Stats } | undefined)?.stats;
  if (stats) qc.setQueryData(keys.stats, stats);
}

export type FileView = Extract<View, "files" | "recent" | "media" | "expiring" | "mine">;

export function useItems(view: FileView, path: string, sort: Sort, query: string) {
  const qc = useQueryClient();
  const searching = query.trim().length > 0;
  return useQuery({
    queryKey: [...keys.items, searching ? "search" : view, searching ? query.trim() : path, sort],
    queryFn: async () => {
      let url: string;
      if (searching) url = `/api/search?q=${encodeURIComponent(query.trim())}`;
      else if (view === "files") url = `/api/list?path=${encodeURIComponent(path)}&sort=${sort}`;
      else url = `/api/collect?mode=${view}`;
      const data = await api<{ items: Item[]; stats: Stats; path: string; folder?: FolderInfo }>(url);
      absorbStats(qc, data);
      return { items: data.items, folder: data.folder ?? null };
    },
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useLinks() {
  return useQuery({
    queryKey: keys.links,
    queryFn: async () => (await api<{ links: Link[] }>("/api/links")).links,
  });
}

export function useTrash() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.trash,
    queryFn: async () => {
      const data = await api<{ items: TrashItem[]; stats: Stats }>("/api/trash");
      absorbStats(qc, data);
      return data.items;
    },
  });
}

export function useVault() {
  return useQuery({
    queryKey: keys.vault,
    queryFn: () => api<VaultStatus & { ok: boolean }>("/api/vault"),
    refetchInterval: 60_000,
    staleTime: 10_000,
  });
}

export function refreshAll(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: keys.items });
  qc.invalidateQueries({ queryKey: keys.stats });
  qc.invalidateQueries({ queryKey: keys.trash });
  qc.invalidateQueries({ queryKey: keys.folders });
}
