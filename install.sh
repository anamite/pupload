#!/usr/bin/env bash
# pupload installer / updater for Raspberry Pi OS, Debian and Ubuntu.
#
# One line, from anywhere (installs, or updates an existing install):
#   curl -fsSL https://raw.githubusercontent.com/anamite/pupload/main/install.sh | bash
# or from a checkout:
#   ./install.sh
#
# Safe to run again at any time. It only ever touches the program files:
# your files, links, recycle bin and settings (everything in data/ and your
# storage folder) are left alone, and the database is backed up before any
# update. The service is only restarted when something actually changed.
#
# Options:
#   --port=8080        preferred port; if another program uses it, the next free one is taken
#   --remote-port=8090 port for remote access through a tunnel (127.0.0.1 only; 0 = off)
#   --dir=PATH         where to put pupload when installing via curl (default ~/pupload)
#   --no-service       set everything up but do not install the background service
#   --no-thumbnails    skip Pillow (image thumbnails); useful on a Pi Zero
#   --skip-build       never rebuild the web UI; use the prebuilt copy in app/web
#   --force            rebuild and restart even if nothing changed
set -euo pipefail

REPO_URL="https://github.com/anamite/pupload.git"
DEFAULT_PORT=8080
PORT=""
REMOTE_PORT=""
SERVICE=1
THUMBS=1
BUILD=auto
FORCE=0
TARGET_DIR=""
ARGS=("$@")

for arg in "$@"; do
  case "$arg" in
    --port=*) PORT="${arg#*=}" ;;
    --remote-port=*) REMOTE_PORT="${arg#*=}" ;;
    --dir=*) TARGET_DIR="${arg#*=}" ;;
    --service) SERVICE=1 ;;
    --no-service) SERVICE=0 ;;
    --thumbnails) THUMBS=1 ;;
    --no-thumbnails) THUMBS=0 ;;
    --skip-build) BUILD=never ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $arg (see --help)"; exit 1 ;;
  esac
done
if [ -n "$PORT" ] && ! [[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]]; then
  echo "--port must be a number between 1 and 65535"; exit 1
fi
if [ -n "$REMOTE_PORT" ] && ! [[ "$REMOTE_PORT" =~ ^[0-9]+$ && "$REMOTE_PORT" -le 65535 ]]; then
  echo "--remote-port must be a number between 0 and 65535"; exit 1
fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;38;5;202m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*"; exit 1; }

RUN_USER="${SUDO_USER:-$(id -un)}"
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null || die "sudo is required (or run as root)"
  SUDO="sudo"
fi

# Run a command as root, keeping the environment (sudo -E), or directly when already root.
as_root() {
  if [ -n "$SUDO" ]; then sudo -E "$@"; else "$@"; fi
}

APT_UPDATED=0
apt_install() {
  command -v apt-get >/dev/null || die "apt-get not found; install these by hand: $*"
  if [ "$APT_UPDATED" = 0 ]; then
    $SUDO apt-get update -qq
    APT_UPDATED=1
  fi
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
}

