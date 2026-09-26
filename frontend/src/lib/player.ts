import { useSyncExternalStore } from "react";
import { fileUrl, type Item } from "./api";

/** One shared <audio> element so music keeps playing while you browse. */
const audio = new Audio();
audio.preload = "metadata";

interface PlayerState {
  queue: Item[];
  index: number;
  playing: boolean;
  time: number;
  duration: number;
}

let state: PlayerState = { queue: [], index: -1, playing: false, time: 0, duration: 0 };
const listeners = new Set<() => void>();

function set(fields: Partial<PlayerState>) {
  state = { ...state, ...fields };
  listeners.forEach((l) => l());
}

function start(index: number) {
  const track = state.queue[index];
  if (!track) return;
  set({ index, time: 0, duration: 0 });
  audio.src = fileUrl("raw", track.path);
  audio.play().catch(() => set({ playing: false }));
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: "pupload" });
  }
}

let lastTick = 0;
audio.addEventListener("play", () => set({ playing: true }));
audio.addEventListener("pause", () => set({ playing: false }));
audio.addEventListener("loadedmetadata", () => set({ duration: audio.duration }));
audio.addEventListener("timeupdate", () => {
  const now = performance.now();
  if (now - lastTick < 250) return;
  lastTick = now;
  set({ time: audio.currentTime });
});
audio.addEventListener("ended", () => player.step(1));

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("nexttrack", () => player.step(1));
  navigator.mediaSession.setActionHandler("previoustrack", () => player.step(-1));
}

export const player = {
  play(item: Item, siblings: Item[]) {
    const queue = siblings.filter((i) => i.kind === "audio");
    let index = queue.findIndex((i) => i.path === item.path);
    if (index < 0) {
      queue.splice(0, queue.length, item);
      index = 0;
    }
    set({ queue });
    start(index);
  },
  toggle() {
    if (audio.paused) audio.play().catch(() => undefined);
    else audio.pause();
  },
  step(delta: number) {
    if (!state.queue.length) return;
    if (delta < 0 && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    start((state.index + delta + state.queue.length) % state.queue.length);
  },
  seek(seconds: number) {
    if (Number.isFinite(audio.duration)) audio.currentTime = seconds;
    set({ time: seconds });
  },
  stop() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    set({ queue: [], index: -1, playing: false, time: 0, duration: 0 });
  },
};

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePlayer(): PlayerState & { track: Item | null } {
  const s = useSyncExternalStore(subscribe, () => state);
  return { ...s, track: s.queue[s.index] ?? null };
}
