#!/usr/bin/env bash
# Start an isolated headless Chromium for t_a10117d7 verification.
# Private profile + dedicated debug port so other sessions' CDP runs
# can't navigate our tab mid-test.
pkill -f "remote-debugging-port=9333" 2>/dev/null || true
sleep 1

CHROME="/opt/hermes/.playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"

"$CHROME" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --user-data-dir=/tmp/yapper-capability-profile \
  --remote-debugging-port=9333 \
  --remote-debugging-address=127.0.0.1 \
  --disable-dev-shm-usage \
  --window-size=1280,900 \
  --disable-background-networking \
  --no-first-run \
  --disable-extensions \
  about:blank > /tmp/yapper-chrome-9333.log 2>&1 &

for i in $(seq 1 20); do
  if curl -s --max-time 2 http://127.0.0.1:9333/json/version > /tmp/yapper-cdp-9333.json; then
    echo "CDP ready:"
    cat /tmp/yapper-cdp-9333.json
    exit 0
  fi
  sleep 1
done
echo "CDP did not come up; log tail:"
tail -5 /tmp/yapper-chrome-9333.log
exit 1
