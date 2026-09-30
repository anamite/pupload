import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, KeyRound, Lock, LockOpen, Share, ShieldCheck, ShieldOff, Smartphone, SquarePlus } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { useVaultUi } from "@/components/vault/vault";
import { useAuthUi } from "@/components/remote/auth";
import { RemoteSection } from "@/components/remote/remote-section";
import { Field, Section, Segmented, SwitchRow } from "@/components/settings-parts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type Settings, type StorageOption, type Theme } from "@/lib/api";
import { deviceId, deviceName, guessDeviceName, setDeviceName } from "@/lib/device";
import { fmtSize } from "@/lib/format";
import { isIOS, isStandalone, useInstall } from "@/lib/pwa";
import { keys, refreshAll } from "@/lib/queries";
import { applyTheme, currentThemeChoice, THEMES } from "@/lib/theme";
import { cn } from "@/lib/utils";

const UNITS = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 } as const;
type Unit = keyof typeof UNITS;

function splitQuota(bytes: number | null): { amount: string; unit: Unit } {
  if (bytes === null) return { amount: "5", unit: "GB" };
  if (bytes >= UNITS.TB) return { amount: String(+(bytes / UNITS.TB).toFixed(2)), unit: "TB" };
  if (bytes >= UNITS.GB) return { amount: String(+(bytes / UNITS.GB).toFixed(2)), unit: "GB" };
  return { amount: String(Math.round(bytes / UNITS.MB)), unit: "MB" };
}

