import * as React from "react";
import { Lock, MoreVertical, Pin, Smartphone } from "lucide-react";
import { KindIcon } from "@/components/file-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextMenu, ContextMenuContent, ContextMenuLabel, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { fileUrl, type Item } from "@/lib/api";
import { deviceId } from "@/lib/device";
import { fmtLeft, fmtSize, fmtWhen, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { entriesFor, MenuEntries, type FileActions } from "./actions";

/** Paths being dragged inside the app (for drag-onto-folder moves). */
let dragging: string[] = [];

export interface ItemViewProps {
  item: Item;
  index: number;
  selected: boolean;
  selecting: boolean;
  thumbnails: boolean;
  actions: FileActions;
  selectedPaths: () => string[];
  onSelect: (item: Item, mode: "toggle" | "range") => void;
  /** Mark secure files with a lock (views that mix them with other files). */
  markSecure?: boolean;
}

const iconKind = (item: Item) => (item.vault ? "vault" : item.kind);

function Name({ item, mark, className }: { item: Item; mark?: boolean; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)} title={item.name}>
      {mark && item.secure && !item.vault && <Lock className="size-3 shrink-0 text-primary" aria-label="Secure" />}
      <span className="truncate">{item.name}</span>
    </div>
  );
}

function FolderSub({ item }: { item: Item }) {
  if (item.locked)
    return (
      <span className="inline-flex items-center gap-1">
        <Lock className="size-3" /> Locked
      </span>
    );
  if (item.vault) return <span>Secure · {plural(item.children ?? 0, "item")}</span>;
  return <span>{plural(item.children ?? 0, "item")}</span>;
}

function useItemBehaviour({ item, selected, selecting, actions, selectedPaths, onSelect }: ItemViewProps) {
  const [dropTarget, setDropTarget] = React.useState(false);

  const onClick = (e: React.MouseEvent) => {
    if (e.shiftKey) return onSelect(item, "range");
    if (e.metaKey || e.ctrlKey || selecting) return onSelect(item, "toggle");
    actions.open(item);
  };

  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      dragging = selected ? selectedPaths() : [item.path];
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-pupload", dragging.join("\n"));
    },
    onDragEnd: () => {
      dragging = [];
    },
    ...(item.is_dir && {
      onDragOver: (e: React.DragEvent) => {
        if (!dragging.length || dragging.includes(item.path)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(true);
      },
      onDragLeave: () => setDropTarget(false),
      onDrop: (e: React.DragEvent) => {
        if (!dragging.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(false);
        const paths = dragging;
        dragging = [];
        actions.moveTo(paths, item.path, item.name);
      },
    }),
  };
  return { onClick, dragProps, dropTarget };
}

