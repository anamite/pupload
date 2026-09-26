import { useEffect } from "react";
import { toast } from "sonner";

/**
 * After the Pi is updated, pages that are already open keep running the old
 * interface. Check now and then, and offer a one-tap reload.
 */
export function useUpdateNotice() {
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let shown = false;
    const check = async () => {
      if (shown || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/build-info.json", { cache: "no-store" });
        if (!res.ok) return;
        const info = (await res.json()) as { source?: string; version?: string };
        if (info.source && info.source !== __BUILD_ID__) {
          shown = true;
          toast("pupload has been updated", {
            description: info.version ? `Version ${info.version} is ready.` : undefined,
            duration: Infinity,
            action: { label: "Reload", onClick: () => location.reload() },
          });
        }
      } catch {
        /* offline: try again later */
      }
    };
    const timer = setInterval(check, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", check);
    check();
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
}
