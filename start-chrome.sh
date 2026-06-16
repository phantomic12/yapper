#!/bin/bash
# Start Chrome for yapper testing
pkill -f "chrome.*remote-debugging" 2>/dev/null || true
sleep 2

chromium \
  --no-sandbox \
  --disable-gpu \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --disable-dev-shm-usage \
  --window-size=1280,720 \
  --disable-background-networking \
  --no-first-run \
  --disable-extensions \
  about:blank &

sleep 3

echo "=== Chrome version ==="
curl -s http://127.0.0.1:9222/json/version | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))"

echo "=== Tabs ==="
curl -s http://127.0.0.1:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); [print(f\"  {t['id']}: {t['url']}\") for t in tabs]"
