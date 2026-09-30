"""iCalendar (.ics) in and out, for the private calendar.

Only what a personal calendar needs: VEVENTs with a start, an end (or a
duration), a summary, notes, a location, simple repeats (RRULE FREQ /
INTERVAL / COUNT / UNTIL / weekly BYDAY) and alarms relative to the start.

Times become what the calendar stores: an all-day event keeps plain dates
("2026-10-01", end inclusive); anything else becomes UTC instants
("2026-10-01T10:30:00Z"). A TZID the server doesn't know (Outlook likes
Windows zone names) and floating times use the importing browser's zone.
"""
from __future__ import annotations

import datetime as dt
import re
from typing import Any, Dict, List, Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None  # type: ignore

UTC = dt.timezone.utc
MAX_EVENTS = 5000
FREQS = ("DAILY", "WEEKLY", "MONTHLY", "YEARLY")
WEEKDAYS = ("SU", "MO", "TU", "WE", "TH", "FR", "SA")   # index = JS getDay()

_DURATION_RE = re.compile(r"^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


class IcsError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def _unfold(text: str) -> List[str]:
    lines: List[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw.strip():
            lines.append(raw)
    return lines


def _split_prop(line: str):
    """'DTSTART;TZID=Europe/Berlin:20261001T120000' -> ('DTSTART', {'TZID': ...}, '2026...')."""
    in_quote = False
    for i, ch in enumerate(line):
        if ch == '"':
            in_quote = not in_quote
        elif ch == ":" and not in_quote:
            head, value = line[:i], line[i + 1:]
            break
    else:
        return None
    parts = head.split(";")
    params: Dict[str, str] = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
    return parts[0].upper(), params, value


def _text(value: str) -> str:
    out, i = [], 0
    while i < len(value):
        ch = value[i]
        if ch == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            out.append("\n" if nxt in "nN" else nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _zone(name: Optional[str]):
    if not name or ZoneInfo is None:
        return None
    try:
        return ZoneInfo(name)
    except Exception:
        return None


def _when(value: str, params: Dict[str, str], fallback_tz):
    """(date, None) for a DATE, (None, aware datetime) for a DATE-TIME."""
    value = value.strip()
    if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", value):
        return dt.datetime.strptime(value[:8], "%Y%m%d").date(), None
    m = re.fullmatch(r"(\d{8})T(\d{4})(\d{2})?(Z)?", value)
    if not m:
        raise IcsError(f"Unreadable date {value!r}")
    naive = dt.datetime.strptime(m.group(1) + m.group(2) + (m.group(3) or "00"), "%Y%m%d%H%M%S")
    if m.group(4):
        return None, naive.replace(tzinfo=UTC)
    tz = _zone(params.get("TZID")) or fallback_tz
    return None, naive.replace(tzinfo=tz)


def _duration(value: str) -> Optional[dt.timedelta]:
    m = _DURATION_RE.fullmatch(value.strip())
    if not m:
        return None
    sign, w, d, h, mi, s = m.groups()
    delta = dt.timedelta(weeks=int(w or 0), days=int(d or 0), hours=int(h or 0),
                         minutes=int(mi or 0), seconds=int(s or 0))
    return -delta if sign == "-" else delta


def iso(moment: dt.datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rule(value: str, fallback_tz) -> Optional[Dict[str, Any]]:
    parts = dict(p.split("=", 1) for p in value.split(";") if "=" in p)
    freq = parts.get("FREQ", "").upper()
    if freq not in FREQS:
        return None
    rule: Dict[str, Any] = {"freq": freq.lower()}
    try:
        rule["interval"] = max(1, min(999, int(parts.get("INTERVAL", "1"))))
    except ValueError:
        rule["interval"] = 1
    if parts.get("COUNT", "").isdigit():
        rule["count"] = max(1, min(10000, int(parts["COUNT"])))
    if parts.get("UNTIL"):
        try:
            day, moment = _when(parts["UNTIL"], {}, fallback_tz)
            rule["until"] = day.isoformat() if day else iso(moment)
        except IcsError:
            pass
    if freq == "WEEKLY" and parts.get("BYDAY"):
        days = sorted({WEEKDAYS.index(d[-2:].upper()) for d in parts["BYDAY"].split(",")
                       if d[-2:].upper() in WEEKDAYS})
        if days:
            rule["byday"] = days
    return rule


def parse(text: str, tz_name: str = "") -> List[Dict[str, Any]]:
    """Events from an .ics document, as dicts ready for private.clean_event."""
    fallback = _zone(tz_name) or UTC
    lines = _unfold(text)
    if not any(line.upper().startswith("BEGIN:VCALENDAR") for line in lines[:5]):
        raise IcsError("This is not an iCalendar (.ics) file")
    events: List[Dict[str, Any]] = []
    stack: List[str] = []
    cur: Dict[str, Any] = {}
    alarm: Dict[str, Any] = {}
    cal_tz = None
    for line in lines:
        prop = _split_prop(line)
        if prop is None:
            continue
        name, params, value = prop
        if name == "BEGIN":
            stack.append(value.upper())
            if value.upper() == "VEVENT":
                cur = {"alerts": []}
            elif value.upper() == "VALARM":
                alarm = {}
            continue
        if name == "END":
            block = stack.pop() if stack else ""
            if block == "VALARM" and "VEVENT" in stack and alarm.get("trigger") is not None:
                cur["alerts"].append(alarm["trigger"])
            elif block == "VEVENT":
                try:
                    event = _finish(cur, cal_tz or fallback)
                except IcsError:
                    event = None
                if event:
                    events.append(event)
                    if len(events) >= MAX_EVENTS:
                        break
            continue
        top = stack[-1] if stack else ""
        if top == "VCALENDAR" and name == "X-WR-TIMEZONE":
            cal_tz = _zone(value.strip()) or cal_tz
        elif top == "VALARM" and name == "TRIGGER":
            if params.get("VALUE", "").upper() == "DATE-TIME" or params.get("RELATED", "").upper() == "END":
                continue
            delta = _duration(value)
            if delta is not None and delta <= dt.timedelta(0):
                alarm["trigger"] = int(-delta.total_seconds() // 60)
        elif top == "VEVENT":
            cur.setdefault("_props", {}).setdefault(name, (params, value))
    return events


def _finish(props_holder: Dict[str, Any], tz) -> Optional[Dict[str, Any]]:
    props = props_holder.get("_props") or {}
    if "DTSTART" not in props:
        return None
    if props.get("STATUS", ({}, ""))[1].strip().upper() == "CANCELLED":
        return None
    s_params, s_value = props["DTSTART"]
    start_day, start = _when(s_value, s_params, tz)
    end_day = end = None
    if "DTEND" in props:
        e_params, e_value = props["DTEND"]
        end_day, end = _when(e_value, e_params, tz)
    elif "DURATION" in props:
        delta = _duration(props["DURATION"][1])
        if delta is not None:
            if start_day:
                end_day = start_day + dt.timedelta(days=max(1, delta.days))
            else:
                end = start + delta
    event: Dict[str, Any] = {
        "title": _text(props.get("SUMMARY", ({}, ""))[1]).strip() or "Untitled event",
        "notes": _text(props.get("DESCRIPTION", ({}, ""))[1]).strip(),
        "location": _text(props.get("LOCATION", ({}, ""))[1]).strip(),
        "uid": props.get("UID", ({}, ""))[1].strip()[:300],
        "source": "ics",
        "alerts": sorted(set(props_holder.get("alerts") or []))[:5],
    }
    if start_day is not None:
        # DTEND of an all-day event is exclusive; the calendar keeps the last day.
        last = (end_day or (start_day + dt.timedelta(days=1))) - dt.timedelta(days=1)
        if end is not None:
            last = end.astimezone(tz).date()
        event.update(all_day=True, start=start_day.isoformat(), end=max(last, start_day).isoformat())
    else:
        if end is None and end_day is not None:
            end = dt.datetime.combine(end_day, dt.time(), tzinfo=start.tzinfo)
        if end is None or end < start:
            end = start
        event.update(all_day=False, start=iso(start), end=iso(end))
    if "RRULE" in props:
        rule = _rule(props["RRULE"][1], tz)
        if rule:
            event["repeat"] = rule
    return event


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def _esc(text: str) -> str:
    return (text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n"))


def _fold(line: str) -> str:
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    out, chunk = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(chunk) + len(b) > (75 if not out else 74):
            out.append(chunk.decode("utf-8"))
            chunk = b""
        chunk += b
    out.append(chunk.decode("utf-8"))
    return "\r\n ".join(out)


def _ics_day(day: str) -> str:
    return day.replace("-", "")


def _ics_instant(stamp: str) -> str:
    return dt.datetime.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S").strftime("%Y%m%dT%H%M%SZ")


def export(events: List[Dict[str, Any]], name: str = "pupload") -> str:
    now = dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//pupload//private calendar//EN",
             "CALSCALE:GREGORIAN", f"X-WR-CALNAME:{_esc(name)}"]
    for ev in events:
        lines += ["BEGIN:VEVENT", f"UID:{ev.get('uid') or ev['id'] + '@pupload'}", f"DTSTAMP:{now}"]
        if ev.get("all_day"):
            last = dt.date.fromisoformat(ev["end"]) + dt.timedelta(days=1)
            lines += [f"DTSTART;VALUE=DATE:{_ics_day(ev['start'])}",
                      f"DTEND;VALUE=DATE:{last.strftime('%Y%m%d')}"]
        else:
            lines += [f"DTSTART:{_ics_instant(ev['start'])}", f"DTEND:{_ics_instant(ev['end'])}"]
        lines.append(f"SUMMARY:{_esc(ev.get('title') or '')}")
        if ev.get("location"):
            lines.append(f"LOCATION:{_esc(ev['location'])}")
        if ev.get("notes"):
            lines.append(f"DESCRIPTION:{_esc(ev['notes'])}")
        rule = ev.get("repeat")
        if rule:
            parts = [f"FREQ={rule['freq'].upper()}"]
            if rule.get("interval", 1) > 1:
                parts.append(f"INTERVAL={rule['interval']}")
            if rule.get("byday"):
                parts.append("BYDAY=" + ",".join(WEEKDAYS[d] for d in rule["byday"]))
            if rule.get("count"):
                parts.append(f"COUNT={rule['count']}")
            elif rule.get("until"):
                until = rule["until"]
                parts.append("UNTIL=" + (_ics_day(until) if len(until) == 10 else _ics_instant(until)))
            lines.append("RRULE:" + ";".join(parts))
        for minutes in ev.get("alerts") or []:
            lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_esc(ev.get('title') or 'Reminder')}",
                      f"TRIGGER:-PT{int(minutes)}M", "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
