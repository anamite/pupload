import * as React from "react";
import { AlertCircle, Check, ChevronDown, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { fmtSize } from "@/lib/format";
import { uploads, useUploads, type UploadJob } from "@/lib/uploads";
import { cn } from "@/lib/utils";

export function UploadPanel() {
  const jobs = useUploads();
  const [collapsed, setCollapsed] = React.useState(false);
  const pending = jobs.filter((j) => j.status === "queued" || j.status === "uploading" || j.status === "waiting");
  const waiting = jobs.some((j) => j.status === "waiting");
  const failed = jobs.filter((j) => j.status === "error");

  // Tidy away finished batches without errors.
  React.useEffect(() => {
    if (!jobs.length || pending.length || failed.length) return;
    const t = setTimeout(() => uploads.clearFinished(), 3500);
    return () => clearTimeout(t);
  }, [jobs.length, pending.length, failed.length]);

  if (!jobs.length) return null;

  const total = jobs.filter((j) => j.status !== "canceled").reduce((a, j) => a + j.file.size, 0);
  const done = jobs.filter((j) => j.status !== "canceled").reduce((a, j) => a + (j.status === "done" ? j.file.size : j.loaded), 0);
  const pct = total ? Math.round((done / total) * 100) : 100;
  const title = waiting
    ? "Reconnecting…"
    : pending.length
    ? `Uploading ${pending.length} file${pending.length === 1 ? "" : "s"}`
    : failed.length
      ? `${failed.length} upload${failed.length === 1 ? "" : "s"} failed`
      : "Uploads complete";

  return (
    <div
      className="fixed right-2 left-2 z-40 animate-in slide-in-from-bottom-6 fade-in-0 sm:right-4 sm:left-auto sm:w-96"
      style={{ bottom: "calc(var(--bottom-nav-h) + var(--player-h, 0px) + 12px)" }}
    >
      <div className="overflow-hidden rounded-2xl border bg-popover shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{title}</div>
            <div className="font-mono text-[11px] text-muted-foreground tabular">
              {fmtSize(done)} of {fmtSize(total)} · {pct}%
            </div>
          </div>
          {pending.length > 0 && (
            <Button variant="ghost" size="sm" onClick={uploads.cancelAll}>
              Cancel
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand" : "Collapse"}>
            <ChevronDown className={cn("transition-transform", collapsed && "rotate-180")} />
          </Button>
          {!pending.length && (
            <Button variant="ghost" size="icon-sm" onClick={uploads.clearFinished} aria-label="Close">
              <X />
            </Button>
          )}
        </div>
        <Progress value={pct} className="h-1 rounded-none" />
        {!collapsed && (
          <div className="scrollbar-thin max-h-64 overflow-y-auto py-1">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({ job }: { job: UploadJob }) {
  const pct = job.file.size ? Math.round((job.loaded / job.file.size) * 100) : 100;
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{job.dir ? `${job.dir}/${job.file.name}` : job.file.name}</div>
        {job.status === "uploading" || job.status === "queued" || job.status === "waiting" ? (
          <>
            <Progress
              value={job.status === "queued" ? 0 : pct}
              className="mt-1.5 h-1"
              indicatorClassName={job.status === "waiting" ? "bg-warning" : undefined}
            />
            {(job.note || job.resumed) && (
              <div className={cn("mt-1 text-[11px]", job.status === "waiting" ? "text-foreground" : "text-muted-foreground")}>
                {job.note ?? `Resumed at ${fmtSize(job.loaded)}`}
              </div>
            )}
          </>
        ) : (
          <div
            className={cn(
              "text-[11px]",
              job.status === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {job.status === "done" ? fmtSize(job.file.size) : job.status === "canceled" ? "Canceled" : job.error}
          </div>
        )}
      </div>
      {job.status === "done" && (
        <span className="flex size-6 items-center justify-center rounded-full bg-success/15 text-success">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )}
      {job.status === "error" && (
        <>
          <AlertCircle className="size-4 text-destructive" />
          <Button variant="ghost" size="icon-sm" onClick={() => uploads.retry(job.id)} aria-label="Retry">
            <RotateCcw />
          </Button>
        </>
      )}
      {(job.status === "uploading" || job.status === "queued" || job.status === "waiting") && (
        <Button variant="ghost" size="icon-sm" onClick={() => uploads.cancel(job.id)} aria-label="Cancel upload">
          <X />
        </Button>
      )}
    </div>
  );
}
