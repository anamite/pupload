import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bold,
  CheckSquare,
  Code,
  Columns2,
  Copy,
  Download,
  Eye,
  Heading,
  Italic,
  List,
  ListOrdered,
  MoreVertical,
  NotebookPen,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Quote,
  Search,
  Strikethrough,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { useDialogs } from "@/components/dialogs";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { copyText, type Note } from "@/lib/api";
import { fmtWhen, plural } from "@/lib/format";
import { useIsPhone } from "@/lib/hooks";
import { autoTitle, deletePrivate, newId, plainText, savePrivate, tintColor } from "@/lib/private";
import { usePrivate } from "@/lib/queries";
import { hrefFor, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Fab, PrivateEyebrow, Swatches } from "./common";
import { Markdown, toggleTask } from "./markdown";
import { RefPicker } from "./ref-picker";

export function NotesView({ id }: { id: string }) {
  if (id) return <NoteEditor key={id} id={id} />;
  return <NotesIndex />;
}

const byPinThenRecent = (a: Note, b: Note) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated;

function NotesIndex() {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const { query, settings } = useApp();
  const { data, isLoading } = usePrivate(true);
  const notes = data?.note ?? [];
  const needle = query.trim().toLowerCase();
  const shown = notes
    .filter((n) => !needle || n.title.toLowerCase().includes(needle) || n.body.toLowerCase().includes(needle))
    .sort(byPinThenRecent);

  const remove = async (note: Note) => {
    if (settings.confirm_delete) {
      const yes = await dialogs.confirm({
        title: "Move note to recycle bin?",
        message: note.title || "Untitled note",
        confirmLabel: "Move to bin",
        destructive: true,
      });
      if (!yes) return;
    }
    deletePrivate(qc, "note", [note.id]);
  };
  const pin = (note: Note) => savePrivate(qc, "note", { ...note, pinned: !note.pinned }).catch((e) => toast.error(e.message));

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={<PrivateEyebrow icon={NotebookPen} text="Markdown notes, encrypted on the Pi" />}
        title="Notes"
        count={isLoading ? undefined : notes.length}
        actions={
          <Button className="hidden rounded-xl md:inline-flex" onClick={() => navigate("notes", "new")}>
            <Plus /> New note
          </Button>
        }
      />
      <div className="flex-1 px-4 pb-6 sm:px-6 lg:px-8">
        {isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          notes.length === 0 ? (
            <EmptyState
              icon={NotebookPen}
              title="No notes yet"
              text="Write in markdown, tick checklists, and link files and folders from the drive with [[ ]]. Only unlocked devices ever see them."
              action={
                <Button onClick={() => navigate("notes", "new")}>
                  <Plus /> New note
                </Button>
              }
            />
          ) : (
            <EmptyState icon={Search} title="No matching notes" text="Try another word." />
          )
        ) : (
          <div className="columns-1 gap-3 sm:columns-2 xl:columns-3 2xl:columns-4">
            {shown.map((note, i) => (
              <NoteCard key={note.id} note={note} index={i} onPin={() => pin(note)} onDelete={() => remove(note)} />
            ))}
          </div>
        )}
      </div>
      <Fab label="New note" onClick={() => navigate("notes", "new")} />
    </div>
  );
}

