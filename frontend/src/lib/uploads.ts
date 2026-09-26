import { useSyncExternalStore } from "react";
import { deviceHeaders } from "./device";

/**
 * Upload queue kept outside React so progress ticks only re-render the
 * upload panel, not the file grid. Each file is streamed as a raw request
 * body, which the Pi writes straight to disk.
 */
export interface UploadJob {
  id: number;
  file: File;
  dir: string;
  target: string;
  loaded: number;
  status: "queued" | "uploading" | "done" | "error" | "canceled";
  error?: string;
  xhr?: XMLHttpRequest;
}

export interface DroppedFile {
  file: File;
  dir: string;
}

const MAX_PARALLEL = 3;
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

function patch(id: number, fields: Partial<UploadJob>) {
  const job = jobs.find((j) => j.id === id);
  if (job) Object.assign(job, fields);
  emit();
}

function active() {
  return jobs.filter((j) => j.status === "uploading").length;
}

function pump() {
  while (active() < MAX_PARALLEL) {
    const next = jobs.find((j) => j.status === "queued");
    if (!next) break;
    send(next);
  }
  if (!jobs.some((j) => j.status === "queued" || j.status === "uploading")) {
    const ok = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "error").length;
    finishedListeners.forEach((l) => l(ok, failed));
  }
}

function send(job: UploadJob) {
  const url =
    `/api/upload?path=${encodeURIComponent(job.target)}&name=${encodeURIComponent(job.file.name)}` +
    (job.dir ? `&dir=${encodeURIComponent(job.dir)}` : "");
  const xhr = new XMLHttpRequest();
  job.status = "uploading";
  job.xhr = xhr;
  xhr.open("POST", url, true);
  Object.entries(deviceHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) patch(job.id, { loaded: ev.loaded });
  };
  xhr.onload = () => {
    let data: { ok?: boolean; error?: string } = {};
    try {
      data = JSON.parse(xhr.responseText);
    } catch {
      /* not JSON */
    }
    if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
      patch(job.id, { status: "done", loaded: job.file.size, xhr: undefined });
    } else {
      patch(job.id, { status: "error", error: data.error || `Failed (${xhr.status})`, xhr: undefined });
    }
    pump();
  };
  xhr.onerror = () => {
    patch(job.id, { status: "error", error: "Connection lost", xhr: undefined });
    pump();
  };
  xhr.onabort = () => {
    patch(job.id, { status: "canceled", xhr: undefined });
    pump();
  };
  xhr.send(job.file);
  emit();
}

export const uploads = {
  enqueue(files: DroppedFile[], target: string) {
    for (const { file, dir } of files) {
      jobs.push({ id: ++seq, file, dir, target, loaded: 0, status: "queued" });
    }
    emit();
    pump();
  },
  cancel(id: number) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.xhr) job.xhr.abort();
    else if (job.status === "queued") patch(id, { status: "canceled" });
  },
  cancelAll() {
    jobs.forEach((j) => {
      if (j.status === "queued") j.status = "canceled";
      j.xhr?.abort();
    });
    emit();
  },
  retry(id: number) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    patch(id, { status: "queued", loaded: 0, error: undefined });
    pump();
  },
  clearFinished() {
    jobs = jobs.filter((j) => j.status === "queued" || j.status === "uploading");
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
