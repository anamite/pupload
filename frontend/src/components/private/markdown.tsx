import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Folder } from "lucide-react";
import { KindIcon, kindFromName } from "@/components/file-icon";
import { api, fileUrl, type FolderNode } from "@/lib/api";
import { keys } from "@/lib/queries";
import { navigate, openFileAt } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * Markdown for notes (GitHub flavour: tables, task lists, strikethrough), plus
 * references to things in the drive: [[Photos/2024]] or [[Docs/cv.pdf|my CV]]
 * link a folder or file, and ![[Photos/cat.jpg]] shows an image inline.
 */

const REF = /(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
const SCHEME = "pupload:";

type MdNode = { type: string; value?: string; url?: string; alt?: string; children?: MdNode[] };

/** Turns [[...]] in text (never in code) into links and images with a pupload: address. */
function remarkRefs() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    const out: MdNode[] = [];
    for (const child of node.children) {
      if (child.type !== "text" || !child.value?.includes("[[")) {
        walk(child);
        out.push(child);
        continue;
      }
      const text = child.value;
      let last = 0;
      REF.lastIndex = 0;
      for (let m = REF.exec(text); m; m = REF.exec(text)) {
        if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
        const path = m[2].trim().replace(/^\/+|\/+$/g, "");
        const label = (m[3] ?? "").trim() || path.split("/").pop() || "Home";
        const url = SCHEME + encodeURIComponent(path);
        if (m[1] && kindFromName(path) === "image") out.push({ type: "image", url, alt: label });
        else out.push({ type: "link", url, children: [{ type: "text", value: label }] });
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push({ type: "text", value: text.slice(last) });
    }
    node.children = out;
  };
  return (tree: MdNode) => walk(tree);
}

const urlTransform = (url: string) => (url.startsWith(SCHEME) ? url : defaultUrlTransform(url));

function useFolderSet() {
  const { data } = useQuery({
    queryKey: keys.folders,
    queryFn: async () => (await api<{ folders: FolderNode[] }>("/api/folders")).folders,
    staleTime: 60_000,
  });
  return React.useMemo(() => new Set((data ?? []).map((f) => f.path)), [data]);
}

function refPath(href: string) {
  try {
    return decodeURIComponent(href.slice(SCHEME.length));
  } catch {
    return href.slice(SCHEME.length);
  }
}

export function RefChip({ path, children }: { path: string; children?: React.ReactNode }) {
  const folders = useFolderSet();
  const isFolder = path === "" || folders.has(path);
  const name = path.split("/").pop() || "Home";
  return (
    <a
      href={isFolder ? `#/files/${path.split("/").map(encodeURIComponent).join("/")}` : undefined}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isFolder) navigate("files", path);
        else openFileAt(path);
      }}
      title={path || "Home"}
      className="not-prose inline-flex max-w-full translate-y-[-1px] cursor-pointer items-center gap-1.5 rounded-md border bg-card py-px pr-2 pl-1 align-middle text-[0.9em] font-medium no-underline shadow-xs transition-colors hover:border-primary/40 hover:bg-accent"
    >
      {isFolder ? (
        <span className="inline-flex size-5 items-center justify-center rounded bg-folder/15 text-folder">
          <Folder className="size-3.5" strokeWidth={2} />
        </span>
      ) : (
        <KindIcon kind={kindFromName(name)} className="size-5 rounded" />
      )}
      <span className="truncate">{children ?? name}</span>
    </a>
  );
}

const TaskContext = React.createContext<{ offset: number | null; toggle?: (offset: number) => void }>({ offset: null });
const TASK_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/;

/** Flip `- [ ]` / `- [x]` of the list item starting at `offset`. */
export function toggleTask(md: string, offset: number): string {
  const m = TASK_RE.exec(md.slice(offset));
  if (!m) return md;
  const at = offset + m[0].length - 2;
  return md.slice(0, at) + (m[1] === " " ? "x" : " ") + md.slice(at + 1);
}

function TaskBox({ checked }: { checked: boolean }) {
  const { offset, toggle } = React.useContext(TaskContext);
  const can = !!toggle && offset !== null;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={!can}
      onClick={(e) => {
        e.stopPropagation();
        if (can) toggle!(offset!);
      }}
      className={cn(
        "mr-2 inline-flex size-[1.1em] translate-y-[0.15em] items-center justify-center rounded-[5px] border align-baseline transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card",
        can && "hover:border-primary",
      )}
    >
      {checked && <Check className="size-[0.8em]" strokeWidth={3.2} />}
    </button>
  );
}

export function Markdown({
  source,
  onToggleTask,
  className,
}: {
  source: string;
  /** Lets task-list boxes be ticked in the rendered note. */
  onToggleTask?: (offset: number) => void;
  className?: string;
}) {
  const components = React.useMemo<Components>(
    () => ({
      a({ href, children }) {
        if (href?.startsWith(SCHEME)) return <RefChip path={refPath(href)}>{children}</RefChip>;
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
      img({ src, alt }) {
        if (typeof src === "string" && src.startsWith(SCHEME)) {
          const path = refPath(src);
          return (
            <button type="button" className="my-2 block max-w-full" onClick={() => openFileAt(path)} title={path}>
              <img src={fileUrl("thumb", path)} alt={alt ?? ""} loading="lazy" className="max-h-80 rounded-lg border object-contain" />
            </button>
          );
        }
        return <img src={src as string} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
      },
      li({ node, className: cls, children }) {
        const task = typeof cls === "string" && cls.includes("task-list-item");
        const offset = task ? (node?.position?.start.offset ?? null) : null;
        return (
          <li className={cls}>
            <TaskContext.Provider value={{ offset, toggle: onToggleTask }}>{children}</TaskContext.Provider>
          </li>
        );
      },
      input({ type, checked }) {
        if (type === "checkbox") return <TaskBox checked={!!checked} />;
        return null;
      },
      table({ children }) {
        return (
          <div className="scrollbar-thin overflow-x-auto">
            <table>{children}</table>
          </div>
        );
      },
    }),
    [onToggleTask],
  );

  return (
    <div className={cn("md", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkRefs]} urlTransform={urlTransform} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
