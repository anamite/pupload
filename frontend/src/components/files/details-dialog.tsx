import * as React from "react";
import { KindIcon, KIND_META } from "@/components/file-icon";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Item } from "@/lib/api";
import { deviceId } from "@/lib/device";
import { fmtDateTime, fmtLeft, fmtSize, plural } from "@/lib/format";

export function DetailsDialog({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const [shown, setShown] = React.useState<Item | null>(item);
  React.useEffect(() => {
    if (item) setShown(item);
  }, [item]);
  const it = shown;
  const mine = !!it?.device_id && it.device_id === deviceId();
  const left = it ? fmtLeft(it.expires) : null;

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {it && (
          <>
            <DialogHeader className="flex-row items-center gap-3">
              <KindIcon kind={it.kind} className="size-12 rounded-xl" />
              <div className="min-w-0">
                <DialogTitle className="text-lg break-all">{it.name}</DialogTitle>
                <DialogDescription>{KIND_META[it.kind]?.label ?? "File"}</DialogDescription>
              </div>
            </DialogHeader>
            <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 rounded-xl border bg-muted/40 p-4 text-sm">
              <Row label="Location">{it.parent ? `Home / ${it.parent.split("/").join(" / ")}` : "Home"}</Row>
              <Row label={it.is_dir ? "Contains" : "Size"}>
                {it.is_dir ? plural(it.children ?? 0, "item") : <span className="font-mono tabular">{fmtSize(it.size)}</span>}
              </Row>
              <Row label={it.is_dir ? "Created" : "Uploaded"}>{fmtDateTime(it.created)}</Row>
              <Row label="From device">
                {it.device_name ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {it.device_name}
                    {mine && <Badge>this device</Badge>}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not recorded</span>
                )}
              </Row>
              {it.device_ip && (
                <Row label="Network address">
                  <span className="font-mono tabular">{it.device_ip}</span>
                </Row>
              )}
              {it.device_id && (
                <Row label="Device ID">
                  <span className="font-mono text-xs break-all text-muted-foreground">{it.device_id}</span>
                </Row>
              )}
              {!it.is_dir && (
                <>
                  <Row label="Opened">{plural(it.downloads, "time")}</Row>
                  <Row label="Expires">
                    {it.pinned ? "Never — kept forever" : it.expires ? `${fmtDateTime(it.expires)} (${left?.text})` : "Never"}
                  </Row>
                </>
              )}
            </dl>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
