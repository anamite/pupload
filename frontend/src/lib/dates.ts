/**
 * Dates in the private space. A plain "YYYY-MM-DD" is a whole day wherever the
 * viewer is; anything with a time is a UTC instant shown in local time.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DAY_MS = 86_400_000;

export const isDay = (s: string) => DAY_RE.test(s);

export function dayKey(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** A due date or event bound as a local Date (midnight for a whole day). */
export function whenDate(s: string): Date {
  return isDay(s) ? parseDay(s) : new Date(s);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
}

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export const today = () => startOfDay(new Date());

/** Local date and time inputs -> the stored form. No time means a whole day. */
export function joinWhen(date: string, time: string): string | null {
  if (!date) return null;
  if (!time) return date;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? date : d.toISOString();
}

/** The stored form -> local date and time inputs. */
export function splitWhen(s: string | null | undefined): { date: string; time: string } {
  if (!s) return { date: "", time: "" };
  if (isDay(s)) return { date: s, time: "" };
  const d = new Date(s);
  return { date: dayKey(d), time: hhmm(d) };
}

export function hhmm(d: Date): string {
  return `${d.getHours() < 10 ? "0" : ""}${d.getHours()}:${d.getMinutes() < 10 ? "0" : ""}${d.getMinutes()}`;
}

export function fmtClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function fmtDayShort(d: Date): string {
  const t = today();
  const diff = Math.round((startOfDay(d).getTime() - t.getTime()) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}),
  });
}

export type DueTone = "overdue" | "today" | "soon" | "later";

/** "Tomorrow 14:30", "Fri 3 Oct", and how urgent it is. */
export function fmtDue(s: string): { text: string; tone: DueTone } {
  const d = whenDate(s);
  const timed = !isDay(s);
  const now = new Date();
  const startToday = today().getTime();
  const text = fmtDayShort(d) + (timed ? ` ${fmtClock(d)}` : "");
  let tone: DueTone = "later";
  if (timed ? d.getTime() < now.getTime() : d.getTime() < startToday) tone = "overdue";
  else if (sameDay(d, now)) tone = "today";
  else if (d.getTime() - startToday < 3 * DAY_MS) tone = "soon";
  return { text, tone };
}

/** First day of the week for this browser's locale (0 = Sunday), Monday if unknown. */
export function weekStart(): number {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const first = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay;
    if (first) return first % 7;
  } catch {
    /* older browsers */
  }
  return 1;
}

/** The 6×7 days shown for a month. */
export function monthGrid(month: Date, firstDay: number): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() - firstDay + 7) % 7;
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function weekdayNames(firstDay: number, style: "short" | "narrow" = "short"): string[] {
  const base = new Date(2024, 0, 7); // a Sunday
  return Array.from({ length: 7 }, (_, i) =>
    addDays(base, (firstDay + i) % 7).toLocaleDateString(undefined, { weekday: style }),
  );
}
