import * as React from "react";
import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtTime } from "@/lib/format";
import { player, usePlayer } from "@/lib/player";

/** Mini player docked above the phone tab bar, or along the bottom of the desktop layout. */
export function AudioBar() {
  const p = usePlayer();
  const visible = !!p.track;

  React.useEffect(() => {
    document.documentElement.style.setProperty("--player-h", visible ? "72px" : "0px");
  }, [visible]);

  if (!p.track) return null;
  const pct = p.duration ? (p.time / p.duration) * 100 : 0;

  return (
    <div
      className="fixed right-0 left-0 z-30 px-2 animate-in slide-in-from-bottom-4 fade-in-0 md:left-[76px] md:px-4 lg:left-[264px]"
      style={{ bottom: "calc(var(--bottom-nav-h) + 6px)" }}
    >
      <div className="relative mx-auto flex h-16 max-w-3xl items-center gap-2 overflow-hidden rounded-2xl border bg-popover/95 pr-2 pl-2 shadow-xl backdrop-blur-xl">
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
          <div className="h-full bg-primary transition-[width] duration-300 ease-linear" style={{ width: `${pct}%` }} />
        </div>
        <Button variant="ghost" size="icon" className="hidden sm:inline-flex" onClick={() => player.step(-1)} aria-label="Previous">
          <SkipBack className="fill-current" />
        </Button>
        <button
          onClick={player.toggle}
          aria-label={p.playing ? "Pause" : "Play"}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform active:scale-95"
        >
          {p.playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
        </button>
        <Button variant="ghost" size="icon" onClick={() => player.step(1)} aria-label="Next">
          <SkipForward className="fill-current" />
        </Button>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-sm font-medium">{p.track.name}</div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground tabular">{fmtTime(p.time)}</span>
            <input
              type="range"
              min={0}
              max={p.duration || 0}
              step={0.1}
              value={Math.min(p.time, p.duration || 0)}
              onChange={(e) => player.seek(Number(e.target.value))}
              aria-label="Seek"
              className="h-1 flex-1 cursor-pointer accent-[var(--primary)]"
            />
            <span className="font-mono text-[10px] text-muted-foreground tabular">{fmtTime(p.duration)}</span>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={player.stop} aria-label="Close player">
          <X />
        </Button>
      </div>
    </div>
  );
}
