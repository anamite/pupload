import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type CalEvent, type Memo, type Note, type PrivateData, type PrivateKind, type Tint, type TodoList } from "./api";
import { absorbStats, keys, refreshAll } from "./queries";

type Doc = { note: Note; list: TodoList; event: CalEvent; memo: Memo };

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function patchCache<K extends PrivateKind>(qc: QueryClient, kind: K, doc: Doc[K] | null, removeId?: string) {
  qc.setQueryData<PrivateData>(keys.private, (old) => {
    if (!old) return old;
    const list = old[kind] as Doc[K][];
    const id = doc?.id ?? removeId;
    const rest = list.filter((d) => d.id !== id);
    return { ...old, [kind]: doc ? [doc, ...rest] : rest };
  });
}

// Saves of one record go out one after another, so quick taps land in order.
const queues = new Map<string, Promise<unknown>>();
const latest = new Map<string, number>();
let serial = 0;

/**
 * Save a record: the cache changes at once, the server's cleaned copy replaces it
 * when it answers (unless a newer save is on its way). On failure the cache is
 * reloaded and the error thrown.
 */
export async function savePrivate<K extends PrivateKind>(qc: QueryClient, kind: K, doc: Doc[K]): Promise<Doc[K]> {
  const mine = ++serial;
  latest.set(doc.id, mine);
  qc.cancelQueries({ queryKey: keys.private });
  patchCache(qc, kind, { ...doc, updated: Date.now() / 1000 });
  const send = async () => {
    const data = await api<{ item: Doc[K] }>("/api/private/save", { kind, item: doc });
    if (latest.get(doc.id) === mine) patchCache(qc, kind, data.item);
    return data.item;
  };
  const run = (queues.get(doc.id) ?? Promise.resolve()).catch(() => undefined).then(send);
  queues.set(doc.id, run);
  try {
    return await run;
  } catch (err) {
    qc.invalidateQueries({ queryKey: keys.private });
    throw err;
  } finally {
    if (queues.get(doc.id) === run) queues.delete(doc.id);
  }
}

const NAMES: Record<PrivateKind, string> = { note: "Note", list: "List", event: "Event", memo: "Voice memo" };

/** Move records to the recycle bin, with an Undo on the toast. */
export async function deletePrivate(qc: QueryClient, kind: PrivateKind, ids: string[], onUndo?: () => void) {
  ids.forEach((id) => patchCache(qc, kind, null, id));
  try {
    const data = await api<{ trash_ids: string[] }>("/api/private/delete", { kind, ids });
    qc.invalidateQueries({ queryKey: keys.trash });
    toast(`${NAMES[kind]} moved to the recycle bin`, {
      action: data.trash_ids.length
        ? {
            label: "Undo",
            onClick: async () => {
              const res = await api("/api/trash/restore", { ids: data.trash_ids });
              absorbStats(qc, res);
              refreshAll(qc);
              qc.invalidateQueries({ queryKey: keys.private });
              onUndo?.();
            },
          }
        : undefined,
    });
  } catch (err) {
    qc.invalidateQueries({ queryKey: keys.private });
    toast.error((err as Error).message);
  }
}

/** Markdown down to plain words, for card previews and search. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, p: string, label?: string) => label || p.split("/").pop() || p)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same rule as the server: a note's first two words. */
export function autoTitle(body: string): string {
  for (const line of body.split("\n")) {
    const words = plainText(line).split(" ").filter(Boolean);
    if (words.length) return words.slice(0, 2).join(" ");
  }
  return "";
}

export const TINTS: { id: Tint; label: string; hue: number }[] = [
  { id: "", label: "Default", hue: 36 },
  { id: "red", label: "Red", hue: 25 },
  { id: "orange", label: "Orange", hue: 50 },
  { id: "amber", label: "Amber", hue: 80 },
  { id: "green", label: "Green", hue: 150 },
  { id: "teal", label: "Teal", hue: 190 },
  { id: "blue", label: "Blue", hue: 250 },
  { id: "violet", label: "Violet", hue: 295 },
  { id: "pink", label: "Pink", hue: 345 },
];

/** Colour for a tint: "" follows the theme's primary colour. */
export function tintColor(tint: Tint, alpha = 1): string {
  if (!tint) return alpha === 1 ? "var(--primary)" : `color-mix(in oklch, var(--primary) ${Math.round(alpha * 100)}%, transparent)`;
  const hue = TINTS.find((t) => t.id === tint)?.hue ?? 36;
  return `oklch(0.64 0.16 ${hue} / ${alpha})`;
}
