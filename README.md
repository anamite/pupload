# pupload

A shared drive for your home network. Open the Pi's address on any phone,
tablet or laptop: drop files in, save links, and everything is there for
everyone else on the network. No accounts, no cloud, and encrypted secure
folders for the things that aren't for everyone.

* **Files** expire after 30 days by default. Folders and links never expire.
* **Links**: save as many as you like, with notes and tags. They stay until you delete them.
* **Secure folders**: encrypted folders, greyed out and locked until you enter one master
  password. Their files and names are encrypted on the Pi, so they stay private from
  other people on the network *and* from anyone who takes the SD card or drive.
* **Private space**: markdown notes (link files and folders with `[[ ]]`), voice memos,
  named lists with due dates and reminders, and a calendar that imports and exports `.ics`.
  It only exists on devices that unlocked secure folders, and it's encrypted the same way.
* **Remote access** through a Cloudflare tunnel, behind a password *and* an authenticator
  code. There are two passwords: the basic one opens the drive with secure folders invisible,
  and the full one opens everything. The home network stays login-free.
* **Recycle bin**: deleted files, folders and links wait 30 days (configurable), with
  restore, delete-forever and *Empty bin*.
* **Device tracking**: every upload, link and delete records which device did it.
* **Folders download as ZIP.** Selecting several items downloads them as one ZIP too.
  The ZIP is streamed, so size does not matter.
* **Works on phones, tablets and desktops**, and installs as an app on Android, iPhone and iPad.
* React + shadcn/ui + lucide on the front, Starlette + SQLite on the Pi. Uploads and
  downloads stream, so a 4 GB video uses as little memory as a 4 KB note.

---

## Install on a Raspberry Pi — one line

```bash
curl -fsSL https://raw.githubusercontent.com/anamite/pupload/main/install.sh | bash
```

That's all you need. The installer:

1. clones pupload into `~/pupload`, or updates it if it's already there
2. sets up a Python environment from the **system** Python (not an active conda/pyenv
   one, so the service never depends on your shell setup) and installs Pillow for thumbnails
3. installs `cryptography` for secure folders (if that fails, everything else still works)
4. uses the prebuilt web interface when it matches the code. Otherwise it makes sure
   **Node.js 20+** is present (from apt, NodeSource or nodejs.org, whichever works on
   your Pi) and builds the React interface
5. picks a **port**: 8080, or the next free one if another program already uses it
6. registers a **systemd service**, so pupload runs in the background and starts on boot,
   then checks that it actually answers
7. prints the address to open, e.g. `http://192.168.1.42:8080` and `http://raspberrypi.local:8080`

If Node.js can't be installed (a Pi Zero or Pi 1 with an ARMv6 CPU, for example), the
installer falls back to the prebuilt interface in `app/web`, so pupload still works.

### Updating

Run the same one-line command again (or `~/pupload/install.sh`). It:

* downloads the new version and continues with the installer that came with it
* **never touches your files, links, recycle bin or settings**. `data/` and your storage
  folder are outside the program files and are ignored by git
* backs up `config.json`, `vault.json` and the database to `data/backups/` first (the last five are kept)
* upgrades the database in place with numbered migrations, each applied once. The server
  also snapshots the database before it migrates
* rebuilds the interface only if its code changed, into a side folder that's swapped in when
  complete, so the running app never serves a half-built page
* keeps the same port, and restarts the service only if something actually changed
* prints `pupload updated: 2.0.0 -> 2.1.0`

Pages already open on phones show a *"pupload has been updated — Reload"* message.