# Use the system Python, not a conda/pyenv one that may be active in this
# shell: the background service must not depend on a user environment.
pick_python() {
  local p
  for p in /usr/bin/python3 /usr/local/bin/python3 "$(command -v python3 2>/dev/null || true)"; do
    [ -n "$p" ] && [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------------------
# 1. Find (or fetch) the program
# ---------------------------------------------------------------------------
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# Put generated/build files back to the committed state so `git pull` never
# trips over them. Only program files are touched — data/ is ignored by git.
reset_generated() {
  rm -rf "$1/app/web.next" "$1/app/web.old"
  git -C "$1" clean -fdq -- app/web 2>/dev/null || true
  git -C "$1" checkout -q -- app/web frontend/package-lock.json 2>/dev/null || true
}

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/run.py" ] && [ -d "$SCRIPT_DIR/app" ]; then
  HERE="$SCRIPT_DIR"
else
  # Running from `curl | bash`: clone, or update the existing copy, then re-run from it.
  HERE="${TARGET_DIR:-$HOME/pupload}"
  command -v git >/dev/null || apt_install git ca-certificates
  OLD_VERSION="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$HERE/app/__init__.py" 2>/dev/null || echo "?")"
  if [ -d "$HERE/.git" ]; then
    step "Updating pupload in $HERE"
    reset_generated "$HERE"
    git -C "$HERE" pull -q --ff-only ||
      warn "Could not update from GitHub (offline, or local edits to program files). Continuing with the local copy."
  elif [ -f "$HERE/run.py" ]; then
    # An older copy put there by hand: turn it into a git checkout in place.
    # Untracked files (data/, .venv) are kept as they are.
    step "Converting the existing copy in $HERE to an updatable install"
    git -C "$HERE" init -q
    git -C "$HERE" remote add origin "$REPO_URL" 2>/dev/null || git -C "$HERE" remote set-url origin "$REPO_URL"
    git -C "$HERE" fetch -q --depth 1 origin main
    git -C "$HERE" checkout -q -f -B main origin/main
    git -C "$HERE" branch -q --set-upstream-to=origin/main main
  else
    step "Downloading pupload into $HERE"
    git clone -q --depth 1 "$REPO_URL" "$HERE"
  fi
  # Continue with the installer that came with this version.
  exec env PUPLOAD_NO_PULL=1 PUPLOAD_VERSION_BEFORE="$OLD_VERSION" bash "$HERE/install.sh" "${ARGS[@]}"
fi
cd "$HERE"

PY="$(pick_python)" || { apt_install python3; PY="$(pick_python)" || die "python3 not found"; }

VERSION_BEFORE="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$HERE/app/__init__.py" 2>/dev/null || echo "?")"
if [ -d "$HERE/.git" ] && [ -z "${PUPLOAD_NO_PULL:-}" ]; then
  command -v git >/dev/null || apt_install git ca-certificates
  if git -C "$HERE" remote get-url origin >/dev/null 2>&1; then
    step "Checking for updates"
    BEFORE="$(git -C "$HERE" rev-parse HEAD 2>/dev/null || true)"
    reset_generated "$HERE"
    if git -C "$HERE" pull -q --ff-only; then
      if [ "$BEFORE" != "$(git -C "$HERE" rev-parse HEAD)" ]; then
        echo "   downloaded a new version — continuing with it"
        # The installer itself may have changed: run the new one.
        exec env PUPLOAD_NO_PULL=1 PUPLOAD_VERSION_BEFORE="$VERSION_BEFORE" bash "$HERE/install.sh" "${ARGS[@]}"
      fi
      echo "   already the latest version"
    else
      warn "Could not update from GitHub (offline, or local edits to program files). Continuing with this copy."
    fi
  fi
fi
VERSION_BEFORE="${PUPLOAD_VERSION_BEFORE:-$VERSION_BEFORE}"
VERSION_NOW="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$HERE/app/__init__.py" 2>/dev/null || echo "?")"

# ---------------------------------------------------------------------------
# 2. Back up the database and settings (files themselves are never touched)
# ---------------------------------------------------------------------------
if [ -f "$HERE/data/pupload.db" ] || [ -f "$HERE/data/config.json" ] || [ -f "$HERE/data/vault.json" ]; then
  step "Backing up your settings and database"
  "$PY" - "$HERE/data" <<'PY'
import shutil, sqlite3, sys, time
from pathlib import Path
data = Path(sys.argv[1])
dest = data / "backups" / time.strftime("install-%Y%m%d-%H%M%S")
dest.mkdir(parents=True, exist_ok=True)
for name in ("config.json", "vault.json"):   # vault.json: secure folders' wrapped key
    if (data / name).exists():
        shutil.copy2(data / name, dest / name)
if (data / "pupload.db").exists():
    src = sqlite3.connect(str(data / "pupload.db"))
    out = sqlite3.connect(str(dest / "pupload.db"))
    src.backup(out)          # consistent copy even while pupload is running
    out.close(); src.close()
runs = sorted(p for p in (data / "backups").glob("install-*") if p.is_dir())
for old in runs[:-5]:        # keep the last five
    shutil.rmtree(old, ignore_errors=True)
print(f"   saved to {dest}")
PY
fi

# ---------------------------------------------------------------------------
# 3. Python environment
# ---------------------------------------------------------------------------
step "Checking Python"
if ! "$PY" -c "import venv, ensurepip" >/dev/null 2>&1; then
  echo "   installing python3-venv"
  apt_install python3-venv python3-pip
fi
"$PY" -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" || die "Python 3.8 or newer is required"
echo "   $("$PY" --version) ($PY)"

