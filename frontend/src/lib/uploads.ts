import { useSyncExternalStore } from "react";
import { deviceHeaders, deviceId } from "./device";

/**
 * Upload queue kept outside React so progress ticks only re-render the
 * upload panel, not the file grid.
 *
 * Files go up in 8 MB pieces to /api/upload/chunk. If the connection drops
 * (Wi-Fi blip, phone locked, Pi restarted) the piece is retried with backoff,
 * and the upload continues from whatever the server already has — nothing is
 * sent twice. The upload id is derived from the file itself, so even after a
 * page reload, adding the same file again resumes it. The file only appears
 * in its folder once every byte has arrived.
 */
export interface UploadJob {
  id: number;
  uid: string;
  file: File;
  dir: string;
  target: string;
  /** Bytes confirmed by the server plus progress of the piece in flight. */
  loaded: number;
  status: "queued" | "uploading" | "waiting" | "done" | "error" | "canceled";
  error?: string;
  note?: string;
  resumed?: boolean;
  xhr?: XMLHttpRequest;
}

export interface DroppedFile {
  file: File;
  dir: string;
}

const MAX_PARALLEL = 3;
const CHUNK = 8 * 1024 * 1024;
const BACKOFF = [1, 2, 4, 8, 15, 30]; // seconds; the last value repeats
const MAX_ATTEMPTS = 25; // roughly ten minutes of trying before asking the user

let jobs: UploadJob[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const finishedListeners = new Set<(ok: number, failed: number) => void>();
let frame = 0;

function emit() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    jobs = [...jobs];
    listeners.forEach((l) => l());
  });
}

function patch(job: UploadJob, fields: Partial<UploadJob>) {
  Object.assign(job, fields);
  emit();
}

/** Read fresh each time: cancel() can change the status while a request is awaited. */
const statusOf = (j: UploadJob): UploadJob["status"] => j.status;
const isPending = (j: UploadJob) => j.status === "queued" || j.status === "uploading" || j.status === "waiting";

/* ------------------------------------------------------------- upload id */

function hash32(text: string, seed: number): string {
  let h = seed ^ 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Same file + same destination + same device → same id, so it can resume. */
function uploadId(file: File, target: string, dir: string): string {
  const key = [deviceId(), target, dir, file.name, file.size, file.lastModified].join("\u0000");
  return [1, 2, 3, 4].map((seed) => hash32(key, seed * 0x9e3779b1)).join("");
}

/* ---------------------------------------------------------------- network */

type ChunkResult =
  | { kind: "ok"; offset: number; done: boolean }
  | { kind: "resync"; offset: number }
  | { kind: "retry"; message: string }
  | { kind: "fatal"; message: string }
  | { kind: "aborted" };

function sendChunk(job: UploadJob, start: number, end: number): Promise<ChunkResult> {
  return new Promise((resolve) => {
    const q = new URLSearchParams({
      id: job.uid,
      path: job.target,
      name: job.file.name,
      size: String(job.file.size),
      offset: String(start),
    });
    if (job.dir) q.set("dir", job.dir);
    const xhr = new XMLHttpRequest();
    job.xhr = xhr;
    xhr.open("POST", `/api/upload/chunk?${q}`, true);
    Object.entries(deviceHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (ev) => patch(job, { loaded: start + ev.loaded });
    xhr.onload = () => {
      job.xhr = undefined;
      let data: { ok?: boolean; error?: string; offset?: number; done?: boolean } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON (proxy error page etc.) */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
        resolve({ kind: "ok", offset: data.offset ?? end, done: !!data.done });
      } else if ((xhr.status === 409 || xhr.status === 408) && typeof data.offset === "number") {
        resolve({ kind: "resync", offset: data.offset });
      } else if (xhr.status >= 500 || xhr.status === 0 || xhr.status === 408 || xhr.status === 429) {
        resolve({ kind: "retry", message: data.error || `Server error (${xhr.status})` });
      } else {
        resolve({ kind: "fatal", message: data.error || `Failed (${xhr.status})` });
      }
    };
    xhr.onerror = () => {
      job.xhr = undefined;
      resolve({ kind: "retry", message: "Connection lost" });
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      job.xhr = undefined;
      resolve({ kind: "aborted" });
    };
    xhr.send(job.file.slice(start, end));
  });
}

async function serverOffset(uid: string): Promise<number | null> {
  try {
    const res = await fetch(`/api/upload/status?id=${uid}`, { headers: deviceHeaders(), cache: "no-store" });
    const data = await res.json();
    return res.ok && data.ok ? Number(data.offset) || 0 : null;
  } catch {
    return null;
  }
}

function waitOnline(): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("online", () => resolve(), { once: true }));
}

function sleep(job: UploadJob, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    let left = seconds;
    patch(job, { note: `Connection lost — retrying in ${left}s` });
    const tick = setInterval(() => {
      left -= 1;
      if (statusOf(job) !== "waiting" || left <= 0) {
        clearInterval(tick);
        resolve();
      } else patch(job, { note: `Connection lost — retrying in ${left}s` });
    }, 1000);
  });
}