| Option | Effect |
| --- | --- |
| `--port=9000` | preferred port (default 8080). If it's taken, the next free one is used |
| `--remote-port=8090` | port for [remote access](#remote-access-from-anywhere) (default 8090, only on `127.0.0.1`; `0` turns it off). If it's taken, the next free one is used and then kept (it's in `data/remote-port`), because your tunnel points at it. **Settings → Remote access** shows the port in use |
| `--dir=/srv/pupload` | where to install when using the curl one-liner |
| `--no-service` | set up only; don't install the background service |
| `--no-thumbnails` | skip Pillow (image thumbnails) |
| `--skip-build` | never rebuild the UI; use the prebuilt `app/web` |
| `--force` | rebuild the UI and restart even if nothing changed |

The server checks its port too: if another program grabs it later (after a reboot, say),
pupload moves to the next free port, logs it, and writes it to `data/port`.
`journalctl -u pupload -n 20` shows the address it's using.

Pass options through the one-liner with `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/anamite/pupload/main/install.sh | bash -s -- --port=9000
```

### Service management

```bash
systemctl status pupload
sudo systemctl restart pupload
journalctl -u pupload -f
```

---

## Install as an app (PWA)

* **iPhone / iPad**: open the address in Safari, then tap **Share → Add to Home Screen**.
  It opens full screen like a normal app.
* **Android**: in Chrome, open **⋮ → Add to Home screen**.

Android only offers a *full* install (its own window, plus appearing in the share
sheet so you can share links straight into pupload) when the site is served over
**HTTPS**. The easiest way to get that at home is [Tailscale](https://tailscale.com):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8080
```

Then open the `https://<pi-name>.<tailnet>.ts.net` address it prints, on devices signed in
to your tailnet. This also gives you safe access when you're away from home.

---

## Using it

| Action | How |
| --- | --- |
| Upload | **Upload** button (files or a whole folder), drag files anywhere onto the page, or **+** on phones. Uploads survive bad Wi-Fi: see below |
| Open / play | Tap a file. Audio plays in a mini player while you keep browsing; images, video, PDFs and text open full screen (swipe or arrow keys to move between them) |
| Actions | **⋮** on any item, right-click on desktop, or long-press on touch screens |
| Select several | Tick the checkboxes (Shift-click selects a range), then Download, Move or Delete |
| Move by dragging | Drag items onto a folder (desktop) |
| Download a folder | **⋮ → Download as ZIP**. Folders only download as ZIP |
| Keep a file forever | **⋮ → Keep forever** stops its countdown |
| Who uploaded it? | Shown on every card and row; **⋮ → Details** shows the device name, network address and device ID |
| My uploads | Sidebar → *My uploads* lists everything sent from the device you're on |
| Links | Paste a link and press Enter. The page title is filled in automatically. Add notes and tags, pin to top |
| Undo a delete | Every delete shows an **Undo** button, and the **Recycle bin** keeps items for 30 days |

Keyboard: `/` search, `u` upload, `Ctrl+A` select all, `Delete` delete selection, `Esc` clear.

Each browser gets a random device ID and a readable name like "Android phone · Chrome".
Rename your device in **Settings → This device**.

### When a connection drops mid-upload

Files are sent in 8 MB pieces into a hidden staging area on the Pi. A file only appears in
its folder once every byte has arrived, so nobody ever sees a half file.

* **Wi-Fi blip, phone locked, Pi restarted**: the upload shows *Reconnecting…*, retries with
  increasing waits (or waits until the phone is back online), asks the Pi how much it
  already has, and continues from there. Nothing is sent twice.
* **A silent connection** (a phone that went to sleep mid-piece) is dropped by the Pi after
  60 seconds. Whatever arrived is kept.
* **Tab closed or page reloaded**: the browser asks before leaving while uploads are running.
  If you leave anyway, add the same files to the same folder again within 24 hours and they
  resume where they stopped.
* **Folders**: every file in a folder upload is handled on its own. Finished files stay, and
  unfinished ones resume.
* **Gave up** (about ten minutes offline): the file shows an error with a retry button, and
  retry resumes too.
* Unfinished uploads count towards the storage limit while they wait, and are cleared away
  automatically after 24 hours. **Cancel** removes them straight away.

---

## Secure folders

Everything else in pupload is open to anyone on your network. A **secure folder** is the
exception: it shows up greyed out with a lock, and nobody can open, download, rename, move
or delete it until the master password is entered on their device.

**Set up once.** Choose **New folder ▾ → New secure folder** (or **+ → New secure folder**
on a phone, or **Settings → Secure folders**). The first time, you pick a master password
and get a **recovery key**. Save it: if you forget the password, the recovery key is the
only way back in. Without either, nobody can recover the files, including you.

**Unlock once, see everything.** One password opens every secure folder. Tap a locked
folder (or the lock in the top bar), enter the password, and that device can open every
secure folder until the unlock expires (12 hours by default, **Settings → Secure folders →
Stay unlocked for**), you press **Lock**, or the Pi restarts. Other devices stay locked
until they enter the password too. **Lock every device** ends all unlocks at once.

Inside a secure folder everything works as usual (upload, play, view, ZIP download, move,
recycle bin), with a few differences:

* files in secure folders never auto-expire, and there's no *Copy link* (a link opens only
  on unlocked devices)
* moving something into a secure folder encrypts it, and moving it out decrypts it (the
  Pi needs room for a copy while it does that)
* search, *Recent*, *Media* and *My uploads* only include secure files on unlocked devices
* on a locked device, secure items in the recycle bin appear as *Locked item*, and *Empty
  bin* leaves them in place
* deleting a normal folder that has a secure folder somewhere inside also needs secure
  folders unlocked, and in the recycle bin it's treated as a secure item

### What it protects, and what it doesn't

* **Someone on your network**: they see that a secure folder exists, but can't open it,
  list what's inside, or change or delete it.
* **Someone who takes the SD card or drive**: file contents *and* names inside secure
  folders are encrypted with AES-256-GCM. The key that decrypts them is stored only wrapped
  by your password (scrypt) in `data/vault.json`, and the unwrapped key exists only in the
  Pi's memory while some device is unlocked. Thumbnails of secure images are kept in memory,
  never on disk. On disk you can still see the secure folder's own name, how many files it
  holds and roughly how big they are.
* **Not covered**: someone who can log into the Pi, or grab its memory, *while it is
  unlocked*; someone who secretly modifies the SD card and puts it back, then waits for you
  to type the password; and a weak password (a copied card can be attacked offline, so use
  a few random words). Swap on the SD card could, rarely, hold decrypted data. Switch it off
  or to zram for the strongest setup (`sudo dphys-swapfile swapoff && sudo systemctl disable
  dphys-swapfile`).
* **Plain HTTP**: on a normal home network your password travels unencrypted over Wi-Fi.
  Serve pupload over HTTPS (for example with the Tailscale command above) if that matters.
  The unlock cookie is HttpOnly and SameSite=Strict, and is marked Secure over HTTPS.
* **Changing the password** re-wraps the same key, so files don't need re-encrypting.
  Older copies of `vault.json` in `data/backups/` still open with the *old* password.
  Delete them if that password was exposed.
* **Keep `data/vault.json` safe.** If it's lost, secure folders can't be decrypted, even
  with the password. The installer backs it up with the database.

Guessing is slowed down: each try costs a scrypt computation, and after five wrong
passwords a device has to wait before trying again, longer after each further miss.

---

## Private space: notes, voice memos, lists, calendar

Once a device has unlocked secure folders (or signed in remotely with the *full* password),
a **Private** group appears in the sidebar (on phones: **More**). Everywhere else it doesn't
exist: no menu entries, nothing in search or the recycle bin, and the server answers as if
there were nothing there. Everything in it is encrypted with the secure folders' key.

* **Notes** are markdown: headings, **bold**, lists, tables, code and `- [ ]` checklists you
  can tick in the preview. The title is the first two words until you type your own (the
  wand button goes back to automatic). Link anything in the drive with `[[Docs/cv.pdf]]` or
  `[[Photos/2024]]` (type `[[` or use the paperclip to pick it); `[[path|label]]` sets the
  text, and `![[Photos/cat.jpg]]` shows an image inline. Tapping a link opens the file or
  folder. Notes save as you type.
* **Voice memos** record in the browser and are encrypted as they upload. Browsers only allow
  the microphone over **HTTPS** (the Tailscale address or remote access); on a plain
  `http://` address use **Phone recorder** or **Add audio files** instead.
* **Lists** have a name and items. Tap an item to edit it, give it a date (and optionally a
  time) for a reminder, and paste several lines at once to add them all.
* **Calendar**: month view with the day's agenda. Events can be all-day or timed, repeat
  (daily, weekly on chosen days, monthly, yearly, until a date or a number of times) and
  have up to five reminders. List items with a date show up here too and can be ticked off.
  **⋮ → Import an .ics file** adds events from any calendar export (importing the same file
  again updates instead of doubling), **Export** downloads them, and `.ics` files stored in
  the drive have **Add to calendar** in their menu.

**Reminders** ring on every device where pupload is open and unlocked: a message in the app,
and a system notification once you allow it (**Calendar → ⋮ → Turn on notifications**,
HTTPS only). A reminder that was missed while the app was closed still rings if it's under an
hour late. The Pi can't read your reminders while it's locked, so it can't send them to a
closed app; that is the trade-off for keeping them encrypted.

Deleted notes, lists, events and memos go to the recycle bin like everything else (they
only show there when unlocked). On disk: records live in `pupload.db` (table `private`, one
AES-GCM blob per record, only its kind and change time readable) and memos in
`<storage>/.pupload-private/`. Memos count towards the storage limit.

## Remote access from anywhere

pupload listens on two ports, both served by the same program:

| Port | Who reaches it | Login |
| --- | --- | --- |
| **8080** (home network) | anyone on your Wi-Fi | none, as before |
| **8090** (remote) | only programs on the Pi itself (`127.0.0.1`), i.e. a tunnel | password **and** authenticator code |

A tunnel (Cloudflare Tunnel is free) connects a public HTTPS address such as
`https://drive.example.com` to port 8090. Nothing is opened on your router, and nothing
on the internet can reach port 8080.

### Two passwords, one authenticator

* **Basic password + code**: files, links and the recycle bin. Secure folders don't exist
  as far as this sign-in is concerned: they aren't listed, searched, zipped or reachable by
  path, and it can't delete a folder that holds one. It can't change where or how much is
  stored.
* **Full password + code**: everything, with secure folders unlocked.

Both are checked the same way. Every try costs one scrypt computation whichever password
is typed, and every mistake gets the same *"Wrong password or code"* reply, so a wrong try
never reveals which part was wrong or which password came close. The code comes from any
authenticator app (Google Authenticator, Aegis, 2FAS, 1Password…). It is based on the
time, not on your IP address or network, so switching from Wi-Fi to mobile data never
breaks it. Each code works only once.

### Set it up

1. At home, open **Settings → Remote access → Set up remote access**. Secure folders need to
   be set up and unlocked on that device first, because the full password has to be able
   to open them. You'll be asked for the master password if needed.
2. Choose the two passwords (10+ characters, different from each other; the basic one can't
   be the master password), scan the QR code with your authenticator app and type the code
   it shows.
3. Connect a tunnel on the Pi (below), open its address on your phone, and sign in.

Remote access can only be set up, changed or turned off from the home network. The same
section lists every signed-in remote device, and has **Sign out every remote device**,
**New passwords or authenticator** (lost phone: do this from home) and **Turn off**.

### Connect a Cloudflare tunnel

Install `cloudflared` on the Pi:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

**Try it** (a temporary `*.trycloudflare.com` address, no account needed; it lasts until you
press Ctrl+C):

```bash
cloudflared tunnel --url http://127.0.0.1:8090
```

**Keep it** (your own domain on Cloudflare, starts on boot): in the Cloudflare dashboard open
**Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*), run the
`sudo cloudflared service install …` command it shows on the Pi, then add a **public
hostname** such as `drive.example.com` with service **HTTP** and URL `127.0.0.1:8090`.