const SWATCH: Record<Theme, [string, string, string]> = {
  system: ["#f7f4ef", "#171b22", "#ef5a2a"],
  light: ["#f7f4ef", "#ffffff", "#ef5a2a"],
  slate: ["#171b22", "#20252e", "#f47a45"],
  ink: ["#000000", "#141414", "#f47a45"],
};

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen, settings, saveSettings, version } = useApp();
  const qc = useQueryClient();
  const auth = useAuthUi();
  // Signed in remotely with the basic password: where and how much is stored is off limits.
  const storageLocked = auth.remote && auth.tier !== "full";
  const install = useInstall();
  const [draft, setDraft] = React.useState<Settings>(settings);
  const [quota, setQuota] = React.useState(splitQuota(settings.quota_bytes));
  const [unlimited, setUnlimited] = React.useState(settings.quota_bytes === null);
  const [theme, setTheme] = React.useState<Theme>(currentThemeChoice());
  const [device, setDevice] = React.useState(deviceName());
  const [busy, setBusy] = React.useState(false);
  const themeAtOpen = React.useRef<Theme>(currentThemeChoice());

  const close = () => {
    applyTheme(themeAtOpen.current); // theme previews are undone unless saved
    setSettingsOpen(false);
  };

  const { data: options } = useQuery({
    queryKey: ["storage-options"],
    queryFn: async () => (await api<{ options: StorageOption[] }>("/api/storage-options")).options,
    enabled: settingsOpen && !storageLocked,
  });

  React.useEffect(() => {
    if (!settingsOpen) return;
    setDraft(settings);
    setQuota(splitQuota(settings.quota_bytes));
    setUnlimited(settings.quota_bytes === null);
    setTheme(currentThemeChoice());
    themeAtOpen.current = currentThemeChoice();
    setDevice(deviceName());
  }, [settingsOpen, settings]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    let quotaBytes: number | null = null;
    if (!unlimited) {
      const amount = parseFloat(quota.amount);
      if (!Number.isFinite(amount) || amount <= 0) return toast.error("Enter a storage limit");
      quotaBytes = Math.round(amount * UNITS[quota.unit]);
    }
    setBusy(true);
    try {
      const rootChanged = draft.storage_root !== settings.storage_root;
      await saveSettings({
        app_name: draft.app_name.trim() || "pupload",
        quota_bytes: quotaBytes,
        expiry_days: draft.expiry_days,
        expiry_mode: draft.expiry_mode,
        trash_days: draft.trash_days,
        storage_root: draft.storage_root.trim(),
        confirm_delete: draft.confirm_delete,
        thumbnails: draft.thumbnails,
        show_hidden: draft.show_hidden,
        theme,
        vault_hours: draft.vault_hours,
        remote_days: draft.remote_days,
      });
      setDeviceName(device);
      refreshAll(qc);
      qc.invalidateQueries({ queryKey: keys.config });
      if (rootChanged) location.hash = "#/files";
      toast.success("Settings saved");
      themeAtOpen.current = theme;
      setSettingsOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <Dialog open={settingsOpen} onOpenChange={(o) => (o ? setSettingsOpen(true) : close())}>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl sm:p-0">
        <DialogHeader className="border-b px-5 pt-3 pb-4 sm:px-6 sm:pt-6">
          <DialogTitle className="text-2xl">Settings</DialogTitle>
          <DialogDescription>Changes apply to everyone on the network, except the device name.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-7 px-5 py-5 sm:px-6">
          <Section title="Appearance">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTheme(t.id);
                    applyTheme(t.id);
                  }}
                  className={cn(
                    "rounded-xl border bg-card p-2 text-left transition-all hover:border-foreground/20",
                    theme === t.id && "border-primary ring-2 ring-primary/25",
                  )}
                >
                  <div className="flex h-12 overflow-hidden rounded-lg border" style={{ background: SWATCH[t.id][0] }}>
                    {t.id === "system" && <div className="w-1/2" style={{ background: SWATCH[t.id][1] }} />}
                    <div className="m-2 ml-auto flex flex-col justify-end gap-1">
                      <span className="block h-1.5 w-8 rounded-full" style={{ background: SWATCH[t.id][2] }} />
                      <span className="block h-1.5 w-5 rounded-full opacity-40" style={{ background: SWATCH[t.id][2] }} />
                    </div>
                  </div>
                  <div className="mt-2 text-sm font-medium">{t.label}</div>
                  <div className="text-[11px] text-muted-foreground">{t.hint}</div>
                </button>
              ))}
            </div>
            <Field label="Name shown in the app" htmlFor="set-name">
              <Input id="set-name" value={draft.app_name} maxLength={40} onChange={(e) => set("app_name", e.target.value)} />
            </Field>
          </Section>

          <Section title="This device" icon={Smartphone}>
            <Field
              label="Device name"
              htmlFor="set-device"
              hint="Shown next to everything you upload, save or delete from this browser."
            >
              <div className="flex gap-2">
                <Input id="set-device" value={device} maxLength={60} onChange={(e) => setDevice(e.target.value)} />
                <Button variant="outline" onClick={() => setDevice(guessDeviceName())}>
                  Auto
                </Button>
              </div>
            </Field>
            <p className="font-mono text-[11px] break-all text-muted-foreground">ID {deviceId()}</p>
          </Section>

          {!storageLocked && (
            <Section title="Storage" icon={HardDrive}>
              <Field label="Storage limit" htmlFor="set-quota">
                <div className="flex gap-2">
                  <Input
                    id="set-quota"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={quota.amount}
                    disabled={unlimited}
                    onChange={(e) => setQuota((q) => ({ ...q, amount: e.target.value }))}
                    className="flex-1"
                  />
                  <Segmented
                    value={quota.unit}
                    options={["MB", "GB", "TB"]}
                    disabled={unlimited}
                    onChange={(unit) => setQuota((q) => ({ ...q, unit: unit as Unit }))}
                  />
                </div>
              </Field>
              <SwitchRow label="No limit" hint="Use the whole disk, minus a small safety margin." checked={unlimited} onChange={setUnlimited} />

              <Field label="Where files are stored" hint="Existing files are not moved when you switch — copy them across yourself.">
                <div className="grid grid-cols-1 gap-1.5">
                  {(options ?? []).map((o) => (
                    <button
                      key={o.path}
                      disabled={!o.writable}
                      onClick={() => set("storage_root", o.path)}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
                        draft.storage_root === o.path && "border-primary bg-primary/5 hover:bg-primary/10",
                      )}
                    >
                      <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{o.label}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{o.path}</span>
                      </span>
                      {o.total > 0 && <span className="shrink-0 text-xs text-muted-foreground">{fmtSize(o.free)} free</span>}
                    </button>
                  ))}
                </div>
                <Input
                  className="mt-2 font-mono text-xs md:text-xs"
                  value={draft.storage_root}
                  onChange={(e) => set("storage_root", e.target.value)}
                  aria-label="Storage path"
                />
              </Field>
            </Section>
          )}

          <Section title="Expiry & recycle bin">
            <Field label="Files expire after" hint="Expired files go to the recycle bin. 0 keeps files forever. Folders and links never expire.">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={3650}
                  value={draft.expiry_days}
                  onChange={(e) => set("expiry_days", Math.max(0, parseInt(e.target.value || "0", 10)))}
                  className="w-28"
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            </Field>
            <SwitchRow
              label="Restart the countdown when a file is opened"
              hint="Files people keep using stick around longer."
              checked={draft.expiry_mode === "accessed"}
              onChange={(on) => set("expiry_mode", on ? "accessed" : "created")}
            />
            <Field label="Keep deleted items in the recycle bin for" hint="After this, they are deleted forever. You can always empty the bin by hand.">
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  value={String(draft.trash_days)}
                  options={["7", "30", "90", "0"]}
                  labels={{ "0": "Until emptied" }}
                  onChange={(v) => set("trash_days", parseInt(v, 10))}
                />
                <Input
                  type="number"
                  min={0}
                  max={3650}
                  value={draft.trash_days}
                  onChange={(e) => set("trash_days", Math.max(0, parseInt(e.target.value || "0", 10)))}
                  className="w-24"
                  aria-label="Recycle bin days"
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            </Field>
          </Section>

          <VaultSection hours={draft.vault_hours} onHours={(h) => set("vault_hours", h)} />
          <RemoteSection days={draft.remote_days} onDays={(d) => set("remote_days", d)} />

          <Section title="Behaviour">
            <SwitchRow label="Ask before moving things to the bin" checked={draft.confirm_delete} onChange={(v) => set("confirm_delete", v)} />
            <SwitchRow label="Image thumbnails" hint="Turn off on very small Pi models." checked={draft.thumbnails} onChange={(v) => set("thumbnails", v)} />
            <SwitchRow label="Show hidden files" checked={draft.show_hidden} onChange={(v) => set("show_hidden", v)} />
          </Section>

          <Section title="Install on your phone or tablet" icon={SquarePlus}>
            {isStandalone() ? (
              <p className="text-sm text-muted-foreground">You are using the installed app.</p>
            ) : install.available ? (
              <Button onClick={() => install.install()} className="w-fit">
                <SquarePlus /> Install {settings.app_name}
              </Button>
            ) : isIOS() ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                In Safari, tap <Share className="inline size-4 align-text-bottom" /> <b className="text-foreground">Share</b>, then{" "}
                <b className="text-foreground">Add to Home Screen</b>. It opens full screen like an app.
              </p>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                In Chrome, open the <b className="text-foreground">⋮</b> menu and choose{" "}
                <b className="text-foreground">Add to Home screen</b> (or <b className="text-foreground">Install app</b>). Android only offers a
                full install over HTTPS — see the README for a one-command Tailscale setup.
              </p>
            )}
          </Section>

          <p className="text-center font-mono text-[11px] text-muted-foreground">pupload {version}</p>
        </div>

        <DialogFooter className="sticky bottom-0 border-t bg-popover/95 px-5 py-3 backdrop-blur sm:px-6">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VaultSection({ hours, onHours }: { hours: number; onHours: (h: number) => void }) {
  const vault = useVaultUi();
  const { remote } = useAuthUi();
  const status = vault.status;
  // Remotely, the sign-in decides about secure folders (see Remote access).
  if (!status || status.hidden || remote) return null;
  return (
    <Section title="Secure folders" icon={ShieldCheck}>
      {!status.available ? (
        <p className="text-sm text-muted-foreground">
          Not available: the Pi is missing the <code className="font-mono text-xs">cryptography</code> package. Run the
          installer again to add it.
        </p>
      ) : !status.configured ? (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Secure folders are encrypted on the Pi and stay locked until you enter one master password. Other devices on
            the network see them greyed out, and someone who takes the SD card or drive cannot read them.
          </p>
          <Button className="w-fit" onClick={() => vault.ensureUnlocked()}>
            <ShieldCheck /> Set up secure folders
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                status.unlocked ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              {status.unlocked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">{status.unlocked ? "Unlocked on this device" : "Locked on this device"}</div>
              {status.unlocked && status.expires && (
                <div className="text-xs text-muted-foreground">
                  until {new Date(status.expires * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                </div>
              )}
            </div>
            {status.unlocked ? (
              <Button variant="outline" size="sm" onClick={() => vault.lock()}>
                Lock
              </Button>
            ) : (
              <Button size="sm" onClick={() => vault.ensureUnlocked()}>
                Unlock
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => vault.changePassword()}>
              <KeyRound /> Change password
            </Button>
            <Button variant="outline" size="sm" onClick={() => vault.recover()}>
              Forgot password?
            </Button>
            {status.unlocked && (
              <Button variant="outline" size="sm" onClick={() => vault.lock(true)}>
                <ShieldOff /> Lock every device
              </Button>
            )}
          </div>
          <Field label="Stay unlocked for" hint="After this, a device has to enter the password again. Restarting the Pi locks everything.">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={String(hours)}
                options={["1", "12", "24", "168"]}
                labels={{ "1": "1 hour", "12": "12 hours", "24": "1 day", "168": "1 week" }}
                onChange={(v) => onHours(parseInt(v, 10))}
              />
              <Input
                type="number"
                min={1}
                max={720}
                value={hours}
                onChange={(e) => onHours(Math.min(720, Math.max(1, parseInt(e.target.value || "1", 10))))}
                className="w-24"
                aria-label="Hours to stay unlocked"
              />
              <span className="text-sm text-muted-foreground">hours</span>
            </div>
          </Field>
        </>
      )}
    </Section>
  );
}
