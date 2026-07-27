FROM nvidia/cuda:12.4.0-base-ubuntu22.04

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

# Run with GPU passthrough
ENTRYPOINT ["python3", "/capture/capture.py"]
