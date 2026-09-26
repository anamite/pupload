import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}

interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  placeholder?: string;
  /** Pre-select the name but not the extension, like a desktop file manager. */
  selectStem?: boolean;
}

type Pending =
  | { type: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { type: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void };

interface DialogsApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogsContext = React.createContext<DialogsApi | null>(null);

export function useDialogs(): DialogsApi {
  const ctx = React.useContext(DialogsContext);
  if (!ctx) throw new Error("useDialogs outside provider");
  return ctx;
}

export function DialogsProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const api = React.useMemo<DialogsApi>(
    () => ({
      confirm: (opts) =>
        new Promise((resolve) => {
          setPending({ type: "confirm", opts, resolve });
          setOpen(true);
        }),
      prompt: (opts) =>
        new Promise((resolve) => {
          setValue(opts.initial ?? "");
          setPending({ type: "prompt", opts, resolve });
          setOpen(true);
        }),
    }),
    [],
  );

  const finish = (result: boolean | string | null) => {
    if (!pending) return;
    if (pending.type === "confirm") pending.resolve(result === true);
    else pending.resolve(typeof result === "string" ? result : null);
    setOpen(false);
  };

  const submit = () => {
    if (pending?.type === "prompt") {
      const text = value.trim();
      finish(text ? text : null);
    } else finish(true);
  };

  return (
    <DialogsContext.Provider value={api}>
      {children}
      <Dialog open={open} onOpenChange={(o) => !o && finish(pending?.type === "confirm" ? false : null)}>
        <DialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => {
            if (pending?.type !== "prompt") return;
            e.preventDefault();
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            const dot = pending.opts.selectStem ? el.value.lastIndexOf(".") : -1;
            el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
          }}
        >
          {pending && (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <DialogHeader>
                <DialogTitle>{pending.opts.title}</DialogTitle>
                {pending.type === "confirm" && pending.opts.message ? (
                  <DialogDescription>{pending.opts.message}</DialogDescription>
                ) : (
                  <DialogDescription className="sr-only">{pending.opts.title}</DialogDescription>
                )}
              </DialogHeader>
              {pending.type === "prompt" && (
                <div className="grid gap-2">
                  <Label htmlFor="prompt-input">{pending.opts.label}</Label>
                  <Input
                    id="prompt-input"
                    ref={inputRef}
                    value={value}
                    placeholder={pending.opts.placeholder}
                    autoComplete="off"
                    onChange={(e) => setValue(e.target.value)}
                  />
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => finish(pending.type === "confirm" ? false : null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={pending.type === "confirm" && pending.opts.destructive ? "destructive" : "default"}
                  autoFocus={pending.type === "confirm"}
                >
                  {pending.opts.confirmLabel ?? (pending.type === "confirm" ? "Confirm" : "Save")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </DialogsContext.Provider>
  );
}
