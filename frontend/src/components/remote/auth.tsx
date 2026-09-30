import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Globe, KeyRound, LogOut, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { BrandMark } from "@/components/layout/nav";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, SIGNED_OUT, type AuthStatus, type Tier, type VaultStatus } from "@/lib/api";
import { keys } from "@/lib/queries";

/* ------------------------------------------------------------ context --- */

interface AuthApi {
  /** Came in through the remote (tunnel) port. */
  remote: boolean;
  tier: Tier | null;
  expires: number | null;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthApi>({ remote: false, tier: null, expires: null, signOut: async () => {} });

export const useAuthUi = () => React.useContext(AuthContext);

const signedOut: AuthStatus = { remote: true, configured: true, signed_in: false, tier: null, expires: null };

/** A new sign-in state: forget everything cached (it may be private), keeping
 *  only the sign-in query itself so the page follows along. */
function switchTo(qc: QueryClient, status: AuthStatus) {
  qc.cancelQueries({ predicate: (q) => q.queryKey[0] !== keys.auth[0] });
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== keys.auth[0] });
  qc.setQueryData(keys.auth, status);
}

export function AuthProvider({ status, children }: { status: AuthStatus; children: React.ReactNode }) {
  const qc = useQueryClient();

  const signOut = React.useCallback(async () => {
    try {
      await api("/api/auth/logout", {});
    } catch {
      /* signed out either way */
    }
    switchTo(qc, signedOut);
  }, [qc]);

  const value = React.useMemo<AuthApi>(
    () => ({ remote: status.remote, tier: status.tier ?? null, expires: status.expires ?? null, signOut }),
    [status.remote, status.tier, status.expires, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** On the remote port, any "sign in first" reply means the sign-in is over:
 *  drop everything cached (it may be private) and show the sign-in page. */
export function useSignedOutWatch(remote: boolean) {
  const qc = useQueryClient();
  React.useEffect(() => {
    if (!remote) return;
    const onOut = () => {
      const known = qc.getQueryData<AuthStatus>(keys.auth);
      if (!known?.signed_in) return;
      switchTo(qc, signedOut);
      toast("Signed out", { description: "Sign in again to continue." });
    };
    window.addEventListener(SIGNED_OUT, onOut);
    return () => window.removeEventListener(SIGNED_OUT, onOut);
  }, [remote, qc]);
}

/* -------------------------------------------------------- sign-in page --- */

export function LoginScreen({ configured }: { configured: boolean }) {
  const qc = useQueryClient();
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const codeInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    document.title = "Sign in";
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) {
      setError("Enter the 6-digit code from your authenticator app");
      codeInput.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api<AuthStatus>("/api/auth/login", { password, code });
      switchTo(qc, next);
    } catch (err) {
      setError((err as Error).message);
      setCode("");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4 pt-safe">
      <div className="w-full max-w-sm animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-12 rounded-2xl" />
          <h1 className="font-display text-2xl font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            {configured
              ? "Enter your password and the code from your authenticator app."
              : "Remote access isn't set up yet. Set it up at home, in Settings → Remote access."}
          </p>
        </div>
        {configured && (
          <form onSubmit={submit} className="grid gap-4 rounded-2xl border bg-card p-5 shadow-xs">
            {/* Lets password managers keep both passwords under one entry name. */}
            <input type="text" name="username" autoComplete="username" value="pupload remote" readOnly hidden />
            <div className="grid gap-2">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="login-code">Authenticator code</Label>
              <Input
                id="login-code"
                ref={codeInput}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                className="font-mono text-lg tracking-[0.35em] md:text-lg"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" disabled={busy || !password}>
              {busy ? "Checking…" : "Sign in"}
            </Button>
          </form>
        )}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Each code works once. If it's refused, wait for the next one.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ top-bar button --- */

const until = (t: number | null) =>
  t ? new Date(t * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;

/** Remotely: what this sign-in opens, and signing out. Replaces the lock button. */
export function AccountButton() {
  const auth = useAuthUi();
  const qc = useQueryClient();
  if (!auth.remote) return null;
  const full = auth.tier === "full";

  const lockEverywhere = async () => {
    try {
      await api<VaultStatus>("/api/vault/lock", { everywhere: true });
      switchTo(qc, signedOut);
      toast.success("Secure folders locked on every device", { description: "You've been signed out here too." });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Remote sign-in"
          title="Signed in remotely"
          className={full ? "text-primary hover:text-primary" : undefined}
        >
          <Globe />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <div className="flex items-start gap-3 px-2 py-1.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            {full ? <ShieldCheck className="size-4" /> : <KeyRound className="size-4" />}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium">{full ? "Full access" : "Basic access"}</div>
            <div className="text-xs text-muted-foreground">
              {full ? "Secure folders are open" : "Secure folders aren't shown"}
              {until(auth.expires) && <> · until {until(auth.expires)}</>}
            </div>
          </div>
        </div>
        <DropdownMenuSeparator />
        {full && (
          <DropdownMenuItem onSelect={lockEverywhere}>
            <ShieldOff /> Lock secure folders everywhere
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => auth.signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