function ItemMenu({ item, actions, className }: { item: Item; actions: FileActions; className?: string }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("rounded-full text-muted-foreground data-[state=open]:bg-accent", className)}
          aria-label={`Actions for ${item.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <MenuEntries entries={entriesFor(item, actions)} kind="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WithContextMenu({ item, actions, children }: { item: Item; actions: FileActions; children: React.ReactNode }) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="max-w-56 truncate normal-case tracking-normal">{item.name}</ContextMenuLabel>
        <MenuEntries entries={entriesFor(item, actions)} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Expiry({ item }: { item: Item }) {
  if (item.is_dir) return null;
  if (item.pinned)
    return (
      <Badge variant="success">
        <Pin />
        kept
      </Badge>
    );
  const left = fmtLeft(item.expires);
  if (!left) return null;
  return <Badge variant={left.warn ? "warn" : "outline"}>{left.text}</Badge>;
}

export function DeviceTag({ item, className }: { item: Item; className?: string }) {
  if (!item.device_name) return null;
  const mine = item.device_id && item.device_id === deviceId();
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-muted-foreground", className)} title={`Uploaded from ${item.device_name}`}>
      <Smartphone className="size-3 shrink-0" />
      <span className="truncate">{mine ? "This device" : item.device_name}</span>
    </span>
  );
}

function Thumb({ item, thumbnails, className }: { item: Item; thumbnails: boolean; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  if (item.kind === "image" && thumbnails && !failed) {
    return (
      <img
        src={fileUrl("thumb", item.path)}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className={cn("size-full object-cover", className)}
      />
    );
  }
  return null;
}

/* --------------------------------------------------------------- grid --- */

export function FolderTile(props: ItemViewProps) {
  const { item, selected, selecting, actions, onSelect, index } = props;
  const { onClick, dragProps, dropTarget } = useItemBehaviour(props);
  return (
    <WithContextMenu item={item} actions={actions}>
      <div
        {...dragProps}
        onClick={onClick}
        style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
        className={cn(
          "group relative flex h-16 animate-rise items-center gap-3 rounded-xl border bg-card pr-1.5 pl-3 transition-[background-color,border-color,box-shadow] select-none cv-auto [contain-intrinsic-size:auto_64px]",
          "hover:border-foreground/15 hover:shadow-sm",
          item.locked && "border-dashed bg-muted/40",
          selected && "border-primary/60 bg-primary/5 ring-2 ring-primary/25",
          dropTarget && "border-primary bg-primary/10 ring-2 ring-primary/40",
        )}
      >
        <div className="relative size-9 shrink-0">
          <KindIcon
            kind={iconKind(item)}
            className={cn(
              "size-9 transition-opacity",
              item.locked && "bg-muted text-muted-foreground",
              (selecting || selected) && "opacity-0",
              "group-hover:[@media(hover:hover)]:opacity-0",
            )}
          />
          <Checkbox
            checked={selected}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(item, e.shiftKey ? "range" : "toggle");
            }}
            aria-label={`Select ${item.name}`}
            className={cn(
              "absolute inset-0 m-auto size-5 opacity-0 transition-opacity",
              (selecting || selected) && "opacity-100",
              "group-hover:[@media(hover:hover)]:opacity-100",
            )}
          />
        </div>
        <div className={cn("min-w-0 flex-1", item.locked && "text-muted-foreground")}>
          <div className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </div>
          <div className="truncate text-xs text-muted-foreground tabular">
            <FolderSub item={item} />
          </div>
        </div>
        <ItemMenu item={item} actions={actions} className="touch:opacity-100 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" />
      </div>
    </WithContextMenu>
  );
}

export function FileCard(props: ItemViewProps) {
  const { item, selected, selecting, actions, onSelect, thumbnails, index, markSecure } = props;
  const { onClick, dragProps } = useItemBehaviour(props);
  const hasThumb = item.kind === "image" && thumbnails;
  return (
    <WithContextMenu item={item} actions={actions}>
      <div
        {...dragProps}
        onClick={onClick}
        style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
        className={cn(
          "group relative flex animate-rise flex-col overflow-hidden rounded-xl border bg-card transition-[border-color,box-shadow,transform] select-none cv-auto [contain-intrinsic-size:auto_210px]",
          "hover:border-foreground/15 hover:shadow-md [@media(hover:hover)]:hover:-translate-y-0.5",
          selected && "border-primary/60 ring-2 ring-primary/25",
        )}
      >
        <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/60">
          {hasThumb ? (
            <Thumb item={item} thumbnails={thumbnails} className="transition-transform duration-500 group-hover:scale-[1.03]" />
          ) : (
            <KindIcon kind={item.kind} className="size-14 rounded-2xl" />
          )}
          <div
            className={cn(
              "absolute top-2 left-2 transition-opacity",
              selecting || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 touch:opacity-100",
            )}
          >
            <Checkbox
              checked={selected}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(item, e.shiftKey ? "range" : "toggle");
              }}
              aria-label={`Select ${item.name}`}
            />
          </div>
          <div className="absolute top-1.5 right-1.5">
            <ItemMenu
              item={item}
              actions={actions}
              className="bg-card/85 opacity-0 shadow-sm backdrop-blur group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 touch:opacity-100"
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1 px-3 pt-2.5 pb-3">
          <Name item={item} mark={markSecure} className="text-sm leading-tight font-medium" />
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 font-mono text-[11px] tabular">{fmtSize(item.size)}</span>
            <Expiry item={item} />
          </div>
          <DeviceTag item={item} className="text-[11px]" />
        </div>
      </div>
    </WithContextMenu>
  );
}

/* --------------------------------------------------------------- list --- */

export function ItemRow(props: ItemViewProps) {
  const { item, selected, selecting, actions, onSelect, thumbnails, markSecure } = props;
  const { onClick, dragProps, dropTarget } = useItemBehaviour(props);
  return (
    <WithContextMenu item={item} actions={actions}>
      <div
        {...dragProps}
        onClick={onClick}
        className={cn(
          "group grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-2 py-2 transition-colors select-none last:border-b-0 cv-auto [contain-intrinsic-size:auto_58px] md:grid-cols-[auto_minmax(0,1fr)_5.5rem_7rem_9rem_5.5rem_auto] md:px-3",
          "hover:bg-accent/60",
          selected && "bg-primary/6 hover:bg-primary/10",
          dropTarget && "bg-primary/10 ring-2 ring-primary/40 ring-inset",
        )}
      >
        <div className="relative size-9">
          <div className={cn("size-9 overflow-hidden rounded-lg transition-opacity", (selecting || selected) && "opacity-0", "group-hover:[@media(hover:hover)]:opacity-0")}>
            {item.kind === "image" && thumbnails ? (
              <div className="size-9 bg-muted">
                <Thumb item={item} thumbnails={thumbnails} />
              </div>
            ) : (
              <KindIcon kind={iconKind(item)} className={cn("size-9", item.locked && "bg-muted text-muted-foreground")} />
            )}
          </div>
          <Checkbox
            checked={selected}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(item, e.shiftKey ? "range" : "toggle");
            }}
            aria-label={`Select ${item.name}`}
            className={cn(
              "absolute inset-0 m-auto opacity-0 transition-opacity",
              (selecting || selected) && "opacity-100",
              "group-hover:[@media(hover:hover)]:opacity-100",
            )}
          />
        </div>
        <div className={cn("min-w-0", item.locked && "text-muted-foreground")}>
          <Name item={item} mark={markSecure} className="text-sm font-medium" />
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground md:hidden">
            {item.is_dir ? (
              <FolderSub item={item} />
            ) : (
              <>
                <span className="shrink-0 font-mono text-[11px] tabular">{fmtSize(item.size)}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{fmtWhen(item.created)}</span>
                <Expiry item={item} />
              </>
            )}
          </div>
          {item.parent && (
            <div className="hidden truncate text-xs text-muted-foreground md:block" title={item.parent}>
              in {item.parent}
            </div>
          )}
        </div>
        <div className="hidden text-right font-mono text-xs text-muted-foreground tabular md:block">
          {item.locked ? "Locked" : item.is_dir ? plural(item.children ?? 0, "item") : fmtSize(item.size)}
        </div>
        <div className="hidden text-xs text-muted-foreground md:block">{fmtWhen(item.created)}</div>
        <div className="hidden min-w-0 text-xs md:block">
          <DeviceTag item={item} />
        </div>
        <div className="hidden md:block">
          <Expiry item={item} />
        </div>
        <ItemMenu item={item} actions={actions} />
      </div>
    </WithContextMenu>
  );
}

export function ListHeader() {
  return (
    <div className="sticky top-0 z-10 hidden grid-cols-[auto_minmax(0,1fr)_5.5rem_7rem_9rem_5.5rem_auto] items-center gap-3 border-b bg-card/95 px-3 py-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase backdrop-blur md:grid">
      <span className="w-9" />
      <span>Name</span>
      <span className="text-right">Size</span>
      <span>Added</span>
      <span>From</span>
      <span>Expiry</span>
      <span className="w-8" />
    </div>
  );
}