# Rebuild the venv if it is missing, broken, or was made from another Python (e.g. conda).
VENV_OK=0
if [ -x "$HERE/.venv/bin/python" ] && "$HERE/.venv/bin/python" -c "import sys" >/dev/null 2>&1; then
  VENV_HOME="$(sed -n 's/^home *= *//p' "$HERE/.venv/pyvenv.cfg" 2>/dev/null || true)"
  [ "$VENV_HOME" = "$(dirname "$PY")" ] && VENV_OK=1
fi
if [ "$VENV_OK" = 0 ]; then
  echo "   creating the Python environment"
  rm -rf "$HERE/.venv"
  "$PY" -m venv "$HERE/.venv"
fi
"$HERE/.venv/bin/pip" install -q --disable-pip-version-check --upgrade pip
"$HERE/.venv/bin/pip" install -q --disable-pip-version-check -r "$HERE/requirements.txt"
"$HERE/.venv/bin/pip" install -q --disable-pip-version-check -r "$HERE/requirements-secure.txt"   || warn "cryptography did not install; secure folders are unavailable (everything else works)"
if [ "$THUMBS" = 1 ]; then
  "$HERE/.venv/bin/pip" install -q --disable-pip-version-check -r "$HERE/requirements-optional.txt" \
    || warn "Pillow did not install; thumbnails fall back to full images"
fi

# ---------------------------------------------------------------------------
# 4. Web interface: rebuild only when its sources changed
# ---------------------------------------------------------------------------
NODE_MIN=20
UI_REBUILT=0

node_ok() {
  command -v node >/dev/null && command -v npm >/dev/null &&
    [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MIN" ]
}

node_arch() {
  case "$(uname -m)" in
    aarch64|arm64) echo arm64 ;;
    armv7l) echo armv7l ;;
    x86_64|amd64) echo x64 ;;
    *) echo "" ;;
  esac
}

install_node() {
  # a) the distribution's own package, when it is new enough (Debian 13 / Pi OS trixie)
  if command -v apt-cache >/dev/null; then
    local cand
    cand="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}' | sed -E 's/^[0-9]+://; s/[^0-9].*//')"
    if [ -n "$cand" ] && [ "$cand" -ge "$NODE_MIN" ] 2>/dev/null; then
      echo "   installing nodejs $cand from apt"
      apt_install nodejs npm && node_ok && return 0
    fi
  fi
  # b) NodeSource packages (Debian 12 / Pi OS bookworm ship Node 18)
  command -v curl >/dev/null || apt_install curl ca-certificates
  echo "   installing Node.js 22 from NodeSource"
  if curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash - >/dev/null 2>&1 &&
     $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null 2>&1 && node_ok; then
    return 0
  fi
  # c) official binaries from nodejs.org (covers 32-bit armv7 Pi OS)
  local arch file
  arch="$(node_arch)"
  [ -n "$arch" ] || return 1
  echo "   installing Node.js 22 ($arch) from nodejs.org"
  file="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk "/linux-${arch}.tar.xz\$/ {print \$2}")"
  [ -n "$file" ] || return 1
  command -v xz >/dev/null || apt_install xz-utils
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$file" | $SUDO tar -xJ -C /usr/local --strip-components=1 &&
    hash -r && node_ok
}

# Build into a side folder and swap it in at the end, so the running server
# keeps serving the old interface until the new one is complete.
build_ui() {
  local next="$HERE/app/web.next"
  rm -rf "$next"
  cd "$HERE/frontend"
  if ! npm ci --no-audit --no-fund --loglevel=error; then
    warn "npm ci failed, retrying with a fresh install"
    rm -rf node_modules
    npm install --no-audit --no-fund --loglevel=error || { cd "$HERE"; return 1; }
  fi
  if ! npx vite build --logLevel warn --outDir "$next" --emptyOutDir; then
    # A native build helper for this CPU can be missing from a lockfile made elsewhere.
    warn "build failed, reinstalling packages for this platform and retrying"
    rm -rf node_modules package-lock.json
    { npm install --no-audit --no-fund --loglevel=error &&
      npx vite build --logLevel warn --outDir "$next" --emptyOutDir; } || { cd "$HERE"; rm -rf "$next"; return 1; }
  fi
  cd "$HERE"
  [ -f "$next/index.html" ] || return 1
  rm -rf "$HERE/app/web.old"
  [ -d "$HERE/app/web" ] && mv "$HERE/app/web" "$HERE/app/web.old"
  mv "$next" "$HERE/app/web"
  rm -rf "$HERE/app/web.old"
}

