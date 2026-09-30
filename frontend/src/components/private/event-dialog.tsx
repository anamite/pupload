import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, Download, MapPin, Repeat as RepeatIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { startDownload, type CalEvent, type Freq, type Repeat, type Tint } from "@/lib/api";
import { addDays, dayKey, hhmm, isDay, joinWhen, parseDay, splitWhen, weekdayNames, weekStart } from "@/lib/dates";
import { deletePrivate, newId, savePrivate } from "@/lib/private";
import { ALERT_CHOICES, alertLabel } from "@/lib/reminders";
import { cn } from "@/lib/utils";
import { Swatches } from "./common";

type Ends = "never" | "on" | "after";

interface Form {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  freq: Freq | "";
  interval: number;
  byday: number[];
  ends: Ends;
  until: string;
  count: number;
  alerts: number[];
  location: string;
  notes: string;
  color: Tint;
}

const FREQ_LABEL: Record<Freq, [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};

function fromEvent(ev: CalEvent): Form {
  const s = splitWhen(ev.start);
  const e = splitWhen(ev.end);
  const r = ev.repeat;
  return {
    title: ev.title,
    allDay: ev.all_day,
    startDate: s.date,
    startTime: s.time || "09:00",
    endDate: e.date,
    endTime: e.time || "10:00",
    freq: r?.freq ?? "",
    interval: r?.interval ?? 1,
    byday: r?.byday ?? [],
    ends: r?.count ? "after" : r?.until ? "on" : "never",
    until: r?.until ? splitWhen(r.until).date : "",
    count: r?.count ?? 10,
    alerts: ev.alerts,
    location: ev.location,
    notes: ev.notes,
    color: ev.color,
  };
}

function blank(day: Date, allDay: boolean): Form {
  const now = new Date();
  const start = dayKey(day) === dayKey(now) ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
  const end = new Date(start.getTime() + 3_600_000);
  return {
    title: "",
    allDay,
    startDate: dayKey(start),
    startTime: hhmm(start),
    endDate: dayKey(end),
    endTime: hhmm(end),
    freq: "",
    interval: 1,
    byday: [],
    ends: "never",
    until: "",
    count: 10,
    alerts: allDay ? [] : [10],
    location: "",
    notes: "",
    color: "",
  };
}

function toEvent(f: Form, base: CalEvent | null): CalEvent {
  let start: string;
  let end: string;
  if (f.allDay) {
    start = f.startDate;
    end = f.endDate && f.endDate >= f.startDate ? f.endDate : f.startDate;
  } else {
    start = joinWhen(f.startDate, f.startTime)!;
    end = joinWhen(f.endDate || f.startDate, f.endTime) ?? start;
    if (isDay(end) || new Date(end) < new Date(start)) end = new Date(new Date(start).getTime() + 3_600_000).toISOString();
  }
  let repeat: Repeat | null = null;
  if (f.freq) {
    repeat = { freq: f.freq, interval: Math.max(1, f.interval || 1) };
    if (f.freq === "weekly" && f.byday.length) repeat.byday = [...f.byday].sort((a, b) => a - b);
    if (f.ends === "on" && f.until) repeat.until = f.until;
    if (f.ends === "after") repeat.count = Math.max(1, f.count || 1);
  }
  const now = Date.now() / 1000;
  return {
    id: base?.id ?? newId(),
    title: f.title.trim() || "Untitled event",
    notes: f.notes,
    location: f.location.trim(),
    all_day: f.allDay,
    start,
    end,
    alerts: [...f.alerts].sort((a, b) => a - b),
    repeat,
    color: f.color,
    source: base?.source ?? "local",
    uid: base?.uid ?? "",
    created: base?.created ?? now,
    updated: now,
  };
}

