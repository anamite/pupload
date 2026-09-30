import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  ListChecks,
  MapPin,
  MoreVertical,
  Plus,
  Repeat,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useVaultUi } from "@/components/vault/vault";
import { api, startDownload, type CalEvent, type ListItem, type TodoList } from "@/lib/api";
import {
  addDays,
  dayKey,
  fmtClock,
  fmtDayShort,
  isDay,
  monthGrid,
  sameDay,
  startOfDay,
  today,
  weekdayNames,
  weekStart,
  whenDate,
} from "@/lib/dates";
import { useIsPhone } from "@/lib/hooks";
import { savePrivate, tintColor } from "@/lib/private";
import { keys, usePrivate } from "@/lib/queries";
import { allOccurrences, type Occurrence } from "@/lib/recur";
import { askForNotifications, notificationPermission } from "@/lib/reminders";
import { hrefFor } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Fab, PrivateEyebrow } from "./common";
import { EventDialog } from "./event-dialog";

type Entry =
  | { type: "event"; occ: Occurrence; key: string; at: number }
  | { type: "todo"; item: ListItem; list: TodoList; key: string; at: number };

/** Everything on each day between `from` and `to`: event showings and list items that are due. */
function entriesByDay(events: CalEvent[], lists: TodoList[], from: Date, to: Date, needle: string) {
  const days = new Map<string, Entry[]>();
  const add = (d: Date, e: Entry) => {
    const k = dayKey(d);
    const list = days.get(k);
    if (list) list.push(e);
    else days.set(k, [e]);
  };
  const match = (...texts: string[]) => !needle || texts.some((t) => t.toLowerCase().includes(needle));
  for (const occ of allOccurrences(events.filter((e) => match(e.title, e.notes, e.location)), from, to)) {
    const first = startOfDay(occ.start);
    // A timed event ending exactly at midnight doesn't spill into the next day.
    const lastEdge = occ.event.all_day ? occ.end : new Date(occ.end.getTime() - 1);
    const last = startOfDay(lastEdge < occ.start ? occ.start : lastEdge);
    const at = occ.event.all_day ? first.getTime() - 1 : occ.start.getTime();
    for (let d = first; d <= last; d = addDays(d, 1)) {
      if (d >= startOfDay(from) && d <= to) add(d, { type: "event", occ, key: `${occ.key}:${dayKey(d)}`, at: sameDay(d, first) ? at : d.getTime() - 1 });
    }
  }
  for (const list of lists) {
    for (const item of list.items) {
      if (!item.due || !match(item.text, list.name)) continue;
      const when = whenDate(item.due);
      if (when < startOfDay(from) || when > to) continue;
      add(when, { type: "todo", item, list, key: `t:${item.id}`, at: isDay(item.due) ? when.getTime() : when.getTime() });
    }
  }
  for (const list of days.values()) list.sort((a, b) => a.at - b.at);
  return days;
}

