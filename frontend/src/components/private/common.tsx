import * as React from "react";
import { AlarmClock, Check, LockOpen, Plus, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { Tint } from "@/lib/api";
import { addDays, dayKey, fmtDue, joinWhen, splitWhen, today } from "@/lib/dates";
import { useIsPhone } from "@/lib/hooks";
import { TINTS, tintColor } from "@/lib/private";
import { DAY_REMINDER_HOUR } from "@/lib/reminders";
import { cn } from "@/lib/utils";

export function PrivateEyebrow({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon className="size-3.5" />
      {text}
      <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-px text-[11px] font-medium text-primary">
        <LockOpen className="size-3" /> Private
      </span>
    </span>
  );
}

export function Swatches({ value, onChange }: { value: Tint; onChange: (t: Tint) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
      {TINTS.map((t) => (
        <button
          key={t.id || "default"}
          type="button"
          role="radio"
          aria-checked={value === t.id}
          title={t.label}
          onClick={() => onChange(t.id)}
          className={cn(
            "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-popover transition-transform hover:scale-110",
            value === t.id && "ring-2 ring-foreground/60",
          )}
          style={{ background: tintColor(t.id) }}
        >
          {value === t.id && <Check className="size-3.5 text-white" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

/** The phone's floating "add" button, like the one on Links. */
export function Fab({ label, onClick, icon: Icon = Plus }: { label: string; onClick: () => void; icon?: LucideIcon }) {
  const phone = useIsPhone();
  if (!phone) return null;
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="fixed right-4 z-30 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_2px_6px_rgb(0_0_0/0.25)] transition-transform active:scale-95"
      style={{ bottom: "calc(var(--bottom-nav-h) + var(--player-h, 0px) + 1rem)" }}
    >
      <Icon className="size-6" strokeWidth={2.4} />
    </button>
  );
}

const TONE: Record<string, string> = {
  overdue: "bg-destructive/12 text-destructive",
  today: "bg-warning/18 text-[color-mix(in_oklch,var(--warning)_75%,var(--foreground))]",
  soon: "bg-primary/10 text-primary",
  later: "bg-muted text-muted-foreground",
};

export function DueChip({ due, done, onClick, className }: { due: string; done?: boolean; onClick?: () => void; className?: string }) {
  const { text, tone } = fmtDue(due);
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap tabular",
        done ? TONE.later : TONE[tone],
        onClick && "hover:opacity-80",
        className,
      )}
    >
      <AlarmClock className="size-3" />
      {text}
    </Tag>
  );
}

/** Pick a due date, optionally with a time. A whole day reminds at 9:00. */
export function DuePicker({
  open,
  value,
  title = "Due date and reminder",
  onClose,
  onSave,
}: {
  open: boolean;
  value: string | null;
  title?: string;
  onClose: () => void;
  onSave: (due: string | null) => void;
}) {
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [timed, setTimed] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const parts = splitWhen(value);
    setDate(parts.date || dayKey(today()));
    setTime(parts.time || "09:00");
    setTimed(!!parts.time);
  }, [open, value]);

  const t = today();
  const saturday = addDays(t, (6 - t.getDay() + 7) % 7 || 7);
  const monday = addDays(t, (8 - t.getDay()) % 7 || 7);
  const quick = [
    { label: "Today", day: t },
    { label: "Tomorrow", day: addDays(t, 1) },
    { label: "Weekend", day: saturday },
    { label: "Next week", day: monday },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(joinWhen(date, timed ? time : ""));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {timed ? "You get a reminder at this time." : `A whole day: the reminder comes at ${DAY_REMINDER_HOUR}:00.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-1.5">
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => setDate(dayKey(q.day))}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  date === dayKey(q.day) ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="due-date">Date</Label>
            <Input id="due-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="due-timed">At a time</Label>
            <Switch id="due-timed" checked={timed} onCheckedChange={setTimed} />
          </div>
          {timed && <Input aria-label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />}
          <DialogFooter className="sm:justify-between">
            {value ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  onSave(null);
                  onClose();
                }}
              >
                <X /> Remove
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!date}>
                Set
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
