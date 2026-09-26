# pupload

A shared drive for your home network. Open the Pi's address on any phone,
tablet or laptop: drop files in, save links, and everything is there for
everyone else on the network. No accounts, no cloud.

* **Files** expire after 30 days by default. Folders and links never expire.
* **Links**: save as many as you like, with notes and tags. They stay until you delete them.
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
3. uses the prebuilt web interface when it matches the code. Otherwise it makes sure
   **Node.js 20+** is present (from apt, NodeSource or nodejs.org, whichever works on
   your Pi) and builds the React interface
4. picks a **port**: 8080, or the next free one if another program already uses it
5. registers a **systemd service**, so pupload runs in the background and starts on boot,
   then checks that it actually answers
6. prints the address to open, e.g. `http://192.168.1.42:8080` and `http://raspberrypi.local:8080`

If Node.js can't be installed (a Pi Zero or Pi 1 with an ARMv6 CPU, for example), the
installer falls back to the prebuilt interface in `app/web`, so pupload still works.

### Updating

Run the same one-line command again (or `~/pupload/install.sh`). It:

* downloads the new version and continues with the installer that came with it
* **never touches your files, links, recycle bin or settings**. `data/` and your storage
  folder are outside the program files and are ignored by git
* backs up `config.json` and the database to `data/backups/` first (the last five are kept)
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

## Settings

Everything is under the gear icon (or **More → Settings** on phones) and applies right away.

* **Theme**: Auto (follows the device), Paper (warm light), Slate (soft dark) or Ink (true black for OLED).
* **Storage limit**: a size in MB/GB/TB, or no limit. Uploads stop the moment they would cross it.
* **Where files are stored**: pick another disk (USB drives under `/media`, `/mnt`) or type a path.
* **Auto-expiry**: days until a file expires (0 = never). Expired files go to the recycle bin,
  not straight to deletion. Optionally the countdown restarts whenever a file is opened.
* **Recycle bin**: how long deleted items are kept (7 / 30 / 90 days, or until you empty it).

The recycle bin lives inside the storage folder (`.pupload-trash`), so deleting even a huge
folder is instant. Items in the bin still use disk space, and they count towards the limit
until the bin is emptied.

---

## A note on access

There is no login, by design. Anyone who can reach the address can read, upload and
delete (deletes are recoverable from the recycle bin). That's fine on a home network, but
don't port-forward pupload to the internet. For remote access use a VPN or Tailscale.

Uploads can't escape the storage folder, and saved links may only use `http(s)`, `ftp`,
`smb`, `magnet`, `mailto` or `tel`. Only images, audio, video, PDFs and plain text are shown
inline; everything else downloads with `nosniff`, so an uploaded HTML file can't run scripts.

---

## Development

```bash
# backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
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
run.py                  launcher (prints the LAN address)
app/
  main.py               HTTP routes, range requests, streamed ZIP, links, recycle bin
  storage.py            safe paths, listings, quota, expiry
  trash.py              recycle bin: move in, restore, purge
  links.py              link validation and page-title lookup
  config.py             settings + disk discovery
  db.py                 SQLite: file metadata (incl. device), links, recycle bin index
  web/                  built React app (generated by `npm run build`)
tools/ui_source_hash.py fingerprint of the UI sources (installer skips rebuilds when it matches)
frontend/
  src/components/ui/    shadcn/ui components
  src/components/       files, links, bin, layout, settings
  src/lib/              API client, uploads queue, audio player, device ID, theme, PWA
  public/               manifest, service worker, icons
data/                   config.json, pupload.db, files/, backups/ (not in git)
```
