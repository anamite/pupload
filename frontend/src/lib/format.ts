export function fmtSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function fmtWhen(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return fmtDate(ts);
}

export function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtLeft(expires: number | null): { text: string; warn: boolean } | null {
  if (!expires) return null;
  const secs = expires - Date.now() / 1000;
  if (secs <= 0) return { text: "expiring", warn: true };
  const days = Math.floor(secs / 86400);
  if (days >= 2) return { text: `${days}d left`, warn: days <= 3 };
  const hours = Math.max(1, Math.floor(secs / 3600));
  return { text: `${hours}h left`, warn: true };
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, "") || u.protocol.replace(":", "");
  } catch {
    return url;
  }
}
