import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Globe, KeyRound, LogOut, Power, ShieldCheck, Smartphone, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { encode } from "uqr";
import { useDialogs } from "@/components/dialogs";
import { useAuthUi } from "@/components/remote/auth";
import { Field, Section, Segmented } from "@/components/settings-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVaultUi } from "@/components/vault/vault";
import { api, copyText, type RemoteStatus } from "@/lib/api";
import { fmtWhen } from "@/lib/format";
import { keys } from "@/lib/queries";
import { cn } from "@/lib/utils";

const DAY_CHOICES = ["1", "7", "14", "30"];

const when = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Settings → Remote access. On the home network: set up and manage it.
 *  Remotely: what this sign-in opens, and signing out. */
export function RemoteSection({ days, onDays }: { days: number; onDays: (d: number) => void }) {
  const auth = useAuthUi();
  if (auth.remote) return <SignedInSection />;
  return <ManageSection days={days} onDays={onDays} />;
}

function SignedInSection() {
  const auth = useAuthUi();
  const full = auth.tier === "full";
  return (
    <Section title="Remote access" icon={Globe}>
      <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          {full ? <ShieldCheck className="size-4" /> : <KeyRound className="size-4" />}
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">Signed in with the {full ? "full" : "basic"} password</div>
          <div className="text-xs text-muted-foreground">
            {full ? "Secure folders are open" : "Secure folders aren't shown"}
            {auth.expires && <> · until {when(auth.expires)}</>}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => auth.signOut()}>
          <LogOut /> Sign out
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Passwords, the authenticator and {full ? "the secure folders' master password" : "storage settings"} can only be
        changed at home, on the home network.
      </p>
    </Section>
  );
}

