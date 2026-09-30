import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  AlarmClockOff,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ListChecks,
  ListX,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { useDialogs } from "@/components/dialogs";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { ListItem, TodoList } from "@/lib/api";
import { whenDate } from "@/lib/dates";
import { useIsPhone } from "@/lib/hooks";
import { deletePrivate, newId, savePrivate, tintColor } from "@/lib/private";
import { usePrivate } from "@/lib/queries";
import { hrefFor, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DueChip, DuePicker, Fab, PrivateEyebrow, Swatches } from "./common";

const byPinThenName = (a: TodoList, b: TodoList) =>
  Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

function nextDue(list: TodoList): ListItem | undefined {
  return list.items
    .filter((i) => !i.done && i.due)
    .sort((a, b) => whenDate(a.due!).getTime() - whenDate(b.due!).getTime())[0];
}

export function ListsView({ id }: { id: string }) {
  const qc = useQueryClient();
  const phone = useIsPhone();
  const dialogs = useDialogs();
  const { query } = useApp();
  const { data, isLoading } = usePrivate(true);
  const lists = React.useMemo(() => [...(data?.list ?? [])].sort(byPinThenName), [data]);
  const needle = query.trim().toLowerCase();
  const shown = lists.filter(
    (l) => !needle || l.name.toLowerCase().includes(needle) || l.items.some((i) => i.text.toLowerCase().includes(needle)),
  );
  const current = lists.find((l) => l.id === id) ?? (!phone && !id ? shown[0] : undefined);

  const create = async () => {
    const name = await dialogs.prompt({ title: "New list", label: "Name", placeholder: "Groceries, Packing, To do…", confirmLabel: "Create" });
    if (!name) return;
    const now = Date.now() / 1000;
    const list: TodoList = { id: newId(), name, items: [], pinned: false, color: "", created: now, updated: now };
    navigate("lists", list.id);
    savePrivate(qc, "list", list).catch((e) => toast.error(e.message));
  };

  if (phone && id) {
    return current ? (
      <ListDetail key={current.id} list={current} filter={needle} back />
    ) : isLoading ? (
      <Skeleton className="m-4 h-64" />
    ) : (
      <div className="p-4">
        <EmptyState icon={ListChecks} title="This list is gone" text="It may have been moved to the recycle bin." action={<Button onClick={() => navigate("lists")}>All lists</Button>} />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={<PrivateEyebrow icon={ListChecks} text="To-dos, shopping, anything with a name" />}
        title="Lists"
        count={isLoading ? undefined : lists.length}
        actions={
          <Button className="hidden rounded-xl md:inline-flex" onClick={create}>
            <Plus /> New list
          </Button>
        }
      />
      <div className="flex flex-1 gap-6 px-4 pb-6 sm:px-6 lg:px-8">
        {isLoading ? (
          <Skeleton className="h-64 flex-1" />
        ) : lists.length === 0 ? (
          <div className="flex-1">
            <EmptyState
              icon={ListChecks}
              title="No lists yet"
              text="Make a list for groceries, packing or to-dos. Give items a date and time, and they show up in the calendar and remind you."
              action={
                <Button onClick={create}>
                  <Plus /> New list
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <nav className={cn("grid content-start gap-1.5", phone ? "flex-1" : "w-64 shrink-0 lg:w-72")}>
              {shown.length === 0 && <EmptyState icon={Search} title="No matching lists" text="Try another word." />}
              {shown.map((list) => (
                <ListLink key={list.id} list={list} active={!phone && current?.id === list.id} />
              ))}
            </nav>
            {!phone && current && (
              <div className="min-w-0 flex-1">
                <ListDetail key={current.id} list={current} filter={needle} />
              </div>
            )}
          </>
        )}
      </div>
      <Fab label="New list" onClick={create} />
    </div>
  );
}

function ListLink({ list, active }: { list: TodoList; active: boolean }) {
  const left = list.items.filter((i) => !i.done).length;
  const due = nextDue(list);
  return (
    <a
      href={hrefFor("lists", list.id)}
      data-active={active}
      className="group flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-sm data-[active=true]:border-primary/40 data-[active=true]:shadow-[0_0_0_1px_var(--primary)]"
    >
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: tintColor(list.color) }} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{list.name}</span>
          {list.pinned && <Pin className="size-3 shrink-0 text-primary" />}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular">{list.items.length ? `${left} of ${list.items.length} left` : "Empty"}</span>
          {due && <DueChip due={due.due!} className="py-0" />}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground md:hidden" />
    </a>
  );
}