export function CalendarView() {
  const qc = useQueryClient();
  const vault = useVaultUi();
  const phone = useIsPhone();
  const { query } = useApp();
  const { data, isLoading } = usePrivate(true);
  const events = React.useMemo(() => data?.event ?? [], [data]);
  const lists = React.useMemo(() => data?.list ?? [], [data]);
  const [month, setMonth] = React.useState(() => new Date(today().getFullYear(), today().getMonth(), 1));
  const [selected, setSelected] = React.useState(today);
  const [dialog, setDialog] = React.useState<{ event: CalEvent | null; day: Date } | null>(null);
  const [permission, setPermission] = React.useState(notificationPermission);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const firstDay = React.useMemo(weekStart, []);
  const needle = query.trim().toLowerCase();

  const grid = React.useMemo(() => monthGrid(month, firstDay), [month, firstDay]);
  const days = React.useMemo(() => {
    const until = addDays(grid[41], 1);
    return entriesByDay(events, lists, grid[0], new Date(until.getTime() - 1), needle);
  }, [events, lists, grid, needle]);
  const upcoming = React.useMemo(() => {
    const from = today();
    const map = entriesByDay(events, lists, from, addDays(from, 30), needle);
    return [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([k, list]) => list.filter((e) => e.type === "event" || !e.item.done).map((e) => ({ day: k, entry: e })))
      .filter(({ entry }) => entry.type === "todo" || !(entry.occ.event.all_day ? false : entry.occ.end.getTime() < Date.now()))
      .slice(0, 8);
  }, [events, lists, needle]);

  const go = (delta: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const goToday = () => {
    const t = today();
    setMonth(new Date(t.getFullYear(), t.getMonth(), 1));
    setSelected(t);
  };
  const pick = (d: Date) => {
    setSelected(d);
    if (d.getMonth() !== month.getMonth()) setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  const toggleTodo = (list: TodoList, item: ListItem, done: boolean) =>
    savePrivate(qc, "list", {
      ...list,
      items: list.items.map((i) => (i.id === item.id ? { ...i, done, done_at: done ? Date.now() / 1000 : null } : i)),
    }).catch((e) => toast.error(e.message));

  const importIcs = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await api<{ added: number; updated: number }>("/api/private/ics/import", { text, tz });
      qc.invalidateQueries({ queryKey: keys.private });
      toast.success(`${res.added} event${res.added === 1 ? "" : "s"} added${res.updated ? `, ${res.updated} updated` : ""}`);
    } catch (err) {
      if (!vault.handle(err)) toast.error((err as Error).message);
    }
  };

  const enableNotifications = async () => {
    const ok = await askForNotifications();
    setPermission(notificationPermission());
    if (ok) toast.success("Reminders will also show as notifications on this device");
    else toast.error("Notifications are blocked", { description: "Allow them for this site in the browser's settings." });
  };

  const selectedEntries = days.get(dayKey(selected)) ?? [];
  const names = weekdayNames(firstDay, phone ? "narrow" : "short");
  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={<PrivateEyebrow icon={CalendarDays} text="Events, reminders and due list items" />}
        title="Calendar"
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="rounded-lg" onClick={goToday}>
              Today
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Calendar actions">
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-60">
                <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                  <FileUp /> Import an .ics file
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!events.length} onSelect={() => startDownload("/api/private/ics")}>
                  <Download /> Export all events (.ics)
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {permission === "granted" ? (
                  <DropdownMenuItem disabled>
                    <Bell /> Notifications are on here
                  </DropdownMenuItem>
                ) : permission === "unsupported" ? (
                  <DropdownMenuItem disabled className="whitespace-normal">
                    <BellOff /> Reminders show in the app (notifications need HTTPS)
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={enableNotifications}>
                    <Bell /> Turn on notifications
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button className="hidden rounded-xl md:inline-flex" onClick={() => setDialog({ event: null, day: selected })}>
              <Plus /> New event
            </Button>
          </div>
        }
      />
      <input ref={fileInput} type="file" accept=".ics,text/calendar" hidden onChange={(e) => (importIcs(e.target.files?.[0]), (e.target.value = ""))} />

      <div className="flex flex-1 flex-col gap-5 px-4 pb-6 sm:px-6 lg:flex-row lg:px-8">
        <section className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => go(-1)}>
              <ChevronLeft />
            </Button>
            <h2 className="min-w-0 flex-1 text-center font-display text-xl font-semibold capitalize sm:text-2xl">{monthLabel}</h2>
            <Button variant="ghost" size="icon" aria-label="Next month" onClick={() => go(1)}>
              <ChevronRight />
            </Button>
          </div>
          {isLoading ? (
            <Skeleton className="h-[480px]" />
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
              <div className="grid grid-cols-7 border-b bg-muted/40">
                {names.map((n, i) => (
                  <div key={i} className="py-2 text-center text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    {n}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {grid.map((d, i) => (
                  <DayCell
                    key={i}
                    day={d}
                    inMonth={d.getMonth() === month.getMonth()}
                    selected={sameDay(d, selected)}
                    entries={days.get(dayKey(d)) ?? []}
                    compact={phone}
                    lastCol={i % 7 === 6}
                    lastRow={i >= 35}
                    onSelect={() => pick(d)}
                    onNew={() => setDialog({ event: null, day: d })}
                    onOpen={(ev) => setDialog({ event: ev, day: d })}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="grid content-start gap-5 lg:w-80 lg:shrink-0 xl:w-96">
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="font-display text-lg font-semibold">
                {fmtDayShort(selected)}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {selected.toLocaleDateString(undefined, { day: "numeric", month: "long" })}
                </span>
              </h3>
              <Button variant="ghost" size="sm" onClick={() => setDialog({ event: null, day: selected })}>
                <CalendarPlus /> Add
              </Button>
            </div>
            {selectedEntries.length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Nothing on this day</p>
            ) : (
              <ul className="grid gap-1.5">
                {selectedEntries.map((e) => (
                  <AgendaRow key={e.key} entry={e} day={selected} onOpen={(ev) => setDialog({ event: ev, day: selected })} onToggle={toggleTodo} />
                ))}
              </ul>
            )}
          </div>
          {upcoming.length > 0 && (
            <div>
              <h3 className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Coming up</h3>
              <ul className="grid gap-1.5">
                {upcoming.map(({ day, entry }) => (
                  <li key={`${day}:${entry.key}`}>
                    <button onClick={() => pick(whenDate(day))} className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent">
                      <span className="w-20 shrink-0 text-xs text-muted-foreground">{fmtDayShort(whenDate(day))}</span>
                      <EntryDot entry={entry} />
                      <span className="min-w-0 flex-1 truncate text-sm">{entry.type === "event" ? entry.occ.event.title : entry.item.text}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular">{entryTime(entry)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
      <Fab label="New event" onClick={() => setDialog({ event: null, day: selected })} />
      <EventDialog open={!!dialog} event={dialog?.event ?? null} day={dialog?.day ?? selected} onClose={() => setDialog(null)} />
    </div>
  );
}

function entryTime(e: Entry): string {
  if (e.type === "todo") return isDay(e.item.due!) ? "" : fmtClock(whenDate(e.item.due!));
  return e.occ.event.all_day ? "all day" : fmtClock(e.occ.start);
}

function EntryDot({ entry }: { entry: Entry }) {
  if (entry.type === "todo")
    return <span className={cn("size-2 shrink-0 rounded-full border-[1.5px]", entry.item.done && "opacity-40")} style={{ borderColor: tintColor(entry.list.color) }} />;
  return <span className="size-2 shrink-0 rounded-full" style={{ background: tintColor(entry.occ.event.color) }} />;
}

function DayCell({
  day,
  inMonth,
  selected,
  entries,
  compact,
  lastCol,
  lastRow,
  onSelect,
  onNew,
  onOpen,
}: {
  day: Date;
  inMonth: boolean;
  selected: boolean;
  entries: Entry[];
  compact: boolean;
  lastCol: boolean;
  lastRow: boolean;
  onSelect: () => void;
  onNew: () => void;
  onOpen: (ev: CalEvent) => void;
}) {
  const isToday = sameDay(day, new Date());
  const max = 3;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={compact ? undefined : onNew}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect())}
      className={cn(
        "relative flex min-w-0 flex-col gap-0.5 p-1 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        compact ? "h-14 items-center" : "h-28 xl:h-32",
        !lastCol && "border-r",
        !lastRow && "border-b",
        !inMonth && "bg-muted/35",
        selected ? "bg-primary/[0.07]" : "hover:bg-accent/50",
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-medium tabular",
          !inMonth && "text-muted-foreground/60",
          isToday && "bg-primary font-semibold text-primary-foreground",
          selected && !isToday && "ring-2 ring-primary/60",
        )}
      >
        {day.getDate()}
      </span>
      {compact ? (
        <span className="flex flex-wrap justify-center gap-[3px]">
          {entries.slice(0, 4).map((e) => (
            <EntryDot key={e.key} entry={e} />
          ))}
        </span>
      ) : (
        <>
          {entries.slice(0, max).map((e) => (
            <button
              key={e.key}
              type="button"
              title={e.type === "event" ? e.occ.event.title : `${e.item.text} (${e.list.name})`}
              onClick={(ev) => {
                ev.stopPropagation();
                onSelect();
                if (e.type === "event") onOpen(e.occ.event);
              }}
              className={cn(
                "flex w-full min-w-0 items-center gap-1 rounded px-1 py-px text-left text-[11.5px] leading-tight hover:brightness-95",
                e.type === "todo" && e.item.done && "line-through opacity-50",
              )}
              style={
                e.type === "event" && e.occ.event.all_day
                  ? { background: tintColor(e.occ.event.color, 0.18), color: "var(--foreground)" }
                  : undefined
              }
            >
              <EntryDot entry={e} />
              {e.type === "event" && !e.occ.event.all_day && <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular">{fmtClock(e.occ.start)}</span>}
              <span className="truncate">{e.type === "event" ? e.occ.event.title : e.item.text}</span>
            </button>
          ))}
          {entries.length > max && <span className="px-1 text-[11px] font-medium text-muted-foreground">+{entries.length - max} more</span>}
        </>
      )}
    </div>
  );
}

function AgendaRow({
  entry,
  day,
  onOpen,
  onToggle,
}: {
  entry: Entry;
  day: Date;
  onOpen: (ev: CalEvent) => void;
  onToggle: (list: TodoList, item: ListItem, done: boolean) => void;
}) {
  if (entry.type === "todo") {
    const { item, list } = entry;
    return (
      <li className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
        <Checkbox checked={item.done} onCheckedChange={(v) => onToggle(list, item, v === true)} aria-label={item.done ? "Mark as not done" : "Mark as done"} />
        <div className="min-w-0 flex-1">
          <div className={cn("text-sm font-medium [overflow-wrap:anywhere]", item.done && "text-muted-foreground line-through")}>{item.text}</div>
          <a href={hrefFor("lists", list.id)} className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ListChecks className="size-3" /> {list.name}
            {!isDay(item.due!) && ` · ${fmtClock(whenDate(item.due!))}`}
          </a>
        </div>
      </li>
    );
  }
  const { occ } = entry;
  const ev = occ.event;
  let time = "All day";
  if (!ev.all_day) {
    const startsToday = sameDay(occ.start, day);
    const endsToday = sameDay(occ.end, day) || occ.end.getTime() === addDays(startOfDay(day), 1).getTime();
    time = `${startsToday ? fmtClock(occ.start) : "…"} – ${endsToday ? fmtClock(occ.end) : "…"}`;
  } else if (!sameDay(occ.start, occ.end)) {
    time = `All day · until ${fmtDayShort(occ.end)}`;
  }
  return (
    <li>
      <button onClick={() => onOpen(ev)} className="flex w-full items-stretch gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/15">
        <span className="w-1 shrink-0 rounded-full" style={{ background: tintColor(ev.color) }} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold [overflow-wrap:anywhere]">{ev.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono tabular">{time}</span>
            {ev.repeat && (
              <span className="inline-flex items-center gap-1">
                <Repeat className="size-3" /> {ev.repeat.freq}
              </span>
            )}
            {ev.alerts.length > 0 && <Bell className="size-3" />}
            {ev.location && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <MapPin className="size-3 shrink-0" /> <span className="truncate">{ev.location}</span>
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
