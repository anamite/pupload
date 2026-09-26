#!/usr/bin/env bash
# pupload installer / updater for Raspberry Pi OS, Debian and Ubuntu.
#
# One line, from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/anamite/pupload/main/install.sh | bash
# or from a checkout:
#   ./install.sh
#
# It installs everything it needs (Python venv, Node.js for the web UI build,
# git), builds the React interface, and runs pupload in the background as a
# systemd service that starts on boot. Run it again at any time to update.
#
# Options:
#   --port=8080        port to serve on (default 8080)
#   --dir=PATH         where to put pupload when installing via curl (default ~/pupload)
#   --no-service       set everything up but do not install the background service
#   --no-thumbnails    skip Pillow (image thumbnails); useful on a Pi Zero
#   --skip-build       do not rebuild the web UI; use the prebuilt copy in app/web
set -euo pipefail

REPO_URL="https://github.com/anamite/pupload.git"
PORT="${PUPLOAD_PORT:-8080}"
SERVICE=1
THUMBS=1
BUILD=1
TARGET_DIR=""
ARGS=("$@")

for arg in "$@"; do
  case "$arg" in
    --port=*) PORT="${arg#*=}" ;;
    --dir=*) TARGET_DIR="${arg#*=}" ;;
    --service) SERVICE=1 ;;
    --no-service) SERVICE=0 ;;
    --thumbnails) THUMBS=1 ;;
    --no-thumbnails) THUMBS=0 ;;
    --skip-build) BUILD=0 ;;
    -h|--help) sed -n '2,21p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $arg (see --help)"; exit 1 ;;
  esac
done

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

# ---------------------------------------------------------------------------
# 1. Find (or fetch) the source
# ---------------------------------------------------------------------------
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/run.py" ] && [ -d "$SCRIPT_DIR/app" ]; then
  HERE="$SCRIPT_DIR"
else
  # Running from `curl | bash`: clone or update the repository, then re-run from it.
  HERE="${TARGET_DIR:-$HOME/pupload}"
  step "Getting pupload into $HERE"
  command -v git >/dev/null || apt_install git ca-certificates
  if [ -d "$HERE/.git" ]; then
    git -C "$HERE" checkout -q -- app/web frontend/package-lock.json 2>/dev/null || true
    git -C "$HERE" pull -q --ff-only
  else
    git clone -q --depth 1 "$REPO_URL" "$HERE"
  fi
  exec env PUPLOAD_NO_PULL=1 bash "$HERE/install.sh" "${ARGS[@]}"
fi
cd "$HERE"

if [ -d "$HERE/.git" ] && [ -z "${PUPLOAD_NO_PULL:-}" ] && command -v git >/dev/null; then
  if git -C "$HERE" remote get-url origin >/dev/null 2>&1; then
    step "Checking for updates"
    BEFORE="$(git -C "$HERE" rev-parse HEAD 2>/dev/null || true)"
    git -C "$HERE" checkout -q -- app/web frontend/package-lock.json 2>/dev/null || true
    git -C "$HERE" pull -q --ff-only || warn "Could not update from git (continuing with the local copy)"
    if [ "$BEFORE" != "$(git -C "$HERE" rev-parse HEAD 2>/dev/null || true)" ]; then
      echo "   updated — restarting the installer with the new version"
      exec env PUPLOAD_NO_PULL=1 bash "$HERE/install.sh" "${ARGS[@]}"
    fi
    echo "   already up to date"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Python
# ---------------------------------------------------------------------------
step "Checking Python"
command -v python3 >/dev/null || apt_install python3
if ! python3 -c "import venv, ensurepip" >/dev/null 2>&1; then
  echo "   installing python3-venv"
  apt_install python3-venv python3-pip
fi
python3 - <<'PY' || die "Python 3.8 or newer is required"
import sys
sys.exit(0 if sys.version_info >= (3, 8) else 1)
PY
echo "   $(python3 --version)"

step "Setting up the Python environment"
[ -x "$HERE/.venv/bin/python" ] || python3 -m venv "$HERE/.venv"
"$HERE/.venv/bin/pip" install -q --upgrade pip
"$HERE/.venv/bin/pip" install -q -r "$HERE/requirements.txt"
if [ "$THUMBS" = 1 ]; then
  echo "   adding Pillow for image thumbnails"
  "$HERE/.venv/bin/pip" install -q -r "$HERE/requirements-optional.txt" \
    || warn "Pillow did not install; thumbnails fall back to full images"
