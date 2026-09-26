import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, ChevronRight, Download, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fileUrl, startDownload, type Item } from "@/lib/api";
import { fmtSize } from "@/lib/format";

export function Viewer({
  items,
  index,
  onIndex,
  onClose,
  onDetails,
}: {
  items: Item[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDetails: (item: Item) => void;
}) {
  const item = items[index];
  const many = items.length > 1;
  const step = React.useCallback(
    (d: number) => many && onIndex((index + d + items.length) % items.length),
    [index, items.length, many, onIndex],
  );
  const touch = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  if (!item) return null;
  const url = fileUrl("raw", item.path);

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/92 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col text-white outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
          onTouchStart={(e) => {
            touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          }}
          onTouchEnd={(e) => {
            const start = touch.current;
            touch.current = null;
            if (!start || item.kind === "pdf") return;
            const dx = e.changedTouches[0].clientX - start.x;
            const dy = e.changedTouches[0].clientY - start.y;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
            else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose();
          }}
        >
          <div className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 sm:px-5">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-sm font-medium sm:text-base">{item.name}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="font-mono text-xs text-white/55 tabular">
                {fmtSize(item.size)}
                {many && ` · ${index + 1} / ${items.length}`}
              </DialogPrimitive.Description>
            </div>
            <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => onDetails(item)} aria-label="Details">
              <Info />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="text-white hover:bg-white/10 hover:text-white"
              onClick={() => startDownload(fileUrl("download", item.path))}
              aria-label="Download"
            >
              <Download />
            </Button>
            <DialogPrimitive.Close asChild>
              <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Close">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div
            className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-16"
            onClick={(e) => e.target === e.currentTarget && onClose()}
          >
            <Stage key={item.path} item={item} url={url} />
            {many && (
              <>
                <NavButton side="left" onClick={() => step(-1)} />
                <NavButton side="right" onClick={() => step(1)} />
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function NavButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      onClick={onClick}
      aria-label={side === "left" ? "Previous" : "Next"}
      className={`absolute top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 active:scale-95 sm:flex ${side === "left" ? "left-3" : "right-3"}`}
    >
      <Icon className="size-6" />
    </button>
  );
}

function Stage({ item, url }: { item: Item; url: string }) {
  const [text, setText] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (item.kind !== "text") return;
    let live = true;
    fetch(url)
      .then((r) => r.text())
      .then((t) => live && setText(t.slice(0, 400_000)))
      .catch(() => live && setText("Could not read this file."));
    return () => {
      live = false;
    };
  }, [item.kind, url]);

  const cls = "max-h-full max-w-full animate-in fade-in-0 zoom-in-[0.97] duration-300";
  if (item.kind === "image") return <img src={url} alt={item.name} className={`${cls} rounded-md object-contain select-none`} draggable={false} />;
  if (item.kind === "video")
    return <video src={url} controls autoPlay playsInline className={`${cls} rounded-md bg-black`} />;
  if (item.kind === "pdf") return <iframe src={url} title={item.name} className="size-full rounded-lg bg-white" />;
  return (
    <pre className="scrollbar-thin size-full max-w-4xl overflow-auto rounded-xl bg-white/[0.06] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-white/90 sm:text-sm">
      {text ?? "Loading…"}
    </pre>
  );
}
