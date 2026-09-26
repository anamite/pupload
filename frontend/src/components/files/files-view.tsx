import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  ChevronRight,
  Clock,
  Download,
  FolderInput,
  FolderPlus,
  FolderUp,
  Hourglass,
  LayoutGrid,
  List,
  Music4,
  Plus,
  Search,
  Smartphone,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { useDialogs } from "@/components/dialogs";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Item, type Sort } from "@/lib/api";
import { plural } from "@/lib/format";
import { useIsPhone } from "@/lib/hooks";
import { keys, useItems, type FileView } from "@/lib/queries";
import { hrefFor, navigate } from "@/lib/router";
import { filesFromDrop, filesFromInput, uploads, type DroppedFile } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import { useFileActions, VIEWABLE } from "./actions";
import { DetailsDialog } from "./details-dialog";
import { FileCard, FolderTile, ItemRow, ListHeader, type ItemViewProps } from "./item-views";
import { MoveDialog } from "./move-dialog";
import { Viewer } from "./viewer";

const SORTS: { id: Sort; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "new", label: "Newest first" },
  { id: "old", label: "Oldest first" },
  { id: "size", label: "Largest first" },
  { id: "expiry", label: "Expiring first" },
];

const VIEW_META: Record<Exclude<FileView, "files">, { title: string; sub: string; icon: typeof Clock }> = {
  recent: { title: "Recent", sub: "The latest uploads from every folder", icon: Clock },
  media: { title: "Media", sub: "Music, video and photos", icon: Music4 },
  expiring: { title: "Expiring soon", sub: "Files closest to their auto-expiry date", icon: Hourglass },
  mine: { title: "My uploads", sub: "Everything sent from this device", icon: Smartphone },
};