function ListDetail({ list, filter, back = false }: { list: TodoList; filter: string; back?: boolean }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const { settings } = useApp();
  const [text, setText] = React.useState("");
  const [due, setDue] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState<{ item: ListItem | null } | null>(null);
  const [showDone, setShowDone] = React.useState(true);
  const input = React.useRef<HTMLInputElement>(null);

  // A new, empty list is ready to type into (once the naming dialog has let go of focus).
  React.useEffect(() => {
    if (list.items.length) return;
    const t = window.setTimeout(() => input.current?.focus(), 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.id]);

  const save = (patch: Partial<TodoList>) => savePrivate(qc, "list", { ...list, ...patch }).catch((e) => toast.error(e.message));
  const setItems = (items: ListItem[]) => save({ items });
  const update = (id: string, patch: Partial<ListItem>) =>
    setItems(list.items.map((i) => (i.id === id ? { ...i, ...patch, ...(patch.done ? { done_at: Date.now() / 1000 } : {}) } : i)));

  const add = (raw = text) => {
    // Pasting several lines adds several items (handy for shopping lists).
    const lines = raw.split("\n").map((l) => l.replace(/^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]?\]\s*)?/, "").trim()).filter(Boolean);
    if (!lines.length) return;
    const now = Date.now() / 1000;
    const added = lines.map((t) => ({ id: newId(), text: t, done: false, due, note: "", created: now, done_at: null }));
    setItems([...list.items, ...added]);
    setText("");
    setDue(null);
    input.current?.focus();
  };

  const rename = async () => {
    const name = await dialogs.prompt({ title: "Rename list", label: "Name", initial: list.name, confirmLabel: "Rename" });
    if (name && name !== list.name) save({ name });
  };

  const remove = async () => {
    if (settings.confirm_delete && list.items.length) {
      const yes = await dialogs.confirm({ title: "Move list to recycle bin?", message: `${list.name} and its ${list.items.length} items`, confirmLabel: "Move to bin", destructive: true });
      if (!yes) return;
    }
    navigate("lists");
    deletePrivate(qc, "list", [list.id], () => navigate("lists", list.id));
  };

  const match = (i: ListItem) => !filter || i.text.toLowerCase().includes(filter) || list.name.toLowerCase().includes(filter);
  const open = list.items.filter((i) => !i.done && match(i));
  const done = list.items.filter((i) => i.done && match(i)).sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0));

  return (
    <section className={cn("animate-in fade-in-0 duration-200", back && "px-4 pt-3 pb-6")}>
      <div className="flex items-center gap-2 border-b pb-3" style={{ borderBottomColor: tintColor(list.color, 0.55) }}>
        {back && (
          <Button variant="ghost" size="icon" aria-label="All lists" onClick={() => navigate("lists")}>
            <ArrowLeft />
          </Button>
        )}
        <button onClick={rename} className="min-w-0 flex-1 truncate text-left font-display text-2xl font-semibold sm:text-3xl" title="Rename">
          {list.name}
        </button>
        <span className="shrink-0 font-mono text-sm text-muted-foreground tabular">
          {list.items.filter((i) => i.done).length}/{list.items.length}
        </span>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="List actions">
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem onSelect={rename}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => save({ pinned: !list.pinned })}>
              {list.pinned ? <PinOff /> : <Pin />} {list.pinned ? "Unpin" : "Pin to top"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!done.length} onSelect={() => setItems(list.items.filter((i) => !i.done))}>
              <ListX /> Clear completed
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Colour</DropdownMenuLabel>
            <div className="px-2 pb-2">
              <Swatches value={list.color} onChange={(color) => save({ color })} />
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={remove}>
              <Trash2 /> Move list to recycle bin
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <form
        className="mt-3 flex items-center gap-2 rounded-xl border bg-card p-1.5 pl-3 shadow-xs focus-within:border-primary/50 focus-within:ring-[3px] focus-within:ring-ring/30"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Plus className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (pasted.includes("\n")) {
              e.preventDefault();
              add(text ? `${text}\n${pasted}` : pasted);
            }
          }}
          placeholder="Add an item"
          aria-label="New item"
          className="h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
        {due ? (
          <DueChip due={due} onClick={() => setPicking({ item: null })} />
        ) : (
          <Button type="button" variant="ghost" size="icon-sm" title="Due date and reminder" aria-label="Due date and reminder" onClick={() => setPicking({ item: null })}>
            <AlarmClock />
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!text.trim()}>
          Add
        </Button>
      </form>

      <ul className="mt-3 grid gap-1">
        {open.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            onToggle={(v) => update(item.id, { done: v })}
            onText={(t) => update(item.id, { text: t })}
            onDue={() => setPicking({ item })}
            onClearDue={() => update(item.id, { due: null })}
            onDelete={() => setItems(list.items.filter((i) => i.id !== item.id))}
          />
        ))}
        {!open.length && !!list.items.length && !filter && (
          <li className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">All done 🎉</li>
        )}
        {!list.items.length && (
          <li className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing here yet. Paste several lines to add them all at once.
          </li>
        )}
      </ul>

      {done.length > 0 && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <button onClick={() => setShowDone((v) => !v)} className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn("size-4 transition-transform", !showDone && "-rotate-90")} />
              Completed · {done.length}
            </button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setItems(list.items.filter((i) => !i.done))}>
              Clear
            </Button>
          </div>
          {showDone && (
            <ul className="mt-1 grid gap-1">
              {done.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  onToggle={(v) => update(item.id, { done: v })}
                  onText={(t) => update(item.id, { text: t })}
                  onDue={() => setPicking({ item })}
                  onClearDue={() => update(item.id, { due: null })}
                  onDelete={() => setItems(list.items.filter((i) => i.id !== item.id))}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      <DuePicker
        open={!!picking}
        value={picking?.item ? picking.item.due : due}
        onClose={() => setPicking(null)}
        onSave={(value) => {
          if (picking?.item) update(picking.item.id, { due: value });
          else setDue(value);
        }}
      />
    </section>
  );
}

function ItemRow({
  item,
  onToggle,
  onText,
  onDue,
  onClearDue,
  onDelete,
}: {
  item: ListItem;
  onToggle: (done: boolean) => void;
  onText: (text: string) => void;
  onDue: () => void;
  onClearDue: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(item.text);
  React.useEffect(() => setValue(item.text), [item.text]);
  const commit = () => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== item.text) onText(next);
    else setValue(item.text);
  };

  return (
    <li className="group flex min-h-11 items-center gap-3 rounded-xl px-3 py-1.5 transition-colors hover:bg-card">
      <Checkbox checked={item.done} onCheckedChange={(v) => onToggle(v === true)} aria-label={item.done ? "Mark as not done" : "Mark as done"} />
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setValue(item.text);
              setEditing(false);
            }
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-base outline-none focus:border-primary/50 md:text-sm"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className={cn(
            "min-w-0 flex-1 py-1 text-left text-[15px] [overflow-wrap:anywhere] md:text-sm",
            item.done && "text-muted-foreground line-through decoration-muted-foreground/60",
          )}
        >
          {item.text}
        </button>
      )}
      {item.due && <DueChip due={item.due} done={item.done} onClick={onDue} />}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground opacity-60 group-hover:opacity-100 touch:opacity-100" aria-label="Item actions">
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDue}>
            <AlarmClock /> {item.due ? "Change due date" : "Due date and reminder"}
          </DropdownMenuItem>
          {item.due && (
            <DropdownMenuItem onSelect={onClearDue}>
              <AlarmClockOff /> Remove due date
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 /> Delete item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