* Point the tunnel at **8090**, never at 8080: 8080 has no login.
* You don't need a Cloudflare Access application (the emailed one-time codes). pupload's own
  sign-in replaces it.
* The tunnel address is HTTPS, so Android offers the full app install from it too.

### What protects it

* **Two factors**: a stolen password is useless without your phone, and a code is useless
  without the password.
* **Guessing**: after 5 wrong tries an address has to wait (5 s, then doubling, up to 15 min).
  If many addresses fail together (a botnet), everyone slows to one try every 10 seconds.
  At most two password checks run at once, so a flood of sign-in attempts can't use up the
  Pi's memory. Cloudflare's network absorbs denial-of-service floods before they reach
  your Pi, and its free plan can add a rate-limiting rule for `/api/auth/login` and Bot
  Fight Mode if you want more.
* **Sessions**: an HttpOnly, Secure, SameSite=Strict cookie. Cross-site requests are
  refused, pages can't be framed, and search engines are told not to index them. A basic
  sign-in lasts 2 weeks (Settings → Remote access) and survives restarts. A full sign-in
  lasts as long as secure folders stay unlocked (12 hours by default). It ends when the Pi
  restarts, and **Lock every device** ends it too.
* **On the SD card** (`data/remote.json`): the TOTP secret, a scrypt-derived check for the
  basic password, and the secure folders' key wrapped by the full password (just like
  `vault.json` does with the master password). So the full password matters as much as the
  master password: make it long.
