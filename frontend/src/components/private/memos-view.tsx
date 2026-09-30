import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileAudio, Loader2, Mic, MoreVertical, Pause, Pencil, Play, Search, Smartphone, Square, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { useDialogs } from "@/components/dialogs";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useVaultUi } from "@/components/vault/vault";
import { ApiError, startDownload, type Memo } from "@/lib/api";
import { fmtDayShort } from "@/lib/dates";
import { deviceHeaders } from "@/lib/device";
import { fmtSize, fmtTime } from "@/lib/format";
import { deletePrivate, savePrivate } from "@/lib/private";
import { absorbStats, keys, usePrivate } from "@/lib/queries";
import type { PrivateData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PrivateEyebrow } from "./common";

const MIMES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
const canRecord = () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
const audioUrl = (id: string, download = false) => `/api/private/memo/audio?id=${encodeURIComponent(id)}${download ? "&download=1" : ""}`;

async function uploadMemo(blob: Blob, duration: number, title = ""): Promise<{ item: Memo }> {
  const params = new URLSearchParams({ duration: String(Math.round(duration * 10) / 10) });
  if (title) params.set("title", title);
  let res: Response;
  try {
    res = await fetch(`/api/private/memo?${params}`, {
      method: "POST",
      body: blob,
      headers: { ...deviceHeaders(), "Content-Type": blob.type || "audio/webm" },
    });
  } catch {
    throw new ApiError("Cannot reach the server");
  }
  const data = await res.json().catch(() => ({ ok: false, error: `Server error (${res.status})` }));
  if (!res.ok || !data.ok) throw new ApiError(data.error || "Upload failed", res.status);
  return data;
}

function audioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const el = new Audio();
    const url = URL.createObjectURL(file);
    const done = (v: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) ? v : 0);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(0);
    el.src = url;
  });
}

