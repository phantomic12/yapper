#!/bin/bash
# GPU-accelerated demo GIF capture for yapper.
# Runs the docker container, copies artifacts out, cleans up.
#
# Usage: bash scripts/capture-gif.sh
# Or: YAPPER_DEMO_FORCE_SYNTH=1 to skip the model load and use a fake
#     "loaded" state for the screenshot (faster, no model download)

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="$(pwd)/out"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/demo.gif" "$OUT_DIR/demo.mp4" "$OUT_DIR/frames"/*.png 2>/dev/null || true
mkdir -p "$OUT_DIR/frames"

# Build the docker image if not present
if ! /mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe image inspect yapper-gif-capture >/dev/null 2>&1; then
    echo "=== building yapper-gif-capture image ==="
    /mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe build -t yapper-gif-capture docker/gif/
fi

CONTAINER_NAME="yapper-gif-run-$(date +%s)"

echo "=== running container $CONTAINER_NAME (no --rm so we can docker cp out) ==="
# Run WITHOUT --rm so the container persists after exit; we'll docker cp from it.
# The Windows volume mount is unreliable, so we use cp as the primary extraction.
/mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe run \
    --gpus all \
    --name "$CONTAINER_NAME" \
    yapper-gif-capture 2>&1 | tail -30 || true

if ! /mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe ps -a --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
    echo "container not found, aborting"
    exit 1
fi

echo "=== copying artifacts out ==="
/mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe cp "$CONTAINER_NAME:/capture/out/demo.gif" "$OUT_DIR/demo.gif" 2>&1 | head -3
/mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe cp "$CONTAINER_NAME:/capture/out/demo.mp4" "$OUT_DIR/demo.mp4" 2>&1 | head -3
/mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe cp "$CONTAINER_NAME:/capture/out/frames/." "$OUT_DIR/frames/" 2>&1 | head -3
/mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe cp "$CONTAINER_NAME:/capture/out/webgpu-info.json" "$OUT_DIR/webgpu-info.json" 2>&1 | head -3

echo "=== cleaning up container ==="
/mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe rm "$CONTAINER_NAME" 2>&1 | head -2

echo
echo "=== artifacts ==="
ls -la "$OUT_DIR/"
ls -la "$OUT_DIR/frames/" 2>/dev/null | head -10
echo
echo "GIF:  $OUT_DIR/demo.gif"
echo "MP4:  $OUT_DIR/demo.mp4"
echo "Frames:  $OUT_DIR/frames/"
