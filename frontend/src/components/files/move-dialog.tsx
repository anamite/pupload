import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder, Home, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type FolderNode } from "@/lib/api";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

export function MoveDialog({
  paths,
  current,
  onClose,
  onMove,
}: {
  paths: string[] | null;
  current: string;
  onClose: () => void;
  onMove: (paths: string[], to: string, label: string) => Promise<void>;
}) {
  const open = !!paths;
  const [target, setTarget] = React.useState(current);
  const [filter, setFilter] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["folders"],
    queryFn: async () => (await api<{ folders: FolderNode[] }>("/api/folders")).folders,
    enabled: open,
    staleTime: 0,
  });

  React.useEffect(() => {
    if (open) {
      setTarget(current);
      setFilter("");
    }
  }, [open, current]);

  const rows = (data ?? []).filter((f) => {
    if (paths?.some((p) => f.path === p || f.path.startsWith(`${p}/`))) return false;
    return !filter || f.depth === 0 || f.path.toLowerCase().includes(filter.toLowerCase());
  });
  const chosen = data?.find((f) => f.path === target);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {paths && plural(paths.length, "item")}</DialogTitle>
          <DialogDescription>Pick the folder to move into.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Filter folders" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="scrollbar-thin -mx-1 max-h-[46dvh] overflow-y-auto px-1 sm:max-h-80">
          {isLoading ? (
            <div className="grid gap-1.5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : (
            rows.map((f) => (
              <button
                key={f.path || "/"}
                onClick={() => setTarget(f.path)}
                style={{ paddingLeft: filter ? 10 : 10 + f.depth * 16 }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg py-2 pr-2 text-left text-sm transition-colors hover:bg-accent",
                  f.path === target && "bg-primary/10 font-medium text-primary hover:bg-primary/15",
                )}
              >
                {f.depth === 0 ? <Home className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0 text-folder" />}
                <span className="truncate">{filter && f.depth ? f.path : f.name}</span>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !paths}
            onClick={async () => {
              if (!paths) return;
              setBusy(true);
              await onMove(paths, target, chosen?.name ?? "Home");
              setBusy(false);
              onClose();
            }}
          >
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
