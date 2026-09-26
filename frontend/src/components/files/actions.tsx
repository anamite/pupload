import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Download,
  FolderInput,
  FolderOpen,
  Info,
  Link2,
  Pencil,
  Pin,
  PinOff,
  Play,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { useDialogs } from "@/components/dialogs";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { api, copyText, fileUrl, startDownload, zipUrl, type Item, type Stats } from "@/lib/api";
import { plural } from "@/lib/format";
import { player } from "@/lib/player";
import { absorbStats, keys, refreshAll } from "@/lib/queries";
import { navigate } from "@/lib/router";

export const VIEWABLE = new Set(["image", "video", "pdf", "text"]);

export interface FileActions {
  open: (item: Item) => void;
  download: (items: Item[]) => void;
  copyLink: (item: Item) => void;
  togglePin: (item: Item) => void;
  rename: (item: Item) => void;
  move: (paths: string[]) => void;
  remove: (paths: string[]) => Promise<void>;
  details: (item: Item) => void;
  moveTo: (paths: string[], to: string, label: string) => Promise<void>;
}

export function useFileActions(opts: {
  items: Item[];
  openViewer: (item: Item) => void;
  openMove: (paths: string[]) => void;
  openDetails: (item: Item) => void;
  clearSelection: () => void;
}): FileActions {
  const qc = useQueryClient();
  const { settings } = useApp();
  const dialogs = useDialogs();
  const optsRef = React.useRef(opts);
  optsRef.current = opts;

  return React.useMemo<FileActions>(() => {
    const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err));

    const restore = async (ids: string[]) => {
      try {
        const data = await api("/api/trash/restore", { ids });
        absorbStats(qc, data);
        refreshAll(qc);
        toast.success("Restored");
      } catch (err) {
        fail(err);
      }
    };

    return {
      open(item) {
        if (item.is_dir) return navigate("files", item.path);
        if (item.kind === "audio") return player.play(item, optsRef.current.items);
        if (VIEWABLE.has(item.kind)) return optsRef.current.openViewer(item);
        startDownload(fileUrl("download", item.path));
      },
      download(items) {
        if (!items.length) return;
        // A folder (or several things at once) can only come down as one ZIP.
        if (items.length === 1 && !items[0].is_dir) return startDownload(fileUrl("download", items[0].path));
        if (items.length === 1) startDownload(fileUrl("zip", items[0].path));
        else startDownload(zipUrl(items.map((i) => i.path)));
        toast("Preparing ZIP…", { description: "The download starts in a moment and streams as it goes." });
      },
      async copyLink(item) {
        const ok = await copyText(location.origin + fileUrl("raw", item.path));
        if (ok) toast.success("Link copied");
        else toast.error("Could not copy the link on this browser");
      },
      async togglePin(item) {
        try {
          await api("/api/pin", { path: item.path, pinned: !item.pinned });
          qc.invalidateQueries({ queryKey: keys.items });
          toast.success(item.pinned ? "Expiry turned back on" : "Kept forever — this file will not expire");
        } catch (err) {
          fail(err);
        }
      },
      async rename(item) {
        const name = await dialogs.prompt({
          title: `Rename ${item.is_dir ? "folder" : "file"}`,
          label: "New name",
          initial: item.name,
          confirmLabel: "Rename",
          selectStem: !item.is_dir,
        });
        if (!name || name === item.name) return;
        try {
          await api("/api/rename", { path: item.path, name });
          qc.invalidateQueries({ queryKey: keys.items });
          toast.success("Renamed");
        } catch (err) {
          fail(err);
        }
      },
      move(paths) {
        optsRef.current.openMove(paths);
      },
      async moveTo(paths, to, label) {
        try {
          const data = await api<{ moved: number; stats: Stats }>("/api/move", { paths, to });
          absorbStats(qc, data);
          optsRef.current.clearSelection();
          qc.invalidateQueries({ queryKey: keys.items });
          toast.success(data.moved ? `Moved to ${label}` : "Already there");
        } catch (err) {
          fail(err);
        }
      },
      async remove(paths) {
        if (!paths.length) return;
        if (settings.confirm_delete) {
          const yes = await dialogs.confirm({
            title: paths.length === 1 ? "Move to recycle bin?" : `Move ${paths.length} items to recycle bin?`,
            message:
              settings.trash_days > 0
                ? `You can restore ${paths.length === 1 ? "it" : "them"} from the recycle bin for ${settings.trash_days} days.`
                : "You can restore from the recycle bin until it is emptied.",
            confirmLabel: "Move to bin",
            destructive: true,
          });
          if (!yes) return;
        }
        try {
          const data = await api<{ removed: number; trash_ids: string[]; stats: Stats }>("/api/delete", { paths });
          absorbStats(qc, data);
          optsRef.current.clearSelection();
          refreshAll(qc);
          toast(`${data.removed === 1 ? "Moved" : `${plural(data.removed, "item")} moved`} to the recycle bin`, {
            action: data.trash_ids?.length
              ? { label: "Undo", onClick: () => restore(data.trash_ids) }
              : undefined,
          });
        } catch (err) {
          fail(err);
        }
      },
      details(item) {
        optsRef.current.openDetails(item);
      },
    };
  }, [qc, settings.confirm_delete, settings.trash_days, dialogs]);
}

type Entry = { key: string; label: string; icon: LucideIcon; run: () => void; destructive?: boolean } | "sep";

export function entriesFor(item: Item, actions: FileActions): Entry[] {
  if (item.is_dir) {
    return [
      { key: "open", label: "Open", icon: FolderOpen, run: () => actions.open(item) },
      { key: "zip", label: "Download as ZIP", icon: Download, run: () => actions.download([item]) },
      { key: "info", label: "Details", icon: Info, run: () => actions.details(item) },
      "sep",
      { key: "rename", label: "Rename", icon: Pencil, run: () => actions.rename(item) },
      { key: "move", label: "Move to…", icon: FolderInput, run: () => actions.move([item.path]) },
      "sep",
      { key: "del", label: "Move to recycle bin", icon: Trash2, destructive: true, run: () => actions.remove([item.path]) },
    ];
  }
  return [
    { key: "open", label: item.kind === "audio" ? "Play" : "Open", icon: Play, run: () => actions.open(item) },
    { key: "dl", label: "Download", icon: Download, run: () => actions.download([item]) },
    { key: "link", label: "Copy link", icon: Link2, run: () => actions.copyLink(item) },
    {
      key: "pin",
      label: item.pinned ? "Allow expiry" : "Keep forever",
      icon: item.pinned ? PinOff : Pin,
      run: () => actions.togglePin(item),
    },
    { key: "info", label: "Details", icon: Info, run: () => actions.details(item) },
    "sep",
    { key: "rename", label: "Rename", icon: Pencil, run: () => actions.rename(item) },
    { key: "move", label: "Move to…", icon: FolderInput, run: () => actions.move([item.path]) },
    "sep",
    { key: "del", label: "Move to recycle bin", icon: Trash2, destructive: true, run: () => actions.remove([item.path]) },
  ];
}

export function MenuEntries({ entries, kind }: { entries: Entry[]; kind: "dropdown" | "context" }) {
  const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Sep = kind === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {entries.map((e, i) =>
        e === "sep" ? (
          <Sep key={`sep${i}`} />
        ) : (
          <Item key={e.key} variant={e.destructive ? "destructive" : "default"} onSelect={e.run}>
            <e.icon />
            {e.label}
          </Item>
        ),
      )}
    </>
  );
}
