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

1. clones pupload into `~/pupload` (or updates it if it's already there)
2. installs Python's venv, the Python packages, and Pillow for thumbnails
3. makes sure **Node.js 20+** is present (from apt, NodeSource or nodejs.org, whichever
   works on your Pi) and builds the React interface
4. registers a **systemd service**, so pupload runs in the background and starts on boot
5. prints the address to open, e.g. `http://192.168.1.42:8080` and `http://raspberrypi.local:8080`

Run the same command again, or `~/pupload/install.sh`, to **update**.

If Node.js can't be installed (a Pi Zero or Pi 1 with an ARMv6 CPU, for example), the
installer falls back to the prebuilt interface in `app/web`, so pupload still works.

| Option | Effect |
| --- | --- |
| `--port=9000` | serve on a different port (default 8080) |
| `--dir=/srv/pupload` | where to install when using the curl one-liner |
| `--no-service` | set up only; don't install the background service |
| `--no-thumbnails` | skip Pillow (image thumbnails) |
| `--skip-build` | don't rebuild the UI; use the prebuilt `app/web` |

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
| Upload | **Upload** button (files or a whole folder), drag files anywhere onto the page, or **+** on phones |
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
frontend/
  src/components/ui/    shadcn/ui components
  src/components/       files, links, bin, layout, settings
  src/lib/              API client, uploads queue, audio player, device ID, theme, PWA
  public/               manifest, service worker, icons
data/                   config.json, pupload.db, files/ (not in git)
```