function ManageSection({ days, onDays }: { days: number; onDays: (d: number) => void }) {
  const qc = useQueryClient();
  const vault = useVaultUi();
  const dialogs = useDialogs();
  const [setupOpen, setSetupOpen] = React.useState(false);
  const { data: status } = useQuery({
    queryKey: keys.remote,
    queryFn: () => api<RemoteStatus & { ok: boolean }>("/api/remote"),
    refetchInterval: 30_000,
  });
  if (!status) return null;

  const update = (next: RemoteStatus) => qc.setQueryData(keys.remote, next);

  const startSetup = async () => {
    // The full password opens secure folders, so they must exist and be open here.
    if (!(await vault.ensureUnlocked())) return;
    setSetupOpen(true);
  };

  const signOutAll = async () => {
    try {
      const res = await api<RemoteStatus & { signed_out: number }>("/api/remote/signout", {});
      update(res);
      toast.success(res.signed_out ? `Signed out ${res.signed_out === 1 ? "1 device" : `${res.signed_out} devices`}` : "No one was signed in");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const turnOff = async () => {
    const yes = await dialogs.confirm({
      title: "Turn off remote access?",
      message: "Both passwords and the authenticator are forgotten, and every remote device is signed out. The tunnel will only show a sign-in page nobody can pass.",
      confirmLabel: "Turn off",
      destructive: true,
    });
    if (!yes || !(await vault.ensureUnlocked())) return;
    try {
      update(await api<RemoteStatus>("/api/remote/disable", {}));
      toast.success("Remote access is off");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const sessions = status.sessions ?? [];
  const address = status.port ? `http://${status.host ?? "127.0.0.1"}:${status.port}` : null;

  return (
    <Section title="Remote access" icon={Globe}>
      {!address ? (
        <p className="flex gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            The remote port isn't running{status.error ? `: ${status.error}` : ""}. Restart pupload with{" "}
            <code className="font-mono text-xs">--remote-port 8090</code>.
          </span>
        </p>
      ) : !status.configured ? (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Reach pupload from anywhere through a tunnel (such as Cloudflare Tunnel). The tunnel's address asks for a
            password <i>and</i> a code from an authenticator app, so a leaked password alone gets nobody in. Set two
            passwords: the <b className="text-foreground">basic</b> one opens files, links and the recycle bin, and secure
            folders stay invisible. The <b className="text-foreground">full</b> one opens everything, secure folders included.
          </p>
          <Button className="w-fit" onClick={startSetup}>
            <Globe /> Set up remote access
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Globe className="size-4" />
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">On · password + authenticator code</div>
              <div className="text-xs text-muted-foreground">
                {sessions.length ? `${sessions.length === 1 ? "1 device" : `${sessions.length} devices`} signed in` : "No one is signed in"}
                {status.created ? ` · set up ${new Date(status.created * 1000).toLocaleDateString()}` : ""}
              </div>
            </div>
          </div>
          {status.full_ok === false && (
            <p className="flex gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              Secure folders were set up again since, so the full password no longer opens them. Set up remote access again.
            </p>
          )}
          {sessions.length > 0 && (
            <ul className="grid gap-1.5">
              {sessions.map((s, i) => (
                <li key={i} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
                  <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{s.device}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {s.ip || "unknown address"} · active {fmtWhen(s.seen)} · until {when(s.expires)}
                    </div>
                  </div>
                  <Badge variant={s.tier === "full" ? "default" : "secondary"}>{s.tier === "full" ? "Full" : "Basic"}</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={signOutAll}>
              <LogOut /> Sign out every remote device
            </Button>
            <Button variant="outline" size="sm" onClick={startSetup}>
              <KeyRound /> New passwords or authenticator
            </Button>
            <Button variant="outline" size="sm" onClick={turnOff}>
              <Power /> Turn off
            </Button>
          </div>
          <Field
            label="Basic sign-in lasts"
            hint={`A full sign-in lasts as long as secure folders stay unlocked (${status.hours === 1 ? "1 hour" : `${status.hours} hours`}). Restarting the Pi ends full sign-ins; basic ones carry on.`}
          >
            <Segmented
              value={String(days)}
              options={DAY_CHOICES.includes(String(days)) ? DAY_CHOICES : [...DAY_CHOICES, String(days)]}
              labels={{ "1": "1 day", "7": "1 week", "14": "2 weeks", "30": "30 days" }}
              onChange={(v) => onDays(parseInt(v, 10))}
            />
          </Field>
        </>
      )}
      {address && <TunnelHelp address={address} />}
      <SetupDialog
        open={setupOpen}
        again={status.configured}
        minLength={status.min_password}
        onClose={() => setSetupOpen(false)}
        onDone={(next) => {
          update(next);
          setSetupOpen(false);
          toast.success("Remote access is ready", { description: "Now point your tunnel at the remote port." });
        }}
      />
    </Section>
  );
}

function TunnelHelp({ address }: { address: string }) {
  const commands = [
    { label: "Try it now, on the Pi (a temporary trycloudflare.com address)", cmd: `cloudflared tunnel --url ${address}` },
    {
      label: "To keep it: in Cloudflare, Networks → Tunnels → create one, add a public hostname, and give it this service",
      cmd: address,
    },
  ];
  return (
    <details className="group rounded-xl border bg-card px-3 py-2.5 text-sm">
      <summary className="cursor-pointer font-medium select-none">Connect a Cloudflare tunnel</summary>
      <div className="mt-3 grid gap-3 text-muted-foreground">
        <p>
          The remote port is <code className="font-mono text-xs text-foreground">{address}</code>. It only listens on the Pi
          itself, so it's reachable only through a tunnel running on the Pi. Point the tunnel at it. Never point it at the
          home-network port, which has no login.
        </p>
        {commands.map((c) => (
          <div key={c.cmd} className="grid gap-1">
            <span className="text-xs">{c.label}</span>
            <div className="flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-foreground">{c.cmd}</code>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Copy command"
                onClick={async () => toast[(await copyText(c.cmd)) ? "success" : "error"]("Copied")}
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
        <p className="text-xs">
          No Cloudflare Access (email codes) needed: pupload's own sign-in does the job. The README has the full steps.
        </p>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------- setup --- */

function QrCode({ text }: { text: string }) {
  const qr = React.useMemo(() => encode(text, { ecc: "M", border: 2 }), [text]);
  const path = React.useMemo(() => {
    let d = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return d;
  }, [qr]);
  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className="size-48 rounded-xl bg-white p-1"
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for your authenticator app"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

interface Begin {
  setup_id: string;
  secret: string;
  uri: string;
}

function SetupDialog({
  open,
  again,
  minLength,
  onClose,
  onDone,
}: {
  open: boolean;
  again: boolean;
  minLength: number;
  onClose: () => void;
  onDone: (s: RemoteStatus) => void;
}) {
  const [step, setStep] = React.useState<"passwords" | "authenticator">("passwords");
  const [basic, setBasic] = React.useState("");
  const [basic2, setBasic2] = React.useState("");
  const [full, setFull] = React.useState("");
  const [full2, setFull2] = React.useState("");
  const [begin, setBegin] = React.useState<Begin | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setStep("passwords");
    setBasic("");
    setBasic2("");
    setFull("");
    setFull2("");
    setBegin(null);
    setCode("");
    setError("");
  }, [open]);

  const toAuthenticator = async (e: React.FormEvent) => {
    e.preventDefault();
    for (const [label, a, b] of [
      ["Basic", basic, basic2],
      ["Full", full, full2],
    ] as const) {
      if (a.length < minLength) return setError(`${label} password: use at least ${minLength} characters`);
      if (a !== b) return setError(`${label} password: the two don't match`);
    }
    if (basic === full) return setError("The two passwords must be different");
    setBusy(true);
    setError("");
    try {
      setBegin(await api<Begin>("/api/remote/begin", {}));
      setStep("authenticator");
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!begin) return;
    setBusy(true);
    setError("");
    try {
      onDone(await api<RemoteStatus>("/api/remote/setup", { setup_id: begin.setup_id, code, basic, full }));
    } catch (err) {
      setError((err as Error).message);
      if (/password/i.test((err as Error).message)) setStep("passwords");
    }
    setBusy(false);
  };

  const errorLine = error && (
    <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" onFocusOutside={(e) => e.preventDefault()}>
        {step === "passwords" ? (
          <form className="grid gap-4" onSubmit={toAuthenticator}>
            <DialogHeader>
              <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <KeyRound className="size-5" />
              </div>
              <DialogTitle>{again ? "New remote passwords" : "Remote access passwords"}</DialogTitle>
              <DialogDescription>
                Both need the authenticator code too, and both are checked the same slow way. Use long ones: a few random
                words each.{again && " Every remote device will be signed out."}
              </DialogDescription>
            </DialogHeader>
            <input type="text" name="username" autoComplete="username" value="pupload remote" readOnly hidden />
            <PasswordPair
              id="basic"
              title="Basic password"
              hint="Files, links and the recycle bin. Secure folders stay invisible."
              value={basic}
              confirm={basic2}
              onValue={setBasic}
              onConfirm={setBasic2}
              autoFocus
            />
            <PasswordPair
              id="full"
              title="Full password"
              hint="Everything, secure folders included. It can open them, so make it at least as strong as the master password."
              value={full}
              confirm={full2}
              onValue={setFull}
              onConfirm={setFull2}
            />
            {errorLine}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "One moment…" : "Next"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form className="grid gap-4" onSubmit={finish}>
            <DialogHeader>
              <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <Smartphone className="size-5" />
              </div>
              <DialogTitle>Add to your authenticator</DialogTitle>
              <DialogDescription>
                Scan this with Google Authenticator, Aegis, 2FAS, 1Password or similar, then type the code it shows. Codes
                come from the time, not the network, so a changing IP never breaks them.
              </DialogDescription>
            </DialogHeader>
            {begin && (
              <div className="flex flex-col items-center gap-3">
                <QrCode text={begin.uri} />
                <button
                  type="button"
                  className="font-mono text-xs tracking-wider break-all text-muted-foreground hover:text-foreground"
                  title="Copy the key, to type it in by hand"
                  onClick={async () => toast[(await copyText(begin.secret)) ? "success" : "error"]("Key copied")}
                >
                  {begin.secret.match(/.{1,4}/g)?.join(" ")}
                </button>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="remote-code">Code from the app</Label>
              <Input
                id="remote-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                placeholder="123456"
                className="font-mono text-lg tracking-[0.35em] md:text-lg"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
            {errorLine}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep("passwords")}>
                Back
              </Button>
              <Button type="submit" disabled={busy || code.length !== 6}>
                {busy ? "Saving…" : "Turn on remote access"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PasswordPair({
  id,
  title,
  hint,
  value,
  confirm,
  onValue,
  onConfirm,
  autoFocus,
}: {
  id: string;
  title: string;
  hint: string;
  value: string;
  confirm: string;
  onValue: (v: string) => void;
  onConfirm: (v: string) => void;
  autoFocus?: boolean;
}) {
  const mismatch = confirm.length > 0 && confirm !== value;
  return (
    <fieldset className="grid gap-2 rounded-xl border bg-card p-3">
      <Label htmlFor={`remote-${id}`}>{title}</Label>
      <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>
      <Input
        id={`remote-${id}`}
        type="password"
        autoComplete="new-password"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onValue(e.target.value)}
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder="Type it again"
        aria-label={`${title}, again`}
        aria-invalid={mismatch}
        className={cn(mismatch && "border-destructive")}
        value={confirm}
        onChange={(e) => onConfirm(e.target.value)}
      />
    </fieldset>
  );
}
