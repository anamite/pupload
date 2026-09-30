import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CornerDownLeft, FolderSymlink, Home, LockKeyhole, Search } from "lucide-react";
import { KindIcon } from "@/components/file-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Item } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** Pick a file or folder of the drive to reference from a note. */
export function RefPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [dir, setDir] = React.useState("");
  const [query, setQuery] = React.useState("");
  const needle = useDebounced(query.trim(), 200);

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const listing = useQuery({
    queryKey: ["picker", "list", dir],
    queryFn: async () => (await api<{ items: Item[] }>(`/api/list?path=${encodeURIComponent(dir)}&sort=name`)).items,
    enabled: open && !needle,
    retry: false,
  });
  const found = useQuery({
    queryKey: ["picker", "search", needle],
    queryFn: async () => (await api<{ items: Item[] }>(`/api/search?q=${encodeURIComponent(needle)}`)).items,
    enabled: open && !!needle,
  });
  const items = (needle ? found.data : listing.data) ?? [];
  const loading = needle ? found.isLoading : listing.isLoading;
  const crumbs = dir ? dir.split("/") : [];

  const pick = (item: Item) => {
    if (item.locked) return;
    if (item.is_dir && !needle) setDir(item.path);
    else onPick(item.path);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a file or folder</DialogTitle>
          <DialogDescription>It appears in the note as a chip that opens it.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus className="pl-9" placeholder="Search everything" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {!needle && (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <nav className="scrollbar-thin flex min-w-0 items-center gap-0.5 overflow-x-auto text-sm">
              <button onClick={() => setDir("")} className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent">
                <Home className="size-3.5" /> Home
              </button>
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <button
                    onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}
                    className="shrink-0 truncate rounded-md px-1.5 py-1 hover:bg-accent"
                  >
                    {c}
                  </button>
                </React.Fragment>
              ))}
            </nav>
            {dir && (
              <Button size="sm" variant="outline" onClick={() => onPick(dir)} className="shrink-0">
                <FolderSymlink /> Link this folder
              </Button>
            )}
          </div>
        )}
        <div className="scrollbar-thin -mx-2 min-h-48 flex-1 overflow-y-auto px-2">
          {loading ? (
            <div className="grid gap-1.5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{needle ? "Nothing matches" : "This folder is empty"}</p>
          ) : (
            <ul className="grid gap-0.5">
              {items.map((item) => (
                <li key={item.path}>
                  <div
                    className={cn(
                      "group flex items-center gap-2 rounded-lg pr-1 hover:bg-accent",
                      item.locked && "opacity-50",
                    )}
                  >
                    <button
                      disabled={item.locked}
                      onClick={() => pick(item)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left"
                    >
                      <KindIcon kind={item.vault ? "vault" : item.kind} className="size-8" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.name}</span>
                        {needle && <span className="block truncate text-xs text-muted-foreground">{item.parent || "Home"}</span>}
                      </span>
                      {item.locked ? (
                        <LockKeyhole className="size-4 text-muted-foreground" />
                      ) : item.is_dir && !needle ? (
                        <ChevronRight className="size-4 text-muted-foreground" />
                      ) : null}
                    </button>
                    {item.is_dir && !needle && !item.locked && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Link this folder"
                        aria-label={`Link ${item.name}`}
                        onClick={() => onPick(item.path)}
                        className="opacity-60 group-hover:opacity-100"
                      >
                        <CornerDownLeft />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