* The remote port refuses anything it doesn't need: setting up remote access, changing the
  master password and unlocking with it are home-network only.
* The Pi's clock has to be right for codes to work. Raspberry Pi OS syncs it over the
  internet automatically.
* A basic sign-in can see the storage gauge's totals, which include secure files.

## Settings

Everything is under the gear icon (or **More → Settings** on phones) and applies right away.

* **Theme**: Auto (follows the device), Paper (warm light), Slate (soft dark) or Ink (true black for OLED).
* **Storage limit**: a size in MB/GB/TB, or no limit. Uploads stop the moment they would cross it.
* **Where files are stored**: pick another disk (USB drives under `/media`, `/mnt`) or type a path.
* **Auto-expiry**: days until a file expires (0 = never). Expired files go to the recycle bin,
  not straight to deletion. Optionally the countdown restarts whenever a file is opened.
* **Recycle bin**: how long deleted items are kept (7 / 30 / 90 days, or until you empty it).
* **Secure folders**: set up, lock or unlock, change the password, reset it with the
  recovery key, and choose how long an unlock lasts.
* **Remote access**: set up the two passwords and the authenticator, see who is signed in,
  sign everyone out, and choose how long a basic sign-in lasts.

The recycle bin lives inside the storage folder (`.pupload-trash`), so deleting even a huge
folder is instant. Items in the bin still use disk space, and they count towards the limit
until the bin is emptied.

