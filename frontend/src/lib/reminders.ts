import * as React from "react";
import { toast } from "sonner";
import type { PrivateData } from "./api";
import { fmtClock, isDay, parseDay, whenDate } from "./dates";
import { occurrences } from "./recur";
import { hrefFor } from "./router";

/**
 * Reminders ring on this device while pupload is open and unlocked: the Pi can't
 * read the private space while it is locked, so it can't push them on its own.
 * Due times come from events' alerts and from list items with a due date.
 */

const FIRED = "pupload.reminders.fired";
const TICK = 20_000;
/** A reminder still rings if it is at most this late (the app was closed, or the
 *  event arrived from another device just after its moment). */
const GRACE = 60 * 60_000;
/** Whole-day items remind at this hour. */
export const DAY_REMINDER_HOUR = 9;

interface Due {
  key: string;
  at: number;
  title: string;
  body: string;
  href: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

/** When a whole-day or timed moment reminds. */
export function remindAt(s: string): Date {
  if (isDay(s)) {
    const d = parseDay(s);
    d.setHours(DAY_REMINDER_HOUR, 0, 0, 0);
    return d;
  }
  return new Date(s);
}

function dueBetween(data: PrivateData, from: number, to: number): Due[] {
  const out: Due[] = [];
  for (const ev of data.event) {
    if (!ev.alerts.length) continue;
    const longest = Math.max(...ev.alerts) * 60_000;
    // Showings that start soon enough for one of their alerts to fall in the window.
    for (const occ of occurrences(ev, new Date(from - DAY_MS_2), new Date(to + longest + DAY_MS_2))) {
      const startAt = ev.all_day ? remindAt(dayOf(occ.start)).getTime() : occ.start.getTime();
      for (const minutes of ev.alerts) {
        const at = startAt - minutes * 60_000;
        if (at > from && at <= to) {
          const when = ev.all_day ? "Today" : minutes === 0 ? `Now · ${fmtClock(occ.start)}` : `${fmtBefore(minutes)} · ${fmtClock(occ.start)}`;
          out.push({
            key: `e:${occ.key}:${minutes}`,
            at,
            title: ev.title,
            body: [when, ev.location].filter(Boolean).join(" · "),
            href: hrefFor("calendar"),
          });
        }
      }
    }
  }
  for (const list of data.list) {
    for (const item of list.items) {
      if (item.done || !item.due) continue;
      const at = remindAt(item.due).getTime();
      if (at > from && at <= to) {
        out.push({
          key: `l:${item.id}:${item.due}`,
          at,
          title: item.text,
          body: `${list.name}${isDay(item.due) ? " · due today" : ` · ${fmtClock(whenDate(item.due))}`}`,
          href: hrefFor("lists", list.id),
        });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const DAY_MS_2 = 2 * 86_400_000;
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function fmtBefore(minutes: number) {
  if (minutes % 1440 === 0) return minutes === 1440 ? "Tomorrow" : `In ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `In ${minutes / 60} h`;
  return `In ${minutes} min`;
}

export const notificationsSupported = () => "Notification" in window && window.isSecureContext;

export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

export async function askForNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

async function systemNotify(due: Due) {
  if (notificationPermission() !== "granted") return;
  const opts: NotificationOptions = { body: due.body, tag: due.key, icon: "/icons/icon-192.png", data: { href: due.href } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return void (await reg.showNotification(due.title, opts));
  } catch {
    /* fall back below */
  }
  try {
    const n = new Notification(due.title, opts);
    n.onclick = () => {
      window.focus();
      location.hash = due.href;
      n.close();
    };
  } catch {
    /* Android Chrome only allows notifications through the service worker */
  }
}

function ring(due: Due) {
  toast(due.title, {
    description: due.body,
    duration: 30_000,
    action: { label: "Open", onClick: () => (location.hash = due.href) },
  });
  systemNotify(due);
  try {
    navigator.vibrate?.([120, 60, 120]);
  } catch {
    /* not on this device */
  }
}

/** Check for due reminders every few seconds while the private space is open here. */
export function useReminders(data: PrivateData | undefined, enabled: boolean) {
  const dataRef = React.useRef(data);
  dataRef.current = data;

  React.useEffect(() => {
    if (!enabled) return;
    const check = () => {
      const current = dataRef.current;
      if (!current) return;
      const now = Date.now();
      const fired = new Set(read<string[]>(FIRED, []));
      const due = dueBetween(current, now - GRACE, now).filter((d) => !fired.has(d.key));
      if (!due.length) return;
      due.forEach((d) => fired.add(d.key));
      write(FIRED, [...fired].slice(-400));
      due.slice(-5).forEach(ring);
    };
    check();
    const timer = window.setInterval(check, TICK);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}

/** Reminder choices for events, in minutes before the start. */
export const ALERT_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 0, label: "At the start" },
  { minutes: 5, label: "5 min before" },
  { minutes: 10, label: "10 min before" },
  { minutes: 15, label: "15 min before" },
  { minutes: 30, label: "30 min before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 120, label: "2 hours before" },
  { minutes: 1440, label: "1 day before" },
  { minutes: 2880, label: "2 days before" },
  { minutes: 10080, label: "1 week before" },
];

export function alertLabel(minutes: number, allDay: boolean): string {
  if (allDay) {
    if (minutes === 0) return `On the day, ${DAY_REMINDER_HOUR}:00`;
    if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"} before, ${DAY_REMINDER_HOUR}:00`;
  }
  return ALERT_CHOICES.find((c) => c.minutes === minutes)?.label ?? `${minutes} min before`;
}