step "Checking the web interface"
UI_SOURCE="$("$PY" "$HERE/tools/ui_source_hash.py" 2>/dev/null || echo unknown)"
UI_BUILT="$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['source'])" "$HERE/app/web/build-info.json" 2>/dev/null || echo none)"
NEED_BUILD=0
if [ "$BUILD" = never ]; then
  [ -f "$HERE/app/web/index.html" ] || die "--skip-build given but app/web is missing"
elif [ "$UI_SOURCE" != "$UI_BUILT" ] || [ ! -f "$HERE/app/web/index.html" ] || [ "$FORCE" = 1 ]; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" = 0 ]; then
  echo "   up to date (prebuilt for this version) — no build needed"
else
  if ! node_ok; then
    echo "   Node.js $NODE_MIN+ is needed to build it"
    install_node || warn "Could not install Node.js $NODE_MIN+ on this machine"
  fi
  if node_ok; then
    echo "   building with node $(node --version) — this takes a minute or two on a Pi"
    if build_ui; then
      UI_REBUILT=1
      echo "   done"
    else
      reset_generated "$HERE"
      [ -f "$HERE/app/web/index.html" ] || die "The web interface could not be built and no prebuilt copy exists"
      warn "Build failed — using the prebuilt web interface that ships with pupload"
    fi
  else
    [ -f "$HERE/app/web/index.html" ] || die "Node.js $NODE_MIN+ is needed to build the web interface"
    warn "Using the prebuilt web interface that ships with pupload"
  fi
fi

mkdir -p "$HERE/data/files"
if [ "$(id -u)" -eq 0 ] && [ "$RUN_USER" != "root" ]; then
  chown -R "$RUN_USER" "$HERE"
fi

# ---------------------------------------------------------------------------
# 5. Pick a port: keep pupload's current one, else the first free one
# ---------------------------------------------------------------------------
UNIT=/etc/systemd/system/pupload.service
port_state() {  # prints: pupload | free | busy
  "$PY" - "$1" <<'PY'
import json, socket, sys, urllib.request
port = int(sys.argv[1])
for path in ("/api/ping", "/api/config"):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as res:
            data = json.load(res)
        if data.get("app") == "pupload" or ("settings" in data and "version" in data):
            print("pupload"); sys.exit()
    except Exception:
        pass
# Something accepting connections (on any address) means the port is taken.
for host in ("127.0.0.1", "::1"):
    try:
        socket.create_connection((host, port), timeout=1).close()
        print("busy"); sys.exit()
    except OSError:
        pass
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("0.0.0.0", port))
    print("free")
except OSError:
    print("busy")
finally:
    s.close()
PY
}

WANT="$PORT"
if [ -z "$WANT" ] && [ -f "$UNIT" ]; then
  WANT="$(sed -n 's/^Environment=PUPLOAD_PORT=\([0-9]*\)$/\1/p' "$UNIT" | head -1)"
fi
WANT="${WANT:-$DEFAULT_PORT}"
if [ -z "$REMOTE_PORT" ] && [ -f "$UNIT" ]; then
  REMOTE_PORT="$(sed -n 's/^Environment=PUPLOAD_REMOTE_PORT=\([0-9]*\)$/\1/p' "$UNIT" | head -1)"
fi
REMOTE_PORT="${REMOTE_PORT:-8090}"
CANDIDATES=("$WANT")
[ -f "$HERE/data/port" ] && CANDIDATES=("$(tr -dc 0-9 < "$HERE/data/port")" "$WANT")

step "Choosing a port"
CHOSEN=""
for p in "${CANDIDATES[@]}"; do
  [ -n "$p" ] && [ "$(port_state "$p")" = pupload ] && { CHOSEN="$p"; echo "   keeping $p (pupload is already there)"; break; }
done
if [ -z "$CHOSEN" ]; then
  for p in $(seq "$WANT" $((WANT + 50))); do
    [ "$p" = "$REMOTE_PORT" ] && continue   # kept for remote access
    case "$(port_state "$p")" in
      free|pupload) CHOSEN="$p"; break ;;
      busy) echo "   port $p is used by another program" ;;
    esac
  done
fi
[ -n "$CHOSEN" ] || die "No free port between $WANT and $((WANT + 50)); try --port=9000"
[ "$CHOSEN" = "$WANT" ] || echo "   using port $CHOSEN"
[ "$CHOSEN" = "$WANT" ] && echo "   port $CHOSEN"
PORT="$CHOSEN"

