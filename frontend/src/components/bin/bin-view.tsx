import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, RotateCcw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { useDialogs } from "@/components/dialogs";
import { KindIcon } from "@/components/file-icon";
import { EmptyState, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useVaultUi } from "@/components/vault/vault";
import { api, type Stats, type TrashItem } from "@/lib/api";
import { fmtSize, fmtWhen, plural } from "@/lib/format";
import { absorbStats, keys, refreshAll, useStats, useTrash } from "@/lib/queries";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

type Filter = "all" | "file" | "folder" | "link";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "file", label: "Files" },
  { id: "folder", label: "Folders" },
  { id: "link", label: "Links" },
];

function daysLeft(purgeAt: number | null) {
  if (!purgeAt) return null;
  const secs = purgeAt - Date.now() / 1000;
  if (secs <= 3600) return { text: "deleting soon", warn: true };
  const days = Math.ceil(secs / 86400);
  return { text: days === 1 ? "1 day left" : `${days} days left`, warn: days <= 3 };
}

export function BinView() {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const vault = useVaultUi();
  const { query, setQuery, settings } = useApp();
  const fail = (err: unknown) => {
    if (!vault.handle(err)) toast.error((err as Error).message);
  };
  const { data: items = [], isLoading } = useTrash();
  const { data: stats } = useStats();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  const needle = query.trim().toLowerCase();
  const shown = items.filter(
    (i) =>
      (filter === "all" || i.kind === filter) &&
      (!needle || i.name.toLowerCase().includes(needle) || i.original.toLowerCase().includes(needle)),
  );

  React.useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((id) => items.some((i) => i.id === id))));
  }, [items]);

  const after = (data: unknown) => {
    absorbStats(qc, data);
    refreshAll(qc);
    qc.invalidateQueries({ queryKey: keys.links });
    setSelected(new Set());
  };

  const restore = async (ids: string[]) => {
    setBusy(true);
    try {
      const data = await api<{ restored: { kind: string; path: string }[]; errors: string[] }>("/api/trash/restore", { ids });
      after(data);
      const first = data.restored[0];
      toast.success(`${plural(data.restored.length, "item")} restored`, {
        description: data.errors[0],
        action:
          data.restored.length === 1 && first.kind !== "link"
            ? {
                label: "Show",
                onClick: () => navigate("files", first.path.includes("/") ? first.path.slice(0, first.path.lastIndexOf("/")) : ""),
              }
            : undefined,
      });
    } catch (err) {
      fail(err);
    }
    setBusy(false);
  };

  const destroy = async (ids: string[]) => {
    const yes = await dialogs.confirm({
      title: ids.length === 1 ? "Delete forever?" : `Delete ${ids.length} items forever?`,
      message: "This cannot be undone.",
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (!yes) return;
    setBusy(true);
    try {
      const data = await api<{ freed: number; stats: Stats }>("/api/trash/delete", { ids });
      after(data);
      toast.success(data.freed ? `Deleted · ${fmtSize(data.freed)} freed` : "Deleted");
    } catch (err) {
      fail(err);
    }
    setBusy(false);
  };

  const empty = async () => {
    const yes = await dialogs.confirm({
      title: "Empty the recycle bin?",
      message: `All ${plural(items.length, "item")} will be deleted forever. This cannot be undone.`,
      confirmLabel: "Empty bin",
      destructive: true,
    });
    if (!yes) return;
    setBusy(true);
    try {
      const data = await api<{ count: number; bytes: number; kept?: number }>("/api/trash/empty", {});
      after(data);
      toast.success(`Recycle bin emptied${data.bytes ? ` · ${fmtSize(data.bytes)} freed` : ""}`, {
        description: data.kept
          ? `${plural(data.kept, "secure item")} kept. Unlock secure folders to delete ${data.kept === 1 ? "it" : "them"}.`
          : undefined,
      });
    } catch (err) {
      fail(err);
    }
    setBusy(false);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={
          <span>
            {settings.trash_days > 0
              ? `Items are deleted forever after ${settings.trash_days} days`
              : "Items stay until you empty the bin"}
            {stats?.trash_bytes ? ` · using ${fmtSize(stats.trash_bytes)}` : ""}
          </span>
        }
        title="Recycle bin"
        count={isLoading ? undefined : items.length}
        actions={
          items.length > 0 && (
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={empty} disabled={busy}>
              <Trash2 /> Empty bin
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-4 sm:px-6 lg:px-8">
        <div className="flex rounded-lg border bg-card p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors",
                filter === f.id ? "bg-secondary text-foreground shadow-xs" : "hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {needle && (
          <button
            onClick={() => setQuery("")}
            className="flex items-center gap-1 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background"
          >
            <Search className="size-3" /> “{query.trim()}” <X className="size-3" />
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-0 z-20 px-4 pb-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-1 rounded-xl border border-primary/30 bg-card/95 p-1.5 pl-2 shadow-lg backdrop-blur animate-in fade-in-0 slide-in-from-top-2">
            <Button variant="ghost" size="icon-sm" onClick={() => setSelected(new Set())} aria-label="Clear selection">
              <X />
            </Button>
            <span className="mr-auto pl-1 text-sm font-medium tabular">{selected.size} selected</span>
            <Button variant="ghost" size="sm" onClick={() => restore([...selected])} disabled={busy}>
              <RotateCcw /> Restore
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => destroy([...selected])} disabled={busy}>
              <Trash2 /> <span className="hidden sm:inline">Delete forever</span>
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 px-4 pb-6 sm:px-6 lg:px-8">
        {isLoading ? (
          <div className="grid gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={Trash2}
            title={items.length ? "Nothing here" : "The recycle bin is empty"}
            text={
              items.length
                ? "No deleted items match this filter."
                : "Deleted files, folders and links wait here so you can bring them back."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card animate-rise">
            {shown.length > 1 && (
              <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={shown.every((i) => selected.has(i.id)) ? true : selected.size ? "indeterminate" : false}
                  onCheckedChange={(v) => setSelected(v ? new Set(shown.map((i) => i.id)) : new Set())}
                  aria-label="Select all"
                />
                Select all
              </div>
            )}
            {shown.map((item) => (
              <BinRow
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                busy={busy}
                onToggle={() => toggle(item.id)}
                onRestore={() => restore([item.id])}
                onDelete={() => destroy([item.id])}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BinRow({
  item,
  selected,
  busy,
  onToggle,
  onRestore,
  onDelete,
}: {
  item: TrashItem;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const left = daysLeft(item.purge_at);
  const where =
    item.kind === "link" ? item.url ?? "" : item.original.includes("/") ? `Home/${item.original.slice(0, item.original.lastIndexOf("/"))}` : "Home";
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0 cv-auto [contain-intrinsic-size:auto_64px]",
        selected ? "bg-primary/6" : "hover:bg-accent/50",
      )}
    >
      <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${item.name}`} />
      <KindIcon
        kind={item.locked && item.kind === "file" ? "vault" : item.file_kind}
        className={cn("size-10 rounded-xl", item.locked && "bg-muted text-muted-foreground")}
      />
      <div className="min-w-0 flex-1">
        <div className={cn("flex min-w-0 items-center gap-1.5 text-sm font-medium", item.locked && "text-muted-foreground")} title={item.name}>
          {item.secure && <Lock className="size-3 shrink-0 text-primary" aria-label="Secure" />}
          <span className="truncate">{item.name}</span>
        </div>
        <div className="truncate text-xs text-muted-foreground" title={where}>
          {item.kind === "link" ? where : `from ${where}`}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>deleted {fmtWhen(item.deleted_at)}</span>
          {item.deleted_by && <span>by {item.deleted_by}</span>}
          {item.kind !== "link" && (
            <span className="font-mono tabular">
              {fmtSize(item.size)}
              {item.kind === "folder" && ` · ${plural(Math.max(0, item.items), "item")}`}
            </span>
          )}
          {left && <Badge variant={left.warn ? "warn" : "outline"}>{left.text}</Badge>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="outline" size="sm" onClick={onRestore} disabled={busy} aria-label="Restore">
          <RotateCcw />
          <span className="hidden sm:inline">Restore</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          disabled={busy}
          className="text-muted-foreground hover:text-destructive"
          aria-label="Delete forever"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
