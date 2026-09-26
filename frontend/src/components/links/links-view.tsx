import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  ExternalLink,
  Link2,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Smartphone,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { useDialogs } from "@/components/dialogs";
import { EmptyState, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, copyText, SAFE_LINK, type Link } from "@/lib/api";
import { deviceId } from "@/lib/device";
import { fmtWhen, hostOf } from "@/lib/format";
import { useIsPhone } from "@/lib/hooks";
import { absorbStats, keys, refreshAll, useLinks } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface Draft {
  id?: number;
  url: string;
  title: string;
  note: string;
  tags: string;
}

const EMPTY: Draft = { url: "", title: "", note: "", tags: "" };

export function LinksView({ shared }: { shared?: Partial<Draft> | null }) {
  const qc = useQueryClient();
  const phone = useIsPhone();
  const dialogs = useDialogs();
  const { query, setQuery, settings } = useApp();
  const { data: links = [], isLoading } = useLinks();
  const [quick, setQuick] = React.useState("");
  const [tag, setTag] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);

  React.useEffect(() => {
    if (shared) setDraft({ ...EMPTY, ...shared });
  }, [shared]);

  const pollTitles = () => {
    // The server looks up page titles in the background; pick them up shortly.
    [2500, 7000].forEach((ms) => setTimeout(() => qc.invalidateQueries({ queryKey: keys.links }), ms));
  };

  const save = async (d: Draft) => {
    const body = { url: d.url, title: d.title, note: d.note, tags: d.tags.split(",") };
    try {
      if (d.id) await api("/api/links/update", { id: d.id, ...body });
      else await api("/api/links/add", body);
      qc.invalidateQueries({ queryKey: keys.links });
      if (!d.title.trim()) pollTitles();
      toast.success(d.id ? "Link updated" : "Link saved");
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    }
  };

  const remove = async (link: Link) => {
    if (settings.confirm_delete) {
      const yes = await dialogs.confirm({
        title: "Move link to recycle bin?",
        message: link.title || link.url,
        confirmLabel: "Move to bin",
        destructive: true,
      });
      if (!yes) return;
    }
    try {
      const data = await api<{ trash_ids: string[] }>("/api/links/delete", { ids: [link.id] });
      qc.invalidateQueries({ queryKey: keys.links });
      qc.invalidateQueries({ queryKey: keys.trash });
      toast("Link moved to the recycle bin", {
        action: {
          label: "Undo",
          onClick: async () => {
            const res = await api("/api/trash/restore", { ids: data.trash_ids });
            absorbStats(qc, res);
            refreshAll(qc);
            qc.invalidateQueries({ queryKey: keys.links });
          },
        },
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const togglePin = async (link: Link) => {
    await api("/api/links/update", { id: link.id, pinned: !link.pinned }).catch((e) => toast.error(e.message));
    qc.invalidateQueries({ queryKey: keys.links });
  };

  const allTags = React.useMemo(() => {
    const counts = new Map<string, number>();
    links.forEach((l) => l.tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [links]);

  const needle = query.trim().toLowerCase();
  const shown = links.filter(
    (l) =>
      (!tag || l.tags.includes(tag)) &&
      (!needle || [l.title, l.url, l.note, ...l.tags].some((s) => s.toLowerCase().includes(needle))),
  );

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <Link2 className="size-3.5" /> Saved for everyone on the network · never expire
          </span>
        }
        title="Links"
        count={isLoading ? undefined : links.length}
      />

      <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:px-6 lg:px-8">
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!quick.trim()) return;
            if (await save({ ...EMPTY, url: quick })) setQuick("");
          }}
        >
          <div className="relative flex-1">
            <Link2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              placeholder="Paste a link and press Enter"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              className="h-11 rounded-xl pl-9 md:h-11"
            />
          </div>
          <Button type="submit" className="h-11 rounded-xl" disabled={!quick.trim()}>
            <Plus />
            <span className="hidden sm:inline">Save</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="hidden h-11 rounded-xl sm:inline-flex"
            onClick={() => setDraft({ ...EMPTY, url: quick })}
          >
            With details…
          </Button>
        </form>

        {(allTags.length > 0 || needle) && (
          <div className="scrollbar-thin -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
            {needle && (
              <button
                onClick={() => setQuery("")}
                className="flex shrink-0 items-center gap-1 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background"
              >
                <Search className="size-3" /> “{query.trim()}” <X className="size-3" />
              </button>
            )}
            {allTags.map((t) => (
              <button
                key={t}
                onClick={() => setTag(tag === t ? null : t)}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  tag === t ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
                )}
              >
                <Tag className="size-3" />
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 px-4 pb-6 sm:px-6 lg:px-8">
        {isLoading ? (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 2xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          links.length === 0 ? (
            <EmptyState icon={Link2} title="No links yet" text="Paste a link above to keep it here for everyone. Links never expire — they stay until you delete them." />
          ) : (
            <EmptyState icon={Search} title="No matching links" text="Try another word or tag." />
          )
        ) : (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 2xl:grid-cols-3">
            {shown.map((link, i) => (
              <LinkCard
                key={link.id}
                link={link}
                index={i}
                onEdit={() => setDraft({ id: link.id, url: link.url, title: link.title, note: link.note, tags: link.tags.join(", ") })}
                onPin={() => togglePin(link)}
                onDelete={() => remove(link)}
                onTag={setTag}
              />
            ))}
          </div>
        )}
      </div>

      {phone && (
        <button
          aria-label="Add link"
          onClick={() => setDraft({ ...EMPTY })}
          className="fixed right-4 z-30 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground transition-transform active:scale-95"
          style={{ bottom: "calc(var(--bottom-nav-h) + var(--player-h, 0px) + 1rem)" }}
        >
          <Plus className="size-6" strokeWidth={2.4} />
        </button>
      )}

      <LinkDialog draft={draft} onClose={() => setDraft(null)} onSave={save} />
    </div>
  );
}

const HUES = [36, 70, 150, 190, 230, 280, 330, 10];
function hueFor(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length];
}

function LinkCard({
  link,
  index,
  onEdit,
  onPin,
  onDelete,
  onTag,
}: {
  link: Link;
  index: number;
  onEdit: () => void;
  onPin: () => void;
  onDelete: () => void;
  onTag: (t: string) => void;
}) {
  const host = hostOf(link.url);
  const hue = hueFor(host);
  const safe = SAFE_LINK.test(link.url);
  const mine = link.device_id && link.device_id === deviceId();
  const copy = async () => {
    if (await copyText(link.url)) toast.success("Link copied");
    else toast.error("Could not copy on this browser");
  };

  return (
    <article
      style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
      className={cn(
        "group relative flex min-w-0 animate-rise gap-3 overflow-hidden rounded-xl border bg-card p-3 pr-1.5 transition-[border-color,box-shadow] cv-auto [contain-intrinsic-size:auto_96px] hover:border-foreground/15 hover:shadow-md sm:p-4 sm:pr-2",
        link.pinned && "border-primary/35",
      )}
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-xl font-display text-lg font-bold uppercase"
        style={{ background: `oklch(0.7 0.13 ${hue} / 0.16)`, color: `oklch(0.55 0.15 ${hue})` }}
        aria-hidden
      >
        {host.replace(/[^a-z0-9]/gi, "").charAt(0) || "#"}
      </div>
      <div className="min-w-0 flex-1">
        <a
          href={safe ? link.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-2 text-sm leading-snug font-semibold [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] hover:text-primary"
        >
          {link.title || host}
        </a>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{link.url.replace(/^https?:\/\/(www\.)?/, "")}</div>
        {link.note && <p className="mt-1.5 line-clamp-3 text-sm whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{link.note}</p>}
        <div className="relative z-10 mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {link.pinned && (
            <Badge>
              <Pin /> pinned
            </Badge>
          )}
          {link.tags.map((t) => (
            <button key={t} onClick={() => onTag(t)} className="rounded-md bg-secondary px-1.5 py-px font-medium text-secondary-foreground hover:bg-accent">
              #{t}
            </button>
          ))}
          <span>{fmtWhen(link.created_at)}</span>
          {link.device_name && (
            <span className="inline-flex items-center gap-1" title={`Saved from ${link.device_name}`}>
              <Smartphone className="size-3" />
              {mine ? "This device" : link.device_name}
            </span>
          )}
        </div>
      </div>
      <div className="relative z-10 flex flex-col items-center">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="Link actions">
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {safe && (
              <DropdownMenuItem asChild>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink /> Open
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={copy}>
              <Copy /> Copy link
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onPin}>
              {link.pinned ? <PinOff /> : <Pin />} {link.pinned ? "Unpin" : "Pin to top"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 /> Move to recycle bin
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 touch:opacity-100"
          onClick={copy}
          aria-label="Copy link"
        >
          <Copy />
        </Button>
      </div>
    </article>
  );
}

function LinkDialog({
  draft,
  onClose,
  onSave,
}: {
  draft: Draft | null;
  onClose: () => void;
  onSave: (d: Draft) => Promise<boolean>;
}) {
  const [form, setForm] = React.useState<Draft>(EMPTY);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (draft) setForm(draft);
  }, [draft]);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const ok = await onSave(form);
            setBusy(false);
            if (ok) onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit link" : "Save a link"}</DialogTitle>
            <DialogDescription>Leave the title empty and it is filled in from the page.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="link-url">Link</Label>
            <Input id="link-url" value={form.url} onChange={set("url")} placeholder="https://…" inputMode="url" autoCapitalize="off" autoFocus required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="link-title">Title</Label>
            <Input id="link-title" value={form.title} onChange={set("title")} placeholder="Optional" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="link-note">Note</Label>
            <Textarea id="link-note" value={form.note} onChange={set("note")} placeholder="Why it matters, who it is for…" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="link-tags">Tags</Label>
            <Input id="link-tags" value={form.tags} onChange={set("tags")} placeholder="recipes, school, to-watch" autoCapitalize="off" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !form.url.trim()}>
              {form.id ? "Save changes" : "Save link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