# ---------------------------------------------------------------------------
# 6. Background service
# ---------------------------------------------------------------------------
check_up() {  # is pupload answering on the given port?
  [ "$(port_state "$1")" = pupload ]
}

if [ "$SERVICE" = 1 ]; then
  if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
    step "Background service (starts on boot)"
    NEW_UNIT="$(cat <<UNITEOF
[Unit]
Description=pupload - shared drive for the home network
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${HERE}
Environment=PUPLOAD_PORT=${PORT}
Environment=PUPLOAD_REMOTE_PORT=${REMOTE_PORT}
Environment=PYTHONUNBUFFERED=1
ExecStart=${HERE}/.venv/bin/python ${HERE}/run.py --port ${PORT} --remote-port ${REMOTE_PORT}
Restart=always
RestartSec=3
Nice=5

[Install]
WantedBy=multi-user.target
UNITEOF
)"
    UNIT_CHANGED=0
    if [ ! -f "$UNIT" ] || [ "$(cat "$UNIT")" != "$NEW_UNIT" ]; then
      printf '%s\n' "$NEW_UNIT" | $SUDO tee "$UNIT" >/dev/null
      $SUDO systemctl daemon-reload
      UNIT_CHANGED=1
    fi
    $SUDO systemctl enable -q pupload

    INSTALLED="$(cat "$HERE/data/.installed" 2>/dev/null || true)"
    CURRENT="$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo "$VERSION_NOW")"
    if [ "$FORCE" = 1 ] || [ "$UNIT_CHANGED" = 1 ] || [ "$UI_REBUILT" = 1 ] || [ "$INSTALLED" != "$CURRENT" ] ||
       ! systemctl is-active -q pupload || ! check_up "$PORT"; then
      echo "   (re)starting pupload"
      $SUDO systemctl restart pupload
    else
      echo "   nothing changed — left running"
    fi

    printf "   waiting for pupload to answer"
    UP=0
    for _ in $(seq 1 40); do
      ACTUAL="$(tr -dc 0-9 < "$HERE/data/port" 2>/dev/null || true)"
      if check_up "${ACTUAL:-$PORT}"; then UP=1; PORT="${ACTUAL:-$PORT}"; break; fi
      printf "."
      sleep 1
    done
    echo
    if [ "$UP" = 1 ]; then
      echo "   running on port $PORT"
      printf '%s\n' "$CURRENT" > "$HERE/data/.installed"
    else
      warn "pupload is not answering. Last lines of its log:"
      $SUDO journalctl -u pupload -n 25 --no-pager 2>/dev/null || true
      echo
      die "Fix the problem above, then run this installer again (or: sudo systemctl restart pupload)"
    fi
  else
    warn "systemd not found; start pupload by hand (see below)"
    SERVICE=0
  fi
fi

# ---------------------------------------------------------------------------
# 7. Where to find it
# ---------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${IP:-}" ] || IP="127.0.0.1"
HOST="$(hostname 2>/dev/null || echo raspberrypi)"

echo
if [ "$VERSION_BEFORE" != "$VERSION_NOW" ] && [ "$VERSION_BEFORE" != "?" ]; then
  bold "  pupload updated: $VERSION_BEFORE -> $VERSION_NOW"
else
  bold "  pupload $VERSION_NOW is ready"
fi
echo
echo "    Open on any phone, tablet or computer on this network:"
bold "      http://${IP}:${PORT}"
echo "      http://${HOST}.local:${PORT}"
echo
echo "    On a phone: open the address, then \"Add to Home screen\" to install it as an app."
echo
if [ "$REMOTE_PORT" != 0 ]; then
  # The port may have moved on if something else had it; data/remote-port says where it went.
  REMOTE_ACTUAL="$(awk '{print $2}' "$HERE/data/remote-port" 2>/dev/null | tr -dc 0-9 || true)"
  echo "    Remote access (password + authenticator code), for a Cloudflare tunnel:"
  echo "      http://127.0.0.1:${REMOTE_ACTUAL:-$REMOTE_PORT}   set it up in Settings -> Remote access, then see the README"
  echo
fi
if [ "$SERVICE" = 1 ]; then
  echo "    Runs in the background and starts on boot."
  echo "      status:   systemctl status pupload"
  echo "      logs:     journalctl -u pupload -f"
  echo "      update:   run the same install command again"
else
  echo "    Start it with:"
  echo "      ${HERE}/.venv/bin/python ${HERE}/run.py --port ${PORT} --remote-port ${REMOTE_PORT}"
fi
echo
