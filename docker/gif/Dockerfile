FROM nvidia/cuda:13.3.1-base-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics
ENV NVIDIA_VISIBLE_DEVICES=all

# Base + chromium + Vulkan + ffmpeg + Python + Playwright deps
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        ca-certificates curl wget gnupg \
        python3 python3-pip python3-venv \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxrandr2 libxext6 libxfixes3 \
        libxss1 libasound2 libgbm1 libpango-1.0-0 libcairo2 \
        # Xvfb + X11 utilities for headed-Chromium GPU testing.
        # We need an actual display surface for Chromium's GPU process
        # to expose navigator.gpu (headless mode hides the GPU
        # compositor entirely).
        xvfb xauth libx11-6 libxcb1 libxrandr2 libxkbcommon0 \
        mesa-vulkan-drivers vulkan-tools \
        chromium-browser ffmpeg \
        fonts-liberation fonts-dejavu && \
    rm -rf /var/lib/apt/lists/*

# Install playwright + python deps. Ubuntu 22.04 ships Python 3.10
# which has pip 22.x with --break-system-packages, so we just install
# system-wide and accept the warning. Pillow + playwright are the only
# Python deps; everything else (chromium, ffmpeg) is via apt.
RUN pip3 install --no-cache-dir playwright==1.61.0 pillow || \
    pip3 install --no-cache-dir --break-system-packages playwright==1.61.0 pillow || \
    (apt-get install -y -qq python3-pip && pip3 install --no-cache-dir --break-system-packages playwright==1.61.0 pillow)

# Pre-install playwright chromium (it ships its own)
RUN python3 -m playwright install chromium

WORKDIR /capture
COPY capture.py /capture/capture.py
COPY gpu_smoke_test.py /capture/gpu_smoke_test.py

# Default to the demo capture script; pass a different command (e.g.
# `python3 /capture/gpu_smoke_test.py`) to run the GPU smoke test
# instead. See scripts/capture-gif.sh for both entry points.
ENTRYPOINT ["python3", "/capture/capture.py"]