function NoteCard({ note, index, onPin, onDelete }: { note: Note; index: number; onPin: () => void; onDelete: () => void }) {
  const snippet = plainText(note.body).slice(0, 320);
  const tasks = note.body.match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/gm) ?? [];
  const done = tasks.filter((t) => /\[[xX]\]$/.test(t)).length;
  return (
    <article
      style={{ animationDelay: `${Math.min(index, 14) * 22}ms`, borderTopColor: note.color ? tintColor(note.color) : undefined }}
      className={cn(
        "group relative mb-3 flex break-inside-avoid animate-rise flex-col gap-2 rounded-xl border bg-card p-4 pr-2 transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-md",
        note.color && "border-t-[3px]",
      )}
    >
      <div className="flex items-start gap-2">
        <a
          href={hrefFor("notes", note.id)}
          className="min-w-0 flex-1 font-display text-lg leading-snug font-semibold [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-['']"
        >
          {note.title || <span className="text-muted-foreground">Untitled note</span>}
        </a>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="relative z-10 -mt-1 rounded-full text-muted-foreground" aria-label="Note actions">
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => navigate("notes", note.id)}>
              <Pencil /> Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onPin}>
              {note.pinned ? <PinOff /> : <Pin />} {note.pinned ? "Unpin" : "Pin to top"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 /> Move to recycle bin
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {snippet && <p className="line-clamp-6 pr-2 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{snippet}</p>}
      <div className="flex flex-wrap items-center gap-2 pr-2 text-[11px] text-muted-foreground">
        {note.pinned && <Pin className="size-3 text-primary" />}
        <span>{fmtWhen(note.updated)}</span>
        {tasks.length > 0 && (
          <span className="inline-flex items-center gap-1 tabular">
            <CheckSquare className="size-3" /> {done}/{tasks.length}
          </span>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

type Mode = "write" | "read" | "split";
type Draft = Pick<Note, "id" | "title" | "title_auto" | "body" | "pinned" | "color">;

const SAVE_DELAY = 700;

function NoteEditor({ id }: { id: string }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const phone = useIsPhone();
  const { settings } = useApp();
  const { data, isLoading } = usePrivate(true);
  const isNew = id === "new";
  const [draft, setDraft] = React.useState<Draft | null>(() =>
    isNew ? { id: newId(), title: "", title_auto: true, body: "", pinned: false, color: "" } : null,
  );
  const stored = data?.note.find((n) => n.id === (draft?.id ?? id));
  const [mode, setMode] = React.useState<Mode>(isNew ? "write" : "read");
  const [status, setStatus] = React.useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [picker, setPicker] = React.useState<{ open: boolean; replace: number | null }>({ open: false, replace: null });
  const area = React.useRef<HTMLTextAreaElement>(null);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const dirty = React.useRef(false);
  const created = React.useRef(!isNew);
  const timer = React.useRef<number>(undefined);

  // Load the stored note once; after that the editor's own copy wins.
  React.useEffect(() => {
    if (!draft && stored) {
      setDraft({ id: stored.id, title: stored.title, title_auto: stored.title_auto, body: stored.body, pinned: stored.pinned, color: stored.color });
      if (!stored.body.trim()) setMode("write");
    }
  }, [draft, stored]);

  const flush = React.useCallback(async () => {
    window.clearTimeout(timer.current);
    const d = draftRef.current;
    if (!d || !dirty.current) return;
    if (!created.current && !d.body.trim() && d.title_auto) return; // nothing worth keeping yet
    dirty.current = false;
    setStatus("saving");
    try {
      await savePrivate(qc, "note", { ...(stored ?? { created: Date.now() / 1000, updated: 0 }), ...d } as Note);
      if (!created.current) {
        created.current = true;
        // The address becomes the note's own, without remounting the editor mid-sentence.
        history.replaceState(null, "", hrefFor("notes", d.id));
      }
      setStatus(dirty.current ? "dirty" : "saved");
    } catch (err) {
      dirty.current = true;
      setStatus("error");
      toast.error((err as Error).message);
    }
  }, [qc, stored]);

  const change = React.useCallback(
    (patch: Partial<Draft>) => {
      setDraft((d) => (d ? { ...d, ...patch } : d));
      dirty.current = true;
      setStatus("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flush(), SAVE_DELAY);
    },
    [flush],
  );

  // Save on the way out: leaving the note, hiding the tab, closing the page.
  const flushRef = React.useRef(flush);
  flushRef.current = flush;
  React.useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    const onPageHide = () => {
      const d = draftRef.current;
      if (!d || !dirty.current || (!created.current && !d.body.trim())) return;
      const blob = new Blob([JSON.stringify({ kind: "note", item: d })], { type: "application/json" });
      navigator.sendBeacon?.("/api/private/save", blob);
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      flushRef.current();
    };
  }, []);

  // Grow the text area with its content.
  React.useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft?.body, mode]);

  if (!draft) {
    if (isLoading)
      return (
        <div className="grid gap-3 p-6">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-64" />
        </div>
      );
    return (
      <div className="p-6">
        <EmptyState
          icon={NotebookPen}
          title="This note is gone"
          text="It may have been moved to the recycle bin from another device."
          action={<Button onClick={() => navigate("notes")}>Back to notes</Button>}
        />
      </div>
    );
  }

  const shownTitle = draft.title_auto ? autoTitle(draft.body) : draft.title;
  const words = plainText(draft.body).split(" ").filter(Boolean).length;

  // --- Text editing helpers -------------------------------------------------
  const edit = (fn: (text: string, start: number, end: number) => { text: string; start: number; end: number }) => {
    const el = area.current;
    if (!el) return;
    const out = fn(draft.body, el.selectionStart, el.selectionEnd);
    change({ body: out.text });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(out.start, out.end);
    });
  };
  const wrap = (before: string, after = before, placeholder = "text") =>
    edit((text, s, e) => {
      const inner = text.slice(s, e) || placeholder;
      return { text: text.slice(0, s) + before + inner + after + text.slice(e), start: s + before.length, end: s + before.length + inner.length };
    });
  const prefix = (mark: string | ((i: number) => string)) =>
    edit((text, s, e) => {
      const lineStart = text.lastIndexOf("\n", s - 1) + 1;
      const lineEnd = text.indexOf("\n", e) === -1 ? text.length : text.indexOf("\n", e);
      const lines = text.slice(lineStart, lineEnd).split("\n");
      const marks = lines.map((_, i) => (typeof mark === "string" ? mark : mark(i)));
      const has = lines.every((l, i) => l.startsWith(marks[i]));
      const next = lines.map((l, i) => (has ? l.slice(marks[i].length) : marks[i] + l)).join("\n");
      return { text: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length };
    });
  const insertRef = (path: string) => {
    const el = area.current;
    const at = picker.replace;
    setPicker({ open: false, replace: null });
    if (mode === "read") setMode("write");
    const pos = at ?? el?.selectionStart ?? draft.body.length;
    const before = at !== null ? draft.body.slice(0, at - 2) : draft.body.slice(0, pos);
    const after = draft.body.slice(pos);
    const token = `[[${path}]]`;
    change({ body: before + token + after });
    requestAnimationFrame(() => {
      const caret = before.length + token.length;
      area.current?.focus();
      area.current?.setSelectionRange(caret, caret);
    });
  };

  const tools = [
    { icon: Heading, label: "Heading", run: () => prefix("## ") },
    { icon: Bold, label: "Bold (Ctrl+B)", run: () => wrap("**") },
    { icon: Italic, label: "Italic (Ctrl+I)", run: () => wrap("_") },
    { icon: Strikethrough, label: "Strikethrough", run: () => wrap("~~") },
    { icon: List, label: "Bulleted list", run: () => prefix("- ") },
    { icon: ListOrdered, label: "Numbered list", run: () => prefix((i) => `${i + 1}. `) },
    { icon: CheckSquare, label: "Checklist", run: () => prefix("- [ ] ") },
    { icon: Quote, label: "Quote", run: () => prefix("> ") },
    { icon: Code, label: "Code", run: () => wrap("`", "`", "code") },
  ];

  const remove = async () => {
    if (settings.confirm_delete && draft.body.trim()) {
      const yes = await dialogs.confirm({ title: "Move note to recycle bin?", message: shownTitle || "Untitled note", confirmLabel: "Move to bin", destructive: true });
      if (!yes) return;
    }
    window.clearTimeout(timer.current);
    dirty.current = false;
    navigate("notes");
    if (created.current) deletePrivate(qc, "note", [draft.id], () => navigate("notes", draft.id));
  };

  const download = () => {
    const blob = new Blob([draft.body], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(shownTitle || "note").replace(/[\\/:*?"<>|]+/g, "_")}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const editor = (
    <div className="min-w-0 flex-1">
      <div className="sticky top-14 z-10 -mx-1 mb-2 flex items-center gap-0.5 overflow-x-auto bg-background/85 px-1 py-1 backdrop-blur md:top-16 scrollbar-thin">
        {tools.map((t) => (
          <Button key={t.label} type="button" variant="ghost" size="icon-sm" title={t.label} aria-label={t.label} onMouseDown={(e) => e.preventDefault()} onClick={t.run}>
            <t.icon />
          </Button>
        ))}
        <span className="mx-1 h-5 w-px shrink-0 bg-border" />
        <Button type="button" variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setPicker({ open: true, replace: null })} title="Link a file or folder ([[)">
          <Paperclip /> <span className="hidden sm:inline">File or folder</span>
        </Button>
      </div>
      <textarea
        ref={area}
        value={draft.body}
        autoFocus={isNew}
        spellCheck
        placeholder={"Start writing…\n\nMarkdown works: # heading, **bold**, - [ ] checklist.\nType [[ to link a file or folder."}
        onChange={(e) => {
          const el = e.target;
          const text = el.value;
          const caret = el.selectionStart;
          const typedRef = text.length > draft.body.length && text.slice(caret - 2, caret) === "[[" && text[caret] !== "]";
          change({ body: text });
          if (typedRef) setPicker({ open: true, replace: caret });
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "i")) {
            e.preventDefault();
            wrap(e.key === "b" ? "**" : "_");
          } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            flush();
          }
        }}
        className="block min-h-[55vh] w-full resize-none bg-transparent font-mono text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70 md:text-sm"
      />
    </div>
  );

  const preview = (
    <div className="min-w-0 flex-1">
      {draft.body.trim() ? (
        <Markdown source={draft.body} onToggleTask={(offset) => change({ body: toggleTask(draft.body, offset) })} />
      ) : (
        <button onClick={() => setMode("write")} className="text-muted-foreground">
          Empty note. Tap to write.
        </button>
      )}
    </div>
  );

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 pt-3 pb-10 sm:px-6 lg:px-8">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Back to notes" onClick={() => navigate("notes")}>
          <ArrowLeft />
        </Button>
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {status === "saving" ? "Saving…" : status === "dirty" ? "Editing…" : status === "error" ? "Not saved, retrying on the next change" : stored ? `Saved · ${fmtWhen(stored.updated)}` : "Not saved yet"}
          {words > 0 && ` · ${plural(words, "word")}`}
        </span>
        <div className="flex rounded-lg border bg-card p-0.5 text-sm shadow-xs">
          {(
            [
              { id: "write", icon: Pencil, label: "Write" },
              { id: "read", icon: Eye, label: "Preview" },
              ...(phone ? [] : [{ id: "split", icon: Columns2, label: "Both" }]),
            ] as { id: Mode; icon: typeof Pencil; label: string }[]
          ).map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-muted-foreground transition-colors",
                mode === m.id && "bg-primary/12 text-primary",
              )}
            >
              <m.icon className="size-3.5" />
              <span className="hidden sm:inline">{m.label}</span>
            </button>
          ))}
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Note actions">
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem onSelect={() => change({ pinned: !draft.pinned })}>
              {draft.pinned ? <PinOff /> : <Pin />} {draft.pinned ? "Unpin" : "Pin to top"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPicker({ open: true, replace: null })}>
              <Paperclip /> Link a file or folder
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={download}>
              <Download /> Download as .md
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                if (await copyText(draft.body)) toast.success("Markdown copied");
                else toast.error("Could not copy on this browser");
              }}
            >
              <Copy /> Copy markdown
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Colour</DropdownMenuLabel>
            <div className="px-2 pb-2">
              <Swatches value={draft.color} onChange={(color) => change({ color })} />
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={remove}>
              <Trash2 /> Move to recycle bin
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-3 mb-4 flex items-center gap-2 border-b pb-3" style={{ borderBottomColor: draft.color ? tintColor(draft.color, 0.6) : undefined }}>
        <input
          value={shownTitle}
          onChange={(e) => {
            const title = e.target.value;
            change(title.trim() ? { title, title_auto: false } : { title: "", title_auto: true });
          }}
          placeholder="Untitled note"
          aria-label="Title"
          className="min-w-0 flex-1 bg-transparent font-display text-[1.75rem] leading-tight font-semibold outline-none placeholder:text-muted-foreground/60 sm:text-4xl"
        />
        {!draft.title_auto && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            title="Use the note's first two words as its title"
            onClick={() => change({ title: "", title_auto: true })}
          >
            <WandSparkles /> <span className="hidden sm:inline">Auto title</span>
          </Button>
        )}
      </div>

      {mode === "split" ? (
        <div className="flex gap-8">
          {editor}
          <div className="w-px shrink-0 bg-border" />
          <div className="min-w-0 flex-1 pt-11">{preview}</div>
        </div>
      ) : mode === "write" ? (
        editor
      ) : (
        <div onDoubleClick={() => setMode("write")}>{preview}</div>
      )}

      <RefPicker open={picker.open} onClose={() => setPicker({ open: false, replace: null })} onPick={insertRef} />
    </div>
  );
}
