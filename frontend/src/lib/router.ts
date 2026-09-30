import { useEffect, useState } from "react";

/** Hash routes: #/files/<path>, #/links, #/bin, #/recent, #/media, #/expiring, #/mine,
 *  and the private space: #/notes/<id>, #/memos, #/lists/<id>, #/calendar */
export type View =
  | "files"
  | "links"
  | "bin"
  | "recent"
  | "media"
  | "expiring"
  | "mine"
  | "notes"
  | "memos"
  | "lists"
  | "calendar";
export interface Route {
  view: View;
  /** A folder path for files; the open note or list for notes and lists. */
  path: string;
}

const VIEWS: View[] = ["files", "links", "bin", "recent", "media", "expiring", "mine", "notes", "memos", "lists", "calendar"];
export const PRIVATE_VIEWS: View[] = ["notes", "memos", "lists", "calendar"];
const WITH_ID: View[] = ["notes", "lists"];

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [head, ...rest] = raw.split("/");
  const view = (VIEWS as string[]).includes(head) ? (head as View) : "files";
  let path = "";
  if (view === "files") path = rest.map(safeDecode).filter(Boolean).join("/");
  else if (WITH_ID.includes(view)) path = safeDecode(rest[0] ?? "");
  return { view, path };
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function hrefFor(view: View, path = ""): string {
  if (WITH_ID.includes(view)) return path ? `#/${view}/${encodeURIComponent(path)}` : `#/${view}`;
  if (view !== "files") return `#/${view}`;
  return path ? `#/files/${path.split("/").map(encodeURIComponent).join("/")}` : "#/files";
}

export function navigate(view: View, path = "", replace = false) {
  const next = hrefFor(view, path);
  if (location.hash === next) return;
  if (replace) {
    history.replaceState(null, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** A file to open once its folder has loaded (from a reference in a note). */
let pendingOpen: string | null = null;

export function openFileAt(path: string) {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  pendingOpen = path;
  navigate("files", parent);
}

export function takePendingOpen(folder: string): string | null {
  if (!pendingOpen) return null;
  const parent = pendingOpen.includes("/") ? pendingOpen.slice(0, pendingOpen.lastIndexOf("/")) : "";
  if (parent !== folder) return null;
  const path = pendingOpen;
  pendingOpen = null;
  return path;
}