export function FilesView({ view, path }: { view: FileView; path: string }) {
  const qc = useQueryClient();
  const phone = useIsPhone();
  const dialogs = useDialogs();
  const { settings, query, setQuery, sort, setSort, layout, setLayout } = useApp();
  const searching = query.trim().length > 0;
  const { data: items = [], isLoading, isError, error } = useItems(view, path, sort, query);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const anchor = React.useRef<string | null>(null);
  const [viewer, setViewer] = React.useState<{ list: Item[]; index: number } | null>(null);
  const [movePaths, setMovePaths] = React.useState<string[] | null>(null);
  const [details, setDetails] = React.useState<Item | null>(null);
  const [dropping, setDropping] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const dirInput = React.useRef<HTMLInputElement>(null);

  const uploadTarget = view === "files" && !searching ? path : "";
  const canCreate = view === "files" && !searching;

  React.useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [view, path, query]);

  React.useEffect(() => {
    if (isError && view === "files" && path) {
      toast.error((error as Error)?.message || "Folder not found");
      navigate("files", "");
    }
  }, [isError, error, view, path]);

  React.useEffect(
    () =>
      uploads.onFinished((ok, failed) => {
        qc.invalidateQueries({ queryKey: keys.items });
        qc.invalidateQueries({ queryKey: keys.stats });
        if (ok && !failed) toast.success(`${plural(ok, "file")} uploaded`);
      }),
    [qc],
  );

  const clearSelection = React.useCallback(() => setSelected(new Set()), []);
  const actions = useFileActions({
    items,
    openViewer: (item) => {
      const list = items.filter((i) => !i.is_dir && VIEWABLE.has(i.kind));
      setViewer({ list, index: Math.max(0, list.findIndex((i) => i.path === item.path)) });
    },
    openMove: setMovePaths,
    openDetails: setDetails,
    clearSelection,
  });

  const onSelect = React.useCallback(
    (item: Item, mode: "toggle" | "range") => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (mode === "range" && anchor.current) {
          const a = items.findIndex((i) => i.path === anchor.current);
          const b = items.findIndex((i) => i.path === item.path);
          if (a >= 0 && b >= 0) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(items[i].path);
            return next;
          }
        }
        if (next.has(item.path)) next.delete(item.path);
        else next.add(item.path);
        anchor.current = item.path;
        return next;
      });
    },
    [items],
  );
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;
  const selectedPaths = React.useCallback(() => Array.from(selectedRef.current), []);
  const selectedItems = items.filter((i) => selected.has(i.path));

  const newFolder = async () => {
    const name = await dialogs.prompt({ title: "New folder", label: "Folder name", confirmLabel: "Create", placeholder: "Holiday photos" });
    if (!name) return;
    try {
      await api("/api/mkdir", { path, name });
      qc.invalidateQueries({ queryKey: keys.items });
      toast.success("Folder created");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const enqueue = (files: DroppedFile[]) => {
    if (!files.length) return;
    uploads.enqueue(files, uploadTarget);
    if (!canCreate) toast(`Uploading to Home`, { description: "Open a folder first to upload somewhere else." });
  };

  // Keyboard: / search, u upload, Del delete, Ctrl+A select all, Esc clear.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewer || movePaths || details) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement)?.tagName ?? "");
      if (e.key === "Escape" && selectedRef.current.size) return clearSelection();
      if (typing) return;
      if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSelected(new Set(items.map((i) => i.path)));
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current.size) {
        e.preventDefault();
        actions.remove(Array.from(selectedRef.current));
      } else if (e.key === "u" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        fileInput.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, actions, clearSelection, viewer, movePaths, details]);

  // Files dragged in from the computer (not cards dragged inside the app).
  React.useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth++;
      setDropping(true);
    };
    const over = (e: DragEvent) => {
      if (isFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        setDropping(false);
      }
    };
    const drop = async (e: DragEvent) => {
      if (!isFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      enqueue(await filesFromDrop(e.dataTransfer));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadTarget, canCreate]);

  const folders = items.filter((i) => i.is_dir);
  const files = items.filter((i) => !i.is_dir);
  const common = (item: Item, index: number): ItemViewProps => ({
    item,
    index,
    selected: selected.has(item.path),
    selecting: selected.size > 0,
    thumbnails: settings.thumbnails,
    actions,
    selectedPaths,
    onSelect,
  });

  const meta = view !== "files" ? VIEW_META[view] : null;
  const title = searching ? `“${query.trim()}”` : meta ? meta.title : path ? path.split("/").pop()! : "Home";

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={
          searching ? (
            <span className="flex items-center gap-1.5">
              <Search className="size-3.5" /> Search results
            </span>
          ) : view === "files" ? (
            <Breadcrumbs path={path} />
          ) : (
            meta && (
              <span className="flex items-center gap-1.5">
                <meta.icon className="size-3.5" /> {meta.sub}
              </span>
            )
          )
        }
        title={title}
        count={isLoading ? undefined : items.length}
        actions={
          <div className="flex items-center gap-2">
            {canCreate && !phone && (
              <>
                <UploadButton onFiles={() => fileInput.current?.click()} onFolder={() => dirInput.current?.click()} />
                <Button variant="outline" onClick={newFolder}>
                  <FolderPlus />
                  <span className="hidden lg:inline">New folder</span>
                </Button>
              </>
            )}
            {searching && (
              <Button variant="outline" onClick={() => setQuery("")}>
                <X /> Clear search
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Sort">
                  <ArrowDownUp />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
                  {SORTS.map((s) => (
                    <DropdownMenuRadioItem key={s.id} value={s.id}>
                      {s.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex rounded-lg border bg-card p-0.5">
              {(["grid", "list"] as const).map((l) => {
                const Icon = l === "grid" ? LayoutGrid : List;
                return (
                  <button
                    key={l}
                    onClick={() => setLayout(l)}
                    aria-label={`${l} layout`}
                    aria-pressed={layout === l}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
                      layout === l ? "bg-secondary text-foreground shadow-xs" : "hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>
        }
      />

      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          total={items.length}
          onAll={() => setSelected(new Set(items.map((i) => i.path)))}
          onClear={clearSelection}
          onDownload={() => actions.download(selectedItems)}
          onMove={() => setMovePaths(Array.from(selected))}
          onDelete={() => actions.remove(Array.from(selected))}
        />
      )}

      <div className="flex-1 px-4 pb-6 sm:px-6 lg:px-8">
        {isLoading ? (
          <LoadingGrid layout={layout} />
        ) : items.length === 0 ? (
          <FilesEmpty view={view} searching={searching} canCreate={canCreate} onUpload={() => fileInput.current?.click()} />
        ) : layout === "grid" ? (
          <div className="grid grid-cols-1 gap-6">
            {folders.length > 0 && (
              <section>
                {files.length > 0 && <SectionLabel>Folders</SectionLabel>}
                <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
                  {folders.map((item, i) => (
                    <FolderTile key={item.path} {...common(item, i)} />
                  ))}
                </div>
              </section>
            )}
            {files.length > 0 && (
              <section>
                {folders.length > 0 && <SectionLabel>Files</SectionLabel>}
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] sm:gap-3">
                  {files.map((item, i) => (
                    <FileCard key={item.path} {...common(item, folders.length + i)} />
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card animate-rise">
            <ListHeader />
            {items.map((item, i) => (
              <ItemRow key={item.path} {...common(item, i)} />
            ))}
          </div>
        )}
      </div>

      {canCreate && phone && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Add"
              className="fixed right-4 z-30 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground transition-transform active:scale-95 data-[state=open]:rotate-45"
              style={{ bottom: "calc(var(--bottom-nav-h) + var(--player-h, 0px) + 1rem)" }}
            >
              <Plus className="size-6" strokeWidth={2.4} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-52">
            <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
              <Upload /> Upload files
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => dirInput.current?.click()}>
              <FolderUp /> Upload a folder
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={newFolder}>
              <FolderPlus /> New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          enqueue(filesFromInput(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={dirInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => {
          enqueue(filesFromInput(e.target.files));
          e.target.value = "";
        }}
      />

      <DropOverlay open={dropping} target={uploadTarget} />
      {viewer && (
        <Viewer
          items={viewer.list}
          index={viewer.index}
          onIndex={(index) => setViewer((v) => (v ? { ...v, index } : v))}
          onClose={() => setViewer(null)}
          onDetails={setDetails}
        />
      )}
      <MoveDialog paths={movePaths} current={path} onClose={() => setMovePaths(null)} onMove={actions.moveTo} />
      <DetailsDialog item={details} onClose={() => setDetails(null)} />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">{children}</h3>;
}

function UploadButton({ onFiles, onFolder }: { onFiles: () => void; onFolder: () => void }) {
  return (
    <div className="flex">
      <Button className="rounded-r-none" onClick={onFiles}>
        <Upload />
        Upload
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="rounded-l-none border-l border-primary-foreground/20 px-2" aria-label="More upload options">
            <ChevronRight className="rotate-90" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onFiles}>
            <Upload /> Upload files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onFolder}>
            <FolderUp /> Upload a folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function Breadcrumbs({ path }: { path: string }) {
  const parts = path ? path.split("/") : [];
  return (
    <nav className="scrollbar-thin -mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1 whitespace-nowrap">
      <a href={hrefFor("files", "")} className="rounded px-1 hover:text-foreground">
        Home
      </a>
      {parts.slice(0, -1).map((part, i) => (
        <React.Fragment key={i}>
          <ChevronRight className="size-3.5 shrink-0 opacity-60" />
          <a href={hrefFor("files", parts.slice(0, i + 1).join("/"))} className="max-w-40 truncate rounded px-1 hover:text-foreground">
            {part}
          </a>
        </React.Fragment>
      ))}
      {parts.length > 0 && <ChevronRight className="size-3.5 shrink-0 opacity-60" />}
    </nav>
  );
}

function SelectionBar(props: {
  count: number;
  total: number;
  onAll: () => void;
  onClear: () => void;
  onDownload: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="sticky top-0 z-20 px-4 pb-3 sm:px-6 lg:px-8">
      <div className="flex items-center gap-1 rounded-xl border border-primary/30 bg-card/95 p-1.5 pl-2 shadow-lg backdrop-blur animate-in fade-in-0 slide-in-from-top-2">
        <Button variant="ghost" size="icon-sm" onClick={props.onClear} aria-label="Clear selection">
          <X />
        </Button>
        <span className="mr-auto pl-1 text-sm font-medium tabular">{props.count} selected</span>
        {props.count < props.total && (
          <Button variant="ghost" size="sm" onClick={props.onAll} className="hidden sm:inline-flex">
            Select all
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={props.onDownload} aria-label="Download">
          <Download />
          <span className="hidden sm:inline">Download</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onMove} aria-label="Move">
          <FolderInput />
          <span className="hidden sm:inline">Move</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onDelete} className="text-destructive hover:text-destructive" aria-label="Delete">
          <Trash2 />
          <span className="hidden sm:inline">Delete</span>
        </Button>
      </div>
    </div>
  );
}

function LoadingGrid({ layout }: { layout: "grid" | "list" }) {
  if (layout === "list")
    return (
      <div className="grid gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="aspect-[4/5]" />
      ))}
    </div>
  );
}

function FilesEmpty({
  view,
  searching,
  canCreate,
  onUpload,
}: {
  view: FileView;
  searching: boolean;
  canCreate: boolean;
  onUpload: () => void;
}) {
  if (searching) return <EmptyState icon={Search} title="Nothing found" text="No file or folder matches that name." />;
  if (view === "media") return <EmptyState icon={Music4} title="No media yet" text="Music, video and photos you upload show up here." />;
  if (view === "expiring")
    return <EmptyState icon={Hourglass} title="Nothing is expiring" text="Every file is kept with the current settings." />;
  if (view === "mine") return <EmptyState icon={Smartphone} title="Nothing from this device yet" text="Files you upload from here are listed in this view." />;
  if (view === "recent") return <EmptyState icon={Clock} title="No uploads yet" text="New files appear here the moment they land." />;
  return (
    <EmptyState
      icon={Upload}
      title="This folder is empty"
      text="Drop files anywhere on the page, or pick some to upload."
      action={
        canCreate && (
          <Button onClick={onUpload}>
            <Upload /> Upload files
          </Button>
        )
      }
    />
  );
}

function DropOverlay({ open, target }: { open: boolean; target: string }) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm transition-opacity duration-200",
        open ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className={cn(
          "flex w-full max-w-md flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary bg-card/90 px-8 py-12 text-center shadow-2xl transition-transform duration-300",
          open ? "scale-100" : "scale-95",
        )}
      >
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Upload className="size-8 animate-bounce" />
        </div>
        <p className="font-display text-2xl font-semibold">Drop to upload</p>
        <p className="text-sm text-muted-foreground">into {target ? target.split("/").pop() : "Home"}</p>
      </div>
    </div>
  );
}
