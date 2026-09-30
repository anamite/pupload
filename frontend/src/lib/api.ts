import { deviceHeaders } from "./device";

export type Kind = "folder" | "image" | "video" | "audio" | "pdf" | "doc" | "text" | "archive" | "file";
export type Theme = "system" | "light" | "slate" | "ink";
export type Sort = "name" | "new" | "old" | "size" | "expiry";
export type Layout = "grid" | "list";

export interface Item {
  name: string;
  path: string;
  parent: string;
  is_dir: boolean;
  kind: Kind;
  mime: string;
  size: number;
  modified: number;
  created: number;
  pinned: boolean;
  expires: number | null;
  downloads: number;
  device_id: string;
  device_name: string;
  device_ip: string;
  children?: number;
  /** Inside a secure folder (or is one): encrypted on disk. */
  secure?: boolean;
  /** The top folder of a secure folder. */
  vault?: boolean;
  /** A secure folder this device has not unlocked. */
  locked?: boolean;
}

export interface FolderInfo {
  secure: boolean;
  vault: boolean;
}

export interface VaultStatus {
  available: boolean;
  configured: boolean;
  unlocked: boolean;
  expires: number | null;
  hours: number;
  /** Signed in remotely with the basic password: secure folders don't exist here. */
  hidden?: boolean;
}

export type Tier = "basic" | "full";

/** Which door this page came in by. On the home network: `{ remote: false }`. */
export interface AuthStatus {
  remote: boolean;
  configured?: boolean;
  signed_in?: boolean;
  tier?: Tier | null;
  expires?: number | null;
}

export interface RemoteSession {
  tier: Tier;
  created: number;
  expires: number;
  seen: number;
  device: string;
  ip: string;
}

/** Remote access as seen from the home network. */
export interface RemoteStatus {
  configured: boolean;
  port: number | null;
  host: string | null;
  error: string;
  days: number;
  hours: number;
  min_password: number;
  created?: number | null;
  full_ok?: boolean;
  sessions?: RemoteSession[];
}

export interface Stats {
  used: number;
  trash_bytes: number;
  files: number;
  folders: number;
  quota: number | null;
  limit: number;
  available: number;
  disk_total: number;
  disk_free: number;
  root: string;
  expiry_days: number;
  expiry_mode: "created" | "accessed";
  trash_days: number;
}

export interface Settings {
  app_name: string;
  storage_root: string;
  quota_bytes: number | null;
  expiry_days: number;
  expiry_mode: "created" | "accessed";
  trash_days: number;
  theme: Theme;
  view: Layout;
  sort: Sort;
  confirm_delete: boolean;
  show_hidden: boolean;
  thumbnails: boolean;
  keep_free_bytes: number;
  vault_hours: number;
  remote_days: number;
}

export interface StorageOption {
  path: string;
  label: string;
  mount: string;
  total: number;
  free: number;
  writable: boolean;
  current: boolean;
  exists: boolean;
}

export interface Link {
  id: number;
  url: string;
  title: string;
  note: string;
  tags: string[];
  pinned: boolean;
  created_at: number;
  updated_at: number;
  device_id: string;
  device_name: string;
  device_ip: string;
}

export interface TrashItem {
  id: string;
  kind: "file" | "folder" | "link" | PrivateKind;
  name: string;
  original: string;
  size: number;
  items: number;
  deleted_at: number;
  deleted_by: string;
  purge_at: number | null;
  file_kind: Kind | "link" | PrivateKind;
  url: string | null;
  secure?: boolean;
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// The private space: only where secure folders are unlocked.
// Dates: "2026-10-01" is a whole day in the viewer's zone; anything with a
// time is a UTC instant ("2026-10-01T10:30:00Z").
// ---------------------------------------------------------------------------

export type PrivateKind = "note" | "list" | "event" | "memo";
export type Tint = "" | "red" | "orange" | "amber" | "green" | "teal" | "blue" | "violet" | "pink";

export interface Note {
  id: string;
  title: string;
  /** The title follows the note's first two words until it is edited. */
  title_auto: boolean;
  body: string;
  pinned: boolean;
  color: Tint;
  created: number;
  updated: number;
}

export interface ListItem {
  id: string;
  text: string;
  done: boolean;
  due: string | null;
  note: string;
  created: number;
  done_at: number | null;
}

export interface TodoList {
  id: string;
  name: string;
  items: ListItem[];
  pinned: boolean;
  color: Tint;
  created: number;
  updated: number;
}

export type Freq = "daily" | "weekly" | "monthly" | "yearly";

export interface Repeat {
  freq: Freq;
  interval: number;
  count?: number;
  until?: string;
  /** Weekly only: days of the week, 0 = Sunday. */
  byday?: number[];
}

export interface CalEvent {
  id: string;
  title: string;
  notes: string;
  location: string;
  all_day: boolean;
  start: string;
  /** Inclusive: the last day of an all-day event. */
  end: string;
  /** Minutes before the start. */
  alerts: number[];
  repeat: Repeat | null;
  color: Tint;
  source: string;
  uid: string;
  created: number;
  updated: number;
}

export interface Memo {
  id: string;
  title: string;
  note: string;
  pinned: boolean;
  mime: string;
  size: number;
  duration: number;
  created: number;
  updated: number;
}

export interface PrivateData {
  note: Note[];
  list: TodoList[];
  event: CalEvent[];
  memo: Memo[];
}

export interface FolderNode {
  path: string;
  name: string;
  depth: number;
  secure?: boolean;
  locked?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
  /** A secure folder this device has not unlocked. */
  get locked() {
    return this.status === 423;
  }
}

/** Fired when the remote port says the sign-in is gone (expired, or signed out elsewhere). */
export const SIGNED_OUT = "pupload:signed-out";

export const isLocked = (err: unknown) => err instanceof ApiError && err.locked;

export async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: body === undefined ? "GET" : "POST", headers: deviceHeaders() };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Cannot reach the server");
  }
  let data: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`Server error (${res.status})`, res.status);
  }
  if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!res.ok || !data.ok) throw new ApiError(data.error || "Request failed", res.status);
  return data as T;
}

export const fileUrl = (kind: "raw" | "download" | "thumb" | "zip", path: string) =>
  `/api/${kind}?path=${encodeURIComponent(path)}`;

export const zipUrl = (paths: string[]) =>
  `/api/zip?${paths.map((p) => `paths=${encodeURIComponent(p)}`).join("&")}`;

/** Start a browser download without leaving the page. */
export function startDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Clipboard API needs HTTPS; fall back to execCommand on a plain-http LAN. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export const SAFE_LINK = /^(https?|ftp|sftp|smb|magnet|mailto|tel):/i;
