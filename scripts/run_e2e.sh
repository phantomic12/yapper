#!/usr/bin/env bash
# Local e2e runner. Boots a fresh `npm run dev` server (Vite) plus a current
# headless Chromium driven over raw CDP, then runs e2e_test.py against them.
# Chrome is launched with --autoplay-policy=no-user-gesture-required so the
# reader's audio.play() behaves like a user-initiated one.
#
# Usage: bash scripts/run_e2e.sh <label> [url]
set -u
LABEL="${1:?run label required}"
URL="${2:-http://127.0.0.1:5173/}"
CHROME_BIN="${YAPPER_CHROME_BIN:-$(echo /opt/data/.pw-browsers/chromium-*/chrome-linux*/chrome)}"
export YAPPER_CDP="http://127.0.0.1:9222"
export YAPPER_URL="$URL"
export YAPPER_SHOTS="/tmp/yapper-shots-${LABEL}"
cd "$(dirname "$0")/.."

# Kill any leftover Chrome/vite that could steal our ports, then verify the
# ports actually freed (a stale listener here poisons the whole run with
# confusing '#app not mounted' / connection-refused failures).
pkill -f "remote-debugging-port=9222" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 1
if ss -tln 2>/dev/null | grep -qE ':(5173|9222) '; then
  echo "ports 5173/9222 still busy after cleanup:" >&2
  ss -tlnp 2>/dev/null | grep -E ':(5173|9222)' >&2
  exit 2
fi

cleanup() {
  kill "$CHROME_PID" "$DEV_PID" 2>/dev/null
  # npm does not forward signals to the vite child it spawned, so reap
  # the actual server process too or it lingers holding the port.
  pkill -f "vite --port 5173" 2>/dev/null
  wait "$CHROME_PID" "$DEV_PID" 2>/dev/null
}
trap cleanup EXIT

# Dev server: --host binds all interfaces so 127.0.0.1 always works
# regardless of how Node resolves localhost (IPv6 vs IPv4).
npm run dev -- --port 5173 --strictPort --host >/tmp/e2e-vite-${LABEL}.log 2>&1 &
DEV_PID=$!
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:5173/src/main.ts >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS http://127.0.0.1:5173/ >/dev/null 2>&1; then
  echo "dev server did not come up; log tail:" >&2
  tail -20 "/tmp/e2e-vite-${LABEL}.log" >&2
  exit 3
fi

"$CHROME_BIN" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --headless=new \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --no-first-run \
  --autoplay-policy=no-user-gesture-required \
  about:blank >/tmp/e2e-chrome-${LABEL}.log 2>&1 &
CHROME_PID=$!

for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
  sleep 1
done

uv run --quiet --with websocket-client python3 e2e_test.py
rc=$?
exit $rc
