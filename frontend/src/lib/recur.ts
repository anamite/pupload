import type { CalEvent } from "./api";
import { addDays, DAY_MS, isDay, parseDay, whenDate } from "./dates";

/** One showing of an event: a repeating event has many. */
export interface Occurrence {
  event: CalEvent;
  start: Date;
  /** Timed: the end instant. All-day: the last day (midnight). */
  end: Date;
  /** Stable per showing, for reminders and React keys. */
  key: string;
}

const MAX_STEPS = 20_000;

function untilOf(until: string | undefined): number {
  if (!until) return Infinity;
  if (isDay(until)) return addDays(parseDay(until), 1).getTime() - 1;
  return new Date(until).getTime();
}

/** Every showing of `ev` that overlaps [from, to]. Repeats keep their local wall-clock time. */
export function occurrences(ev: CalEvent, from: Date, to: Date): Occurrence[] {
  const base = whenDate(ev.start);
  const baseEnd = whenDate(ev.end);
  const length = Math.max(0, baseEnd.getTime() - base.getTime());
  const out: Occurrence[] = [];
  const lo = from.getTime();
  const hi = to.getTime();
  const push = (start: Date) => {
    const end = new Date(start.getTime() + length);
    // An all-day event covers its last day entirely.
    const endEdge = ev.all_day ? end.getTime() + DAY_MS - 1 : end.getTime();
    if (endEdge >= lo && start.getTime() <= hi) {
      out.push({ event: ev, start, end: ev.all_day ? addDays(start, Math.round(length / DAY_MS)) : end, key: `${ev.id}@${start.getTime()}` });
    }
  };

  const rule = ev.repeat;
  if (!rule) {
    push(base);
    return out;
  }

  const interval = Math.max(1, rule.interval || 1);
  const until = untilOf(rule.until);
  const count = rule.count ?? Infinity;
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  const at = (yy: number, mm: number, dd: number) =>
    new Date(yy, mm, dd, base.getHours(), base.getMinutes(), base.getSeconds());

  // Without a count, jump close to the window instead of walking from the first showing.
  let first = 0;
  if (count === Infinity && lo - length > base.getTime()) {
    // Longest possible step, so the jump never lands past the window (DST adds an hour).
    const span = ({ daily: 1, weekly: 7, monthly: 31, yearly: 366 }[rule.freq] * DAY_MS + 3_600_000) * interval;
    first = Math.max(0, Math.floor((lo - length - base.getTime()) / span) - 1);
  }

  let made = 0;
  for (let i = first; i < first + MAX_STEPS; i++) {
    let batch: Date[];
    if (rule.freq === "daily") batch = [at(y, m, d + i * interval)];
    else if (rule.freq === "weekly") {
      if (rule.byday?.length) {
        const weekBegin = at(y, m, d - base.getDay() + i * 7 * interval);
        batch = rule.byday.map((wd) => addDays(weekBegin, wd)).filter((x) => x.getTime() >= base.getTime());
      } else batch = [at(y, m, d + i * 7 * interval)];
    } else if (rule.freq === "monthly") {
      const x = at(y, m + i * interval, d);
      batch = x.getDate() === d ? [x] : []; // the 31st only in months that have one
    } else {
      const x = at(y + i * interval, m, d);
      batch = x.getMonth() === m ? [x] : []; // 29 February only in leap years
    }
    for (const start of batch) {
      if (start.getTime() > hi || start.getTime() > until || made >= count) return out;
      made++;
      push(start);
    }
  }
  return out;
}

/** Showings of every event in [from, to], sorted: all-day first, then by time. */
export function allOccurrences(events: CalEvent[], from: Date, to: Date): Occurrence[] {
  return events
    .flatMap((ev) => occurrences(ev, from, to))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.event.all_day) - Number(a.event.all_day));
}
