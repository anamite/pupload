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
  kind: "file" | "folder" | "link";
  name: string;
  original: string;
  size: number;
  items: number;
  deleted_at: number;
  deleted_by: string;
  purge_at: number | null;
  file_kind: Kind | "link";
  url: string | null;
  secure?: boolean;
  locked?: boolean;
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