---

## A note on access

There is no login on the home-network port, by design. Anyone who can reach it can read,
upload and delete (deletes are recoverable from the recycle bin). Put anything private in a
[secure folder](#secure-folders). That's fine on a home network, but never port-forward it to
the internet. For access from outside, use [remote access](#remote-access-from-anywhere)
through a tunnel, or a VPN such as Tailscale.

Uploads can't escape the storage folder, and saved links may only use `http(s)`, `ftp`,
`smb`, `magnet`, `mailto` or `tel`. Only images, audio, video, PDFs and plain text are shown
inline; everything else downloads with `nosniff`, so an uploaded HTML file can't run scripts.

---

## Development

```bash
# backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-secure.txt
.venv/bin/python run.py --port 8080

# frontend with hot reload (proxies /api to :8080)
cd frontend && npm install && npm run dev
npm run typecheck
npm run build        # writes to app/web, which the server serves
```

On Windows use `.venv\Scripts\python run.py`.

## Layout

```
install.sh              one-line installer / updater (+ systemd service)
run.py                  launcher: the home-network port and the remote port, in one process
app/
  main.py               HTTP routes, range requests, streamed ZIP, links, recycle bin
  storage.py            safe paths (real names <-> encrypted on-disk names), listings, quota, expiry
  vault.py              secure folders: keys, encrypted file format, sessions
  private.py            private space: notes, lists, events, voice memos (encrypted records)
  ical.py               .ics import and export for the calendar
  remote.py             remote access: two passwords, authenticator codes, sign-ins, throttling
  trash.py              recycle bin: move in, restore, purge
  links.py              link validation and page-title lookup
  config.py             settings + disk discovery
  db.py                 SQLite: file metadata (incl. device), links, recycle bin index
  web/                  built React app (generated by `npm run build`)
tools/ui_source_hash.py fingerprint of the UI sources (installer skips rebuilds when it matches)
frontend/
  src/components/ui/    shadcn/ui components
  src/components/       files, links, bin, layout, settings, private (notes, memos, lists, calendar)
  src/lib/              API client, uploads queue, audio player, device ID, theme, PWA
  public/               manifest, service worker, icons
data/                   config.json, vault.json, remote.json, pupload.db, files/, backups/ (not in git)
```