export function EventDialog({
  open,
  event,
  day,
  onClose,
}: {
  open: boolean;
  event: CalEvent | null;
  day: Date;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = React.useState<Form>(() => blank(day, false));
  const [busy, setBusy] = React.useState(false);
  const firstDay = React.useMemo(weekStart, []);
  const names = React.useMemo(() => weekdayNames(firstDay, "narrow"), [firstDay]);

  React.useEffect(() => {
    if (open) setForm(event ? fromEvent(event) : blank(day, false));
  }, [open, event, day]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  /** Moving the start keeps the length. */
  const moveStart = (date: string, time: string) =>
    setForm((f) => {
      if (!date) return { ...f, startDate: date, startTime: time };
      const oldStart = new Date(`${f.startDate}T${f.allDay ? "00:00" : f.startTime}`);
      const oldEnd = new Date(`${f.endDate || f.startDate}T${f.allDay ? "00:00" : f.endTime}`);
      const span = Math.max(0, oldEnd.getTime() - oldStart.getTime());
      const next = new Date(`${date}T${f.allDay ? "00:00" : time}`);
      if (Number.isNaN(next.getTime()) || Number.isNaN(span)) return { ...f, startDate: date, startTime: time };
      const end = f.allDay ? addDays(parseDay(date), Math.round(span / 86_400_000)) : new Date(next.getTime() + span);
      return { ...f, startDate: date, startTime: time, endDate: dayKey(end), endTime: f.allDay ? f.endTime : hhmm(end) };
    });

  const toggleAlert = (m: number) =>
    setForm((f) => ({ ...f, alerts: f.alerts.includes(m) ? f.alerts.filter((a) => a !== m) : [...f.alerts, m].slice(-5) }));
  const choices = form.allDay ? ALERT_CHOICES.filter((c) => c.minutes === 0 || c.minutes % 1440 === 0) : ALERT_CHOICES;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await savePrivate(qc, "event", toEvent(form, event));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setBusy(false);
  };

  const remove = () => {
    if (!event) return;
    onClose();
    deletePrivate(qc, "event", [event.id]);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form className="grid gap-4" onSubmit={save}>
          <DialogHeader>
            <DialogTitle>{event ? "Edit event" : "New event"}</DialogTitle>
            <DialogDescription>
              {event?.repeat ? "Changes apply to every time it repeats." : "Only unlocked devices see your calendar."}
            </DialogDescription>
          </DialogHeader>

          <Input
            autoFocus={!event}
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Title"
            aria-label="Title"
            className="h-11 text-lg font-medium md:h-11 md:text-base"
          />

          <div className="grid gap-3 rounded-xl border bg-card/60 p-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="ev-allday">All day</Label>
              <Switch
                id="ev-allday"
                checked={form.allDay}
                onCheckedChange={(v) => setForm((f) => ({ ...f, allDay: v, alerts: v ? f.alerts.filter((a) => a === 0 || a % 1440 === 0) : f.alerts }))}
              />
            </div>
            <div className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2">
              <span className="text-sm text-muted-foreground">Starts</span>
              <Input type="date" value={form.startDate} onChange={(e) => moveStart(e.target.value, form.startTime)} required aria-label="Start date" />
              {!form.allDay && (
                <Input type="time" value={form.startTime} onChange={(e) => moveStart(form.startDate, e.target.value)} required aria-label="Start time" className="w-28" />
              )}
              <span className="text-sm text-muted-foreground">Ends</span>
              <Input type="date" value={form.endDate} min={form.startDate} onChange={(e) => set("endDate", e.target.value)} aria-label="End date" />
              {!form.allDay && (
                <Input type="time" value={form.endTime} onChange={(e) => set("endTime", e.target.value)} aria-label="End time" className="w-28" />
              )}
            </div>
          </div>

          <div className="grid gap-2">
            <Label className="flex items-center gap-1.5">
              <RepeatIcon className="size-3.5" /> Repeat
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={form.freq}
                onChange={(e) => set("freq", e.target.value as Freq | "")}
                className="h-10 rounded-lg border border-input bg-card px-3 text-base shadow-xs outline-none focus:border-primary/60 md:h-9 md:text-sm"
                aria-label="Repeat"
              >
                <option value="">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
              {form.freq && (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  every
                  <Input type="number" min={1} max={999} value={form.interval} onChange={(e) => set("interval", Number(e.target.value) || 1)} className="w-16" aria-label="Interval" />
                  {FREQ_LABEL[form.freq][form.interval === 1 ? 0 : 1]}
                </span>
              )}
            </div>
            {form.freq === "weekly" && (
              <div className="flex gap-1.5">
                {names.map((n, i) => {
                  const wd = (firstDay + i) % 7;
                  const on = form.byday.includes(wd);
                  return (
                    <button
                      key={wd}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setForm((f) => ({ ...f, byday: f.byday.includes(wd) ? f.byday.filter((d) => d !== wd) : [...f.byday, wd] }))
                      }
                      className={cn(
                        "flex size-9 items-center justify-center rounded-full border text-sm font-medium transition-colors",
                        on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
                      )}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            )}
            {form.freq && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Ends</span>
                <select
                  value={form.ends}
                  onChange={(e) => set("ends", e.target.value as Ends)}
                  className="h-10 rounded-lg border border-input bg-card px-3 text-base shadow-xs outline-none md:h-9 md:text-sm"
                  aria-label="Ends"
                >
                  <option value="never">Never</option>
                  <option value="on">On a date</option>
                  <option value="after">After a number of times</option>
                </select>
                {form.ends === "on" && <Input type="date" value={form.until} min={form.startDate} onChange={(e) => set("until", e.target.value)} className="w-40" required aria-label="Last date" />}
                {form.ends === "after" && (
                  <>
                    <Input type="number" min={1} max={10000} value={form.count} onChange={(e) => set("count", Number(e.target.value) || 1)} className="w-20" aria-label="Times" />
                    <span className="text-muted-foreground">times</span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <Label className="flex items-center gap-1.5">
              <Bell className="size-3.5" /> Remind me
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {choices.map((c) => {
                const on = form.alerts.includes(c.minutes);
                return (
                  <button
                    key={c.minutes}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleAlert(c.minutes)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
                    )}
                  >
                    {alertLabel(c.minutes, form.allDay)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative">
            <MapPin className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Location" aria-label="Location" className="pl-9" />
          </div>
          <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Notes" aria-label="Notes" className="max-h-60" />
          <div className="grid gap-2">
            <Label>Colour</Label>
            <Swatches value={form.color} onChange={(c) => set("color", c)} />
          </div>

          <DialogFooter className="sm:justify-between">
            {event ? (
              <div className="flex gap-2">
                <Button type="button" variant="ghost" className="h-11 text-destructive hover:text-destructive sm:h-9" onClick={remove}>
                  <Trash2 /> Delete
                </Button>
                <Button type="button" variant="ghost" className="h-11 sm:h-9" onClick={() => startDownload(`/api/private/ics?ids=${encodeURIComponent(event.id)}`)}>
                  <Download /> .ics
                </Button>
              </div>
            ) : (
              <span />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" className="h-11 sm:h-9" disabled={busy || !form.startDate}>
                {event ? "Save" : "Add event"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
