import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Download, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { api, copyText, isLocked, type VaultStatus } from "@/lib/api";
import { keys, refreshAll, useVault } from "@/lib/queries";

const MIN_PASSWORD = 8;

type Mode = "setup" | "recovery" | "unlock" | "recover" | "change";

interface VaultApi {
  status: VaultStatus | undefined;
  /** Resolves true once this device can open secure folders (setting them up first if needed). */
  ensureUnlocked: () => Promise<boolean>;
  /** For a failed request: if a secure folder was locked, ask to unlock and return true. */
  handle: (err: unknown) => boolean;
  lock: (everywhere?: boolean) => Promise<void>;
  changePassword: () => void;
  recover: () => void;
}

const VaultContext = React.createContext<VaultApi | null>(null);

export function useVaultUi(): VaultApi {
  const ctx = React.useContext(VaultContext);
  if (!ctx) throw new Error("useVaultUi outside provider");
  return ctx;
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { data: status } = useVault();
  const [mode, setMode] = React.useState<Mode | null>(null);
  const [recoveryKey, setRecoveryKey] = React.useState("");
  const waiting = React.useRef<((ok: boolean) => void)[]>([]);
  const statusRef = React.useRef(status);
  statusRef.current = status;

  const settle = React.useCallback((ok: boolean) => {
    const list = waiting.current;
    waiting.current = [];
    list.forEach((resolve) => resolve(ok));
  }, []);

  const changed = React.useCallback(
    (next?: VaultStatus) => {
      if (next) qc.setQueryData(keys.vault, next);
      qc.invalidateQueries({ queryKey: keys.vault });
      refreshAll(qc);
    },
    [qc],
  );

  const ensureUnlocked = React.useCallback(async () => {
    let current: VaultStatus;
    try {
      current =
        statusRef.current ?? (await qc.fetchQuery({ queryKey: keys.vault, queryFn: () => api<VaultStatus>("/api/vault") }));
    } catch {
      return false;
    }
    if (current.unlocked) return true;
    if (!current.available) {
      toast.error("Secure folders are not available", {
        description: "The server is missing the 'cryptography' package. Run the installer again.",
      });
      return false;
    }
    setMode(current.configured ? "unlock" : "setup");
    return new Promise<boolean>((resolve) => waiting.current.push(resolve));
  }, [qc]);

  const handle = React.useCallback(
    (err: unknown) => {
      if (!isLocked(err)) return false;
      // The server says locked (the session ran out, or was locked elsewhere):
      // believe it over the cached status, then ask for the password.
      const known = statusRef.current;
      if (known?.unlocked) {
        const next = { ...known, unlocked: false, expires: null };
        statusRef.current = next;
        qc.setQueryData(keys.vault, next);
      }
      ensureUnlocked();
      return true;
    },
    [ensureUnlocked, qc],
  );

  const lock = React.useCallback(
    async (everywhere = false) => {
      try {
        const next = await api<VaultStatus>("/api/vault/lock", { everywhere });
        changed(next);
        toast.success(everywhere ? "Secure folders locked on every device" : "Secure folders locked on this device");
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [changed],
  );

  const value = React.useMemo<VaultApi>(
    () => ({
      status,
      ensureUnlocked,
      handle,
      lock,
      changePassword: () => setMode("change"),
      recover: () => setMode("recover"),
    }),
    [status, ensureUnlocked, handle, lock],
  );

  const close = () => {
    // Setup is only finished once the recovery key has been seen.
    if (mode === "recovery") return;
    setMode(null);
    settle(!!statusRef.current?.unlocked);
  };

  return (
    <VaultContext.Provider value={value}>
      {children}
      <Dialog open={mode !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent
          className="sm:max-w-md"
          showClose={mode !== "recovery"}
          onEscapeKeyDown={(e) => mode === "recovery" && e.preventDefault()}
          onInteractOutside={(e) => mode === "recovery" && e.preventDefault()}
          // Opened from a menu item, the menu hands focus back to its button as it
          // closes; that must not count as leaving the dialog.
          onFocusOutside={(e) => e.preventDefault()}
        >
          {mode === "setup" && (
            <SetupForm
              onCancel={close}
              onDone={(key, next) => {
                setRecoveryKey(key);
                changed(next);
                setMode("recovery");
              }}
            />
          )}
          {mode === "recovery" && (
            <RecoveryKey
              code={recoveryKey}
              onDone={() => {
                setRecoveryKey("");
                setMode(null);
                settle(true);
                toast.success("Secure folders are ready", { description: "This device is unlocked." });
              }}
            />
          )}
          {mode === "unlock" && (
            <UnlockForm
              hours={status?.hours ?? 12}
              onCancel={close}
              onForgot={() => setMode("recover")}
              onDone={(next) => {
                changed(next);
                setMode(null);
                settle(true);
              }}
            />
          )}
          {mode === "recover" && (
            <RecoverForm
              onCancel={close}
              onDone={(next) => {
                changed(next);
                setMode(null);
                settle(true);
                toast.success("New password set", { description: "Your recovery key still works — keep it safe." });
              }}
            />
          )}
          {mode === "change" && (
            <ChangeForm
              onCancel={close}
              onForgot={() => setMode("recover")}
              onDone={() => {
                setMode(null);
                settle(!!statusRef.current?.unlocked);
                toast.success("Password changed");
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </VaultContext.Provider>
  );
}

/* ------------------------------------------------------------------ forms --- */

function useSubmit<T>(run: () => Promise<T>, done: (result: T) => void) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      done(await run());
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return { busy, error, setError, submit };
}

function Field({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...input} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Lets password managers file the password under a stable name. */
function HiddenUser() {
  return <input type="text" name="username" autoComplete="username" value="pupload secure folders" readOnly hidden />;
}

function Heading({ icon: Icon, title, children }: { icon: typeof ShieldCheck; title: string; children: React.ReactNode }) {
  return (
    <DialogHeader>
      <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary">
        <Icon className="size-5" />
      </div>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{children}</DialogDescription>
    </DialogHeader>
  );
}

function ErrorLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {text}
    </p>
  );
}

function newPasswordProblem(password: string, confirm: string) {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  if (password !== confirm) return "The two passwords don't match";
  return "";
}

function SetupForm({ onCancel, onDone }: { onCancel: () => void; onDone: (key: string, s: VaultStatus) => void }) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const { busy, error, setError, submit } = useSubmit(
    () => api<VaultStatus & { recovery_key: string }>("/api/vault/setup", { password }),
    (res) => onDone(res.recovery_key, res),
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        const problem = newPasswordProblem(password, confirm);
        if (problem) {
          e.preventDefault();
          return setError(problem);
        }
        submit(e);
      }}
    >
      <Heading icon={ShieldCheck} title="Set up secure folders">
        Choose one password for all secure folders. Everything inside them is encrypted on the Pi, so it stays private even
        if someone takes the SD card or drive.
      </Heading>
      <HiddenUser />
      <Field
        id="vault-new"
        label="Master password"
        type="password"
        autoComplete="new-password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={`At least ${MIN_PASSWORD} characters. A few random words make a strong one.`}
      />
      <Field
        id="vault-confirm"
        label="Type it again"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <ErrorLine text={error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Setting up…" : "Continue"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RecoveryKey({ code, onDone }: { code: string; onDone: () => void }) {
  const [saved, setSaved] = React.useState(false);
  const { settings } = useApp();

  const download = () => {
    const text = [
      `${settings.app_name} — secure folders recovery key`,
      `Created ${new Date().toLocaleString()} on ${location.host}`,
      "",
      code,
      "",
      "If you forget the master password, open Settings → Secure folders →",
      "“Forgot password?” and enter this key to choose a new one.",
      "Anyone with this key can read your secure folders. Keep it somewhere safe,",
      "away from the Pi (a password manager, or printed and put away).",
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${settings.app_name}-recovery-key.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="grid gap-4">
      <Heading icon={KeyRound} title="Save your recovery key">
        If you ever forget the password, this key is the only way back in. Without either, the files in secure folders
        cannot be recovered by anyone. It is shown only now.
      </Heading>
      <div
        aria-label={`Recovery key ${code}`}
        className="grid grid-cols-4 gap-x-2 gap-y-1.5 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 px-4 py-4 text-center font-mono text-[15px] font-semibold tracking-wider select-all sm:text-base"
      >
        {code.split("-").map((group, i) => (
          <span key={i}>{group}</span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            if (await copyText(code)) toast.success("Recovery key copied");
            else toast.error("Could not copy — save it as a file instead");
          }}
        >
          <Copy /> Copy
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          <Download /> Save as file
        </Button>
      </div>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm">
        <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} className="mt-0.5" />
        <span>I've stored the recovery key somewhere safe, away from the Pi.</span>
      </label>
      <DialogFooter>
        <Button onClick={onDone} disabled={!saved}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function UnlockForm({
  hours,
  onCancel,
  onForgot,
  onDone,
}: {
  hours: number;
  onCancel: () => void;
  onForgot: () => void;
  onDone: (s: VaultStatus) => void;
}) {
  const [password, setPassword] = React.useState("");
  const { busy, error, submit } = useSubmit(() => api<VaultStatus>("/api/vault/unlock", { password }), onDone);
  return (
    <form className="grid gap-4" onSubmit={submit}>
      <Heading icon={LockKeyhole} title="Unlock secure folders">
        Enter the master password. This device stays unlocked for {hours === 1 ? "1 hour" : `${hours} hours`}, or until
        you lock it.
      </Heading>
      <HiddenUser />
      <Field
        id="vault-password"
        label="Master password"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <ErrorLine text={error} />
      <DialogFooter className="items-center sm:justify-between">
        <button type="button" onClick={onForgot} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Forgot password?
        </button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !password}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

function RecoverForm({ onCancel, onDone }: { onCancel: () => void; onDone: (s: VaultStatus) => void }) {
  const [code, setCode] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const { busy, error, setError, submit } = useSubmit(
    () => api<VaultStatus>("/api/vault/password", { recovery_key: code, new: password }),
    onDone,
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        const problem = newPasswordProblem(password, confirm);
        if (problem) {
          e.preventDefault();
          return setError(problem);
        }
        submit(e);
      }}
    >
      <Heading icon={KeyRound} title="Reset with the recovery key">
        Enter the recovery key you saved when you set up secure folders, then choose a new password.
      </Heading>
      <HiddenUser />
      <Field
        id="vault-recovery"
        label="Recovery key"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        className="font-mono uppercase"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Field
        id="vault-reset-new"
        label="New password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Field
        id="vault-reset-confirm"
        label="Type it again"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <ErrorLine text={error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !code}>
          {busy ? "Checking…" : "Set new password"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ChangeForm({ onCancel, onForgot, onDone }: { onCancel: () => void; onForgot: () => void; onDone: () => void }) {
  const [current, setCurrent] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const { busy, error, setError, submit } = useSubmit(
    () => api("/api/vault/password", { current, new: password }),
    onDone,
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        const problem = newPasswordProblem(password, confirm);
        if (problem) {
          e.preventDefault();
          return setError(problem);
        }
        submit(e);
      }}
    >
      <Heading icon={KeyRound} title="Change master password">
        Files stay as they are; only the password that unlocks them changes. Your recovery key keeps working.
      </Heading>
      <HiddenUser />
      <Field
        id="vault-current"
        label="Current password"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <Field
        id="vault-change-new"
        label="New password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Field
        id="vault-change-confirm"
        label="Type it again"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <ErrorLine text={error} />
      <DialogFooter className="items-center sm:justify-between">
        <button type="button" onClick={onForgot} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Forgot it?
        </button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !current}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