fi

# ---------------------------------------------------------------------------
# 3. Node.js + the React web interface
# ---------------------------------------------------------------------------
NODE_MIN=20

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

build_ui() {
  cd "$HERE/frontend"
  if ! npm ci --no-audit --no-fund --loglevel=error; then
    warn "npm ci failed, retrying with a fresh install"
    rm -rf node_modules
    npm install --no-audit --no-fund --loglevel=error || return 1
  fi
  if ! npm run build --silent; then
    # A native build helper for this CPU can be missing from a lockfile made elsewhere.
    warn "build failed, reinstalling packages for this platform and retrying"
    rm -rf node_modules package-lock.json
    npm install --no-audit --no-fund --loglevel=error && npm run build --silent || return 1
  fi
  cd "$HERE"
}

if [ "$BUILD" = 1 ]; then
  step "Checking Node.js (needed to build the web interface)"
  if ! node_ok; then
    install_node || warn "Could not install Node.js $NODE_MIN+ on this machine"
  fi
  if node_ok; then
    echo "   node $(node --version), npm $(npm --version)"
    step "Building the web interface"
    if build_ui; then
      echo "   built into app/web"
    else
      cd "$HERE"
      git -C "$HERE" checkout -q -- app/web 2>/dev/null || true
      [ -f "$HERE/app/web/index.html" ] || die "The web interface could not be built and no prebuilt copy exists"
      warn "Build failed — using the prebuilt web interface that ships with pupload"
    fi
  else
    [ -f "$HERE/app/web/index.html" ] || die "Node.js $NODE_MIN+ is needed to build the web interface"
    warn "Using the prebuilt web interface that ships with pupload"
  fi
else
  [ -f "$HERE/app/web/index.html" ] || die "--skip-build given but app/web is missing"
  echo "   using the prebuilt web interface"
fi

mkdir -p "$HERE/data/files"
if [ "$(id -u)" -eq 0 ] && [ "$RUN_USER" != "root" ]; then
  chown -R "$RUN_USER" "$HERE"
fi

# ---------------------------------------------------------------------------
# 4. Background service
# ---------------------------------------------------------------------------
if [ "$SERVICE" = 1 ]; then
  if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
    step "Installing the background service (starts on boot)"
    $SUDO tee /etc/systemd/system/pupload.service >/dev/null <<UNIT
[Unit]
Description=pupload - shared drive for the home network
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${HERE}
Environment=PUPLOAD_PORT=${PORT}
Environment=PYTHONUNBUFFERED=1
ExecStart=${HERE}/.venv/bin/python ${HERE}/run.py --port ${PORT}
Restart=always
RestartSec=3
Nice=5

[Install]
WantedBy=multi-user.target
UNIT
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable -q pupload
    $SUDO systemctl restart pupload

    printf "   waiting for pupload to answer"
    UP=0
    for _ in $(seq 1 30); do
      if python3 -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:${PORT}/api/stats', timeout=2)" >/dev/null 2>&1; then
        UP=1
        break
      fi
      printf "."
      sleep 1
    done
    echo
    if [ "$UP" = 1 ]; then
      echo "   service is running"
    else
      warn "pupload did not answer yet — check: journalctl -u pupload -n 50"
    fi
  else
    warn "systemd not found; start pupload by hand (see below)"
    SERVICE=0
  fi
fi

# ---------------------------------------------------------------------------
# 5. Where to find it
# ---------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${IP:-}" ] || IP="127.0.0.1"
HOST="$(hostname 2>/dev/null || echo raspberrypi)"

echo
bold "  pupload is ready"
echo
echo "    Open on any phone, tablet or computer on this network:"
bold "      http://${IP}:${PORT}"
echo "      http://${HOST}.local:${PORT}"
echo
echo "    On a phone: open the address, then \"Add to Home screen\" to install it as an app."
echo
if [ "$SERVICE" = 1 ]; then
  echo "    Runs in the background and starts on boot."
  echo "      status:   systemctl status pupload"
  echo "      logs:     journalctl -u pupload -f"
  echo "      restart:  sudo systemctl restart pupload"
  echo "      update:   ${HERE}/install.sh"
else
  echo "    Start it with:"
  echo "      ${HERE}/.venv/bin/python ${HERE}/run.py --port ${PORT}"
fi
echo
