#!/usr/bin/env bash
# Windows-safe local e2e runner (companion to scripts/run_e2e.sh, which is
# Linux/CI-oriented and would pkill the user's own processes).
#
# Safety contract — what this script will and will not touch:
#   * It NEVER kills chrome.exe broadly. Your own browsing is untouchable:
#     the only process it terminates is the headless Chrome IT launched
#     (via taskkill /T on that specific PID) and a vite it launched itself.
#   * The headless Chrome runs with its own --user-data-dir (fresh temp
#     profile per run), so it shares nothing with a running desktop Chrome.
#   * It uses debug port 9223 (CI's run_e2e.sh uses 9222) and, unless
#     YAPPER_URL is exported, boots its own vite on port 5179 — so it does
#     not fight an already-running dev server on 5173/5200.
#
# Usage:
#   bash scripts/run_e2e_windows.sh <label>          # boots its own vite
#   YAPPER_URL=http://127.0.0.1:5200/ bash scripts/run_e2e_windows.sh <label>
set -u

LABEL="${1:?usage: run_e2e_windows.sh <label> [port]}"
VITE_PORT="${YAPPER_VITE_PORT:-5179}"
CDP_PORT=9223
# Whether the CALLER supplied a server, captured before we fill in the
# default. The rest of this script exports YAPPER_URL, so a later
# `[ -z "$YAPPER_URL" ]` test would always be false — silently skipping the
# "boot our own vite" branch and pointing Chrome at a dead port, which
# surfaces as a blank page titled "127.0.0.1" rather than an obvious error.
CALLER_URL="${YAPPER_URL:-}"
URL="${CALLER_URL:-http://127.0.0.1:${VITE_PORT}/}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PROFILE_DIR="$(mktemp -d -t yapper-e2e-profile.XXXXXX)"
export YAPPER_CDP="http://127.0.0.1:${CDP_PORT}"
export YAPPER_URL="$URL"
export YAPPER_SHOTS="/tmp/yapper-shots-${LABEL}"
mkdir -p "$YAPPER_SHOTS"

# ── Locate a Chrome binary (Windows install paths + PATH) ──────────
find_chrome() {
  local candidates=(
    "/c/Program Files/Google/Chrome/Application/chrome.exe"
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
    "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"
  )
  for c in "${candidates[@]}"; do
    [ -f "$c" ] && { echo "$c"; return 0; }
  done
  command -v chrome.exe 2>/dev/null && return 0
  command -v chrome 2>/dev/null && return 0
  return 1
}

CHROME_BIN="$(find_chrome)" || { echo "No Chrome found; set CHROME_BIN manually." >&2; exit 1; }
echo "Chrome: $CHROME_BIN"
echo "Profile: $PROFILE_DIR (deleted on exit)"
echo "URL: $URL   CDP: $YAPPER_CDP"

DEV_PID=""
CHROME_WINPID=""
cleanup() {
  # Kill ONLY the processes this script started, by PID. Never by name.
  # NOTE: $! from Git Bash is the bash job PID, NOT chrome.exe's Windows
  # PID — taskkill on it silently does nothing and orphans the browser
  # (locked profile dirs, and the next run then connects to a stale ghost
  # on the debug port). Discover the real Windows PID from the listening
  # socket instead, recorded right after Chrome comes up.
  if [ -n "$CHROME_WINPID" ]; then
    taskkill //PID "$CHROME_WINPID" //T //F >/dev/null 2>&1
  fi
  if [ -n "$DEV_PID" ]; then
    kill "$DEV_PID" >/dev/null 2>&1
    # npm does not forward signals to the vite child it spawned, so reap the
    # real server too — found by the PID holding our own port, the same
    # discovery trick used for Chrome above. Deliberately not `pkill -f`:
    # Git Bash on Windows ships neither pkill nor pgrep, so that line fails
    # silently and every later run then finds the port occupied.
    sleep 1
    VITE_WINPID="$(netstat -ano | grep LISTENING | grep ":${VITE_PORT} " | awk '{print $5}' | head -1)"
    if [ -n "$VITE_WINPID" ]; then
      taskkill //PID "$VITE_WINPID" //T //F >/dev/null 2>&1
    fi
  fi
  # Chrome needs a moment to release its profile files before deletion.
  sleep 1
  rm -rf "$PROFILE_DIR" 2>/dev/null
}
trap cleanup EXIT

# A stale orphaned Chrome from a previous failed run would answer on the
# CDP port and poison this run (dead page, 0 model cards forever). Fail
# fast instead of testing against a ghost.
if curl -fsS --max-time 2 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "CDP port ${CDP_PORT} is already served by another Chrome (stale run?)." >&2
  echo "Kill it first, e.g.:  powershell \"Stop-Process -Id (Get-NetTCPConnection -LocalPort ${CDP_PORT} -State Listen).OwningProcess -Force\"" >&2
  exit 2
fi

# ── Dev server (only when the caller did not supply one) ────────────
if [ -z "$CALLER_URL" ]; then
  # Refuse to stomp an existing listener rather than killing it.
  if curl -fsS --max-time 2 "http://127.0.0.1:${VITE_PORT}/" >/dev/null 2>&1; then
    echo "Port ${VITE_PORT} already serves an app; set YAPPER_VITE_PORT or YAPPER_URL." >&2
    exit 2
  fi
  # --host 127.0.0.1 is not redundant: on this machine vite's default
  # "localhost" binds the IPv6 loopback only, so a curl to 127.0.0.1 is
  # refused and the readiness probe below times out against a server that
  # is actually running fine. Pin the address we are going to probe.
  npm run dev -- --port "$VITE_PORT" --strictPort --host 127.0.0.1 >/tmp/e2e-vite-${LABEL}.log 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${VITE_PORT}/src/main.ts" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -fsS "http://127.0.0.1:${VITE_PORT}/" >/dev/null 2>&1; then
    echo "dev server did not come up; log tail:" >&2
    tail -20 "/tmp/e2e-vite-${LABEL}.log" >&2
    exit 3
  fi
fi

# ── Isolated headless Chrome ────────────────────────────────────────
# A fresh temp profile means: no shared cookies/extensions with the user's
# Chrome, and no way for a bad run to corrupt the real profile.
"$CHROME_BIN" \
  --headless=new \
  --user-data-dir="$(cygpath -w "$PROFILE_DIR" 2>/dev/null || echo "$PROFILE_DIR")" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins='*' \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  --autoplay-policy=no-user-gesture-required \
  --window-size=1280,900 \
  about:blank >/tmp/e2e-chrome-${LABEL}.log 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome CDP did not come up on ${CDP_PORT}; log tail:" >&2
  tail -20 "/tmp/e2e-chrome-${LABEL}.log" >&2
  exit 4
fi

# Record chrome.exe's REAL Windows PID (owning process of the debug socket)
# so cleanup can actually kill it — $! above is a bash job PID on MSYS.
CHROME_WINPID=$(netstat -ano | grep LISTENING | grep ":${CDP_PORT} " | awk '{print $NF}' | head -1)
echo "Chrome Windows PID: ${CHROME_WINPID:-unknown}"

# ── Run the python driver ───────────────────────────────────────────
PYTHON="${YAPPER_PYTHON:-python}"
if ! "$PYTHON" -c "import websocket" >/dev/null 2>&1; then
  echo "python is missing the 'websocket-client' package." >&2
  echo "Install it with: ${PYTHON} -m pip install websocket-client" >&2
  exit 5
fi

"$PYTHON" e2e_test.py
rc=$?
exit $rc