async function run(job: UploadJob) {
  patch(job, { status: "uploading", error: undefined, note: undefined });
  let attempts = 0;
  let offset = (await serverOffset(job.uid)) ?? 0;
  if (offset > 0) patch(job, { resumed: true, loaded: offset });

  for (;;) {
    if (statusOf(job) === "canceled") return;
    const end = Math.min(offset + CHUNK, job.file.size);
    const result = await sendChunk(job, offset, end);
    if (statusOf(job) === "canceled" || result.kind === "aborted") return;

    if (result.kind === "ok") {
      attempts = 0;
      offset = result.offset;
      patch(job, { status: "uploading", note: undefined, loaded: offset });
      if (result.done) {
        patch(job, { status: "done", loaded: job.file.size });
        return;
      }
      continue;
    }
    if (result.kind === "resync") {
      offset = result.offset;
      patch(job, { status: "uploading", loaded: offset });
      continue;
    }
    if (result.kind === "fatal") {
      patch(job, { status: "error", error: result.message, note: undefined });
      return;
    }

    // Network trouble: wait (for the network to come back, then with backoff) and resume.
    attempts += 1;
    if (attempts > MAX_ATTEMPTS) {
      patch(job, { status: "error", error: `${result.message} — tap retry to continue`, note: undefined });
      return;
    }
    patch(job, { status: "waiting" });
    if (!navigator.onLine) {
      patch(job, { note: "Offline — continues when the connection is back" });
      await waitOnline();
    } else {
      await sleep(job, BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)]);
    }
    if (statusOf(job) !== "waiting") return; // canceled while waiting
    patch(job, { status: "uploading", note: "Resuming…" });
    const fresh = await serverOffset(job.uid);
    if (fresh !== null) offset = fresh;
  }
}

/* ------------------------------------------------------------------ queue */

function pump() {
  let running = jobs.filter((j) => j.status === "uploading" || j.status === "waiting").length;
  for (const job of jobs) {
    if (running >= MAX_PARALLEL) break;
    if (job.status !== "queued") continue;
    running += 1;
    job.status = "uploading";
    run(job).finally(pump);
  }
  syncWakeLock();
  if (!jobs.some(isPending)) {
    const ok = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "error").length;
    finishedListeners.forEach((l) => l(ok, failed));
  }
  emit();
}

/* Keep the screen awake while uploading (HTTPS only; ignored elsewhere). */
let wakeLock: { release: () => Promise<void> } | null = null;
async function syncWakeLock() {
  const busy = jobs.some(isPending);
  const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
  try {
    if (busy && !wakeLock && nav.wakeLock && document.visibilityState === "visible") {
      wakeLock = await nav.wakeLock.request("screen");
    } else if (!busy && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  wakeLock = null; // the browser drops it when hidden
  syncWakeLock();
});

// Closing the tab mid-upload asks first. (If it closes anyway, adding the same
// files again later resumes them.)
window.addEventListener("beforeunload", (e) => {
  if (jobs.some(isPending)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function dropStaged(uid: string) {
  fetch("/api/upload/cancel", {
    method: "POST",
    headers: { ...deviceHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id: uid }),
  }).catch(() => undefined);
}

export const uploads = {
  enqueue(files: DroppedFile[], target: string) {
    for (const { file, dir } of files) {
      const uid = uploadId(file, target, dir);
      if (jobs.some((j) => j.uid === uid && isPending(j))) continue; // already on its way
      jobs.push({ id: ++seq, uid, file, dir, target, loaded: 0, status: "queued" });
    }
    pump();
  },
  cancel(id: number) {
    const job = jobs.find((j) => j.id === id);
    if (!job || !isPending(job)) return;
    job.status = "canceled";
    job.xhr?.abort();
    dropStaged(job.uid);
    pump();
  },
  cancelAll() {
    jobs.filter(isPending).forEach((j) => {
      j.status = "canceled";
      j.xhr?.abort();
      dropStaged(j.uid);
    });
    pump();
  },
  retry(id: number) {
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status !== "error") return;
    patch(job, { status: "queued", error: undefined });
    pump();
  },
  clearFinished() {
    jobs = jobs.filter(isPending);
    emit();
  },
  onFinished(fn: (ok: number, failed: number) => void) {
    finishedListeners.add(fn);
    return () => {
      finishedListeners.delete(fn);
    };
  },
};

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useUploads(): UploadJob[] {
  return useSyncExternalStore(subscribe, () => jobs);
}

/** Walk a dropped directory tree (Chromium, WebKit and Firefox all support entries). */
export async function filesFromDrop(dt: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(dt.items || []);
  const entries = items
    .map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files).map((file) => ({ file, dir: "" }));

  const out: DroppedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((res) => (entry as FileSystemFileEntry).file(res, () => res(null)));
      if (file) out.push({ file, dir: prefix });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const here = prefix ? `${prefix}/${entry.name}` : entry.name;
      const children: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        children.push(...batch);
      }
      await Promise.all(children.map((c) => walk(c, here)));
    }
  };
  await Promise.all(entries.map((e) => walk(e, "")));
  return out;
}

export function filesFromInput(list: FileList | null): DroppedFile[] {
  return Array.from(list || []).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
    return { file, dir: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "" };
  });
}
