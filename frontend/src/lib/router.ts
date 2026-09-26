import { useEffect, useState } from "react";

/** Hash routes: #/files/<path>, #/links, #/bin, #/recent, #/media, #/expiring, #/mine */
export type View = "files" | "links" | "bin" | "recent" | "media" | "expiring" | "mine";
export interface Route {
  view: View;
  path: string;
}

const VIEWS: View[] = ["files", "links", "bin", "recent", "media", "expiring", "mine"];

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [head, ...rest] = raw.split("/");
  const view = (VIEWS as string[]).includes(head) ? (head as View) : "files";
  const path = view === "files" ? rest.map(safeDecode).filter(Boolean).join("/") : "";
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
  if (view !== "files") return `#/${view}`;
  return path ? `#/files/${path.split("/").map(encodeURIComponent).join("/")}` : "#/files";
}

export function navigate(view: View, path = "") {
  const next = hrefFor(view, path);
  if (location.hash !== next) location.hash = next;
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