export function MemosView() {
  const qc = useQueryClient();
  const vault = useVaultUi();
  const dialogs = useDialogs();
  const { query, settings } = useApp();
  const { data, isLoading } = usePrivate(true);
  const memos = [...(data?.memo ?? [])].sort((a, b) => b.created - a.created);
  const needle = query.trim().toLowerCase();
  const shown = memos.filter((m) => !needle || m.title.toLowerCase().includes(needle) || m.note.toLowerCase().includes(needle));
  const [busy, setBusy] = React.useState(false);
  const player = usePlayback();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const captureInput = React.useRef<HTMLInputElement>(null);

  const store = async (blob: Blob, duration: number, title = "") => {
    setBusy(true);
    try {
      const res = await uploadMemo(blob, duration, title);
      absorbStats(qc, res);
      qc.setQueryData<PrivateData>(keys.private, (old) => (old ? { ...old, memo: [res.item, ...old.memo] } : old));
      toast.success("Voice memo saved");
    } catch (err) {
      if (!vault.handle(err)) toast.error((err as Error).message);
    }
    setBusy(false);
  };

  const importFiles = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      if (!file.type.startsWith("audio/") && !/\.(m4a|mp3|wav|ogg|opus|webm|aac|amr|3gp|flac)$/i.test(file.name)) {
        toast.error(`${file.name} is not an audio file`);
        continue;
      }
      await store(file, await audioDuration(file), file.name.replace(/\.[^.]+$/, ""));
    }
  };

  const rename = async (memo: Memo) => {
    const title = await dialogs.prompt({ title: "Rename voice memo", label: "Title", initial: memo.title, confirmLabel: "Rename" });
    if (title && title !== memo.title) savePrivate(qc, "memo", { ...memo, title }).catch((e) => toast.error(e.message));
  };

  const remove = async (memo: Memo) => {
    if (settings.confirm_delete) {
      const yes = await dialogs.confirm({ title: "Move voice memo to recycle bin?", message: memo.title, confirmLabel: "Move to bin", destructive: true });
      if (!yes) return;
    }
    if (player.id === memo.id) player.stop();
    deletePrivate(qc, "memo", [memo.id]);
  };

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={<PrivateEyebrow icon={Mic} text="Recorded here, encrypted on the Pi" />}
        title="Voice memos"
        count={isLoading ? undefined : memos.length}
      />
      <div className="grid gap-5 px-4 pb-6 sm:px-6 lg:px-8">
        <Recorder busy={busy} onDone={store} onPhone={() => captureInput.current?.click()} onImport={() => fileInput.current?.click()} />
        <input ref={fileInput} type="file" accept="audio/*" multiple hidden onChange={(e) => (importFiles(e.target.files), (e.target.value = ""))} />
        <input ref={captureInput} type="file" accept="audio/*" capture hidden onChange={(e) => (importFiles(e.target.files), (e.target.value = ""))} />

        {isLoading ? (
          <div className="grid gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          memos.length === 0 ? null : <EmptyState icon={Search} title="No matching memos" text="Try another word." />
        ) : (
          <ul className="grid gap-2">
            {shown.map((memo, i) => (
              <MemoRow key={memo.id} memo={memo} index={i} player={player} onRename={() => rename(memo)} onDelete={() => remove(memo)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

type RecState = { phase: "idle" } | { phase: "asking" } | { phase: "recording"; started: number };

function Recorder({
  busy,
  onDone,
  onPhone,
  onImport,
}: {
  busy: boolean;
  onDone: (blob: Blob, duration: number) => void;
  onPhone: () => void;
  onImport: () => void;
}) {
  const [state, setState] = React.useState<RecState>({ phase: "idle" });
  const [elapsed, setElapsed] = React.useState(0);
  const [levels, setLevels] = React.useState<number[]>(() => Array(48).fill(0));
  const rec = React.useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; chunks: Blob[]; keep: boolean; frame: number } | null>(null);
  const supported = canRecord();

  const cleanup = () => {
    const r = rec.current;
    if (!r) return;
    cancelAnimationFrame(r.frame);
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx.close().catch(() => undefined);
  };
  React.useEffect(
    () => () => {
      if (rec.current) {
        rec.current.keep = false;
        if (rec.current.recorder.state !== "inactive") rec.current.recorder.stop();
        cleanup();
      }
    },
    [],
  );

  const start = async () => {
    setState({ phase: "asking" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setState({ phase: "idle" });
      toast.error("No microphone", { description: (err as Error).name === "NotAllowedError" ? "Allow the microphone for this site, then try again." : (err as Error).message });
      return;
    }
    const mimeType = MIMES.find((m) => MediaRecorder.isTypeSupported?.(m));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const started = performance.now();
    const r = { recorder, stream, ctx, chunks: [] as Blob[], keep: true, frame: 0 };
    rec.current = r;
    let lastBar = 0;
    const tick = (now: number) => {
      setElapsed((now - started) / 1000);
      if (now - lastBar > 70) {
        lastBar = now;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        setLevels((l) => [...l.slice(1), level]);
      }
      r.frame = requestAnimationFrame(tick);
    };
    r.frame = requestAnimationFrame(tick);
    recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    recorder.onstop = () => {
      cleanup();
      const duration = (performance.now() - started) / 1000;
      rec.current = null;
      setState({ phase: "idle" });
      setLevels(Array(48).fill(0));
      if (r.keep && r.chunks.length) onDone(new Blob(r.chunks, { type: recorder.mimeType || mimeType || "audio/webm" }), duration);
    };
    recorder.start(1000);
    setState({ phase: "recording", started });
  };

  const stop = (keep: boolean) => {
    const r = rec.current;
    if (!r) return;
    r.keep = keep;
    r.recorder.stop();
  };

  const recording = state.phase === "recording";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card p-4 shadow-xs transition-colors sm:p-5",
        recording && "border-primary/50 shadow-[0_0_0_1px_var(--primary)]",
      )}
    >
      <div className="flex items-center gap-4">
        {supported ? (
          <button
            onClick={() => (recording ? stop(true) : start())}
            disabled={busy || state.phase === "asking"}
            aria-label={recording ? "Stop and save" : "Record"}
            className={cn(
              "relative flex size-16 shrink-0 items-center justify-center rounded-full transition-all active:scale-95 disabled:opacity-60",
              recording ? "bg-destructive text-white" : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {recording && <span className="absolute inset-0 animate-ping rounded-full bg-destructive/30" />}
            {busy || state.phase === "asking" ? (
              <Loader2 className="size-6 animate-spin" />
            ) : recording ? (
              <Square className="size-5 fill-current" />
            ) : (
              <Mic className="size-7" />
            )}
          </button>
        ) : (
          <div className="flex size-16 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {busy ? <Loader2 className="size-6 animate-spin" /> : <Mic className="size-7" />}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {recording ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="size-2 animate-pulse rounded-full bg-destructive" />
                <span className="font-mono text-2xl font-semibold tabular">{fmtTime(elapsed)}</span>
                <span className="text-sm text-muted-foreground">Recording… tap to stop and save</span>
              </div>
              <div className="mt-2 flex h-8 items-center gap-[3px]" aria-hidden>
                {levels.map((l, i) => (
                  <span key={i} className="w-full rounded-full bg-primary/70" style={{ height: `${Math.max(8, l * 100)}%` }} />
                ))}
              </div>
            </>
          ) : supported ? (
            <>
              <div className="font-display text-lg font-semibold">{busy ? "Saving…" : "Tap to record"}</div>
              <p className="text-sm text-muted-foreground">Saved to the Pi, encrypted, when you stop.</p>
            </>
          ) : (
            <>
              <div className="font-display text-lg font-semibold">Record with your phone's recorder</div>
              <p className="text-sm text-muted-foreground">
                Browsers only allow the microphone over HTTPS (the Tailscale address or remote access). Here, use your phone's
                recorder or add an audio file.
              </p>
            </>
          )}
        </div>
        {recording && (
          <Button variant="ghost" size="icon" aria-label="Discard recording" title="Discard" onClick={() => stop(false)}>
            <X />
          </Button>
        )}
      </div>
      {!recording && (
        <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={onPhone} disabled={busy} className="sm:hidden">
            <Smartphone /> Phone recorder
          </Button>
          <Button variant="outline" size="sm" onClick={onImport} disabled={busy}>
            <FileAudio /> Add audio files
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playback: one memo at a time
// ---------------------------------------------------------------------------

interface Playback {
  id: string | null;
  playing: boolean;
  position: number;
  duration: number;
  toggle: (memo: Memo) => void;
  seek: (t: number) => void;
  stop: () => void;
}

function usePlayback(): Playback {
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const [id, setId] = React.useState<string | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [position, setPosition] = React.useState(0);
  const [duration, setDuration] = React.useState(0);

  React.useEffect(() => {
    const el = new Audio();
    el.preload = "metadata";
    audio.current = el;
    const on = () => {
      setPlaying(!el.paused);
      setPosition(el.currentTime);
      if (Number.isFinite(el.duration)) setDuration(el.duration);
    };
    const events = ["play", "pause", "timeupdate", "loadedmetadata", "durationchange", "ended"];
    events.forEach((e) => el.addEventListener(e, on));
    el.addEventListener("error", () => el.src && toast.error("Could not play this memo"));
    return () => {
      events.forEach((e) => el.removeEventListener(e, on));
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, []);

  return {
    id,
    playing,
    position,
    duration,
    toggle(memo) {
      const el = audio.current;
      if (!el) return;
      if (id !== memo.id) {
        el.src = audioUrl(memo.id);
        setId(memo.id);
        setPosition(0);
        setDuration(memo.duration);
        el.play().catch(() => undefined);
      } else if (el.paused) el.play().catch(() => undefined);
      else el.pause();
    },
    seek(t) {
      if (audio.current) audio.current.currentTime = t;
    },
    stop() {
      audio.current?.pause();
      setId(null);
    },
  };
}

function MemoRow({
  memo,
  index,
  player,
  onRename,
  onDelete,
}: {
  memo: Memo;
  index: number;
  player: Playback;
  onRename: () => void;
  onDelete: () => void;
}) {
  const active = player.id === memo.id;
  const length = active && player.duration ? player.duration : memo.duration;
  const created = new Date(memo.created * 1000);
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
      className={cn(
        "group flex animate-rise items-center gap-3 rounded-xl border bg-card p-2.5 pr-1.5 transition-[border-color,box-shadow] sm:p-3",
        active && "border-primary/40",
      )}
    >
      <button
        onClick={() => player.toggle(memo)}
        aria-label={active && player.playing ? "Pause" : "Play"}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-full transition-colors",
          active ? "bg-primary text-primary-foreground" : "bg-primary/12 text-primary hover:bg-primary/20",
        )}
      >
        {active && player.playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{memo.title}</div>
        {active ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={length || 0}
              step={0.1}
              value={Math.min(player.position, length || 0)}
              onChange={(e) => player.seek(Number(e.target.value))}
              aria-label="Position"
              className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--primary)]"
            />
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular">
              {fmtTime(player.position)} / {fmtTime(length)}
            </span>
          </div>
        ) : (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>
              {fmtDayShort(created)}, {created.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="font-mono tabular">{fmtTime(memo.duration)}</span>
            <span>{fmtSize(memo.size)}</span>
          </div>
        )}
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="Memo actions">
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => startDownload(audioUrl(memo.id, true))}>
            <Download /> Download
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 /> Move to recycle bin
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
