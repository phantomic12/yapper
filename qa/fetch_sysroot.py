#!/usr/bin/env python3
"""Download debs for Firefox/WebKit runtime deps and extract into qa/.sysroot."""
import os
import subprocess
import sys

PKGS = [
    # GTK/Wayland core for Firefox
    "libgtk-3-0t64",
    "libx11-xcb1", "libxcb-shm0", "libxcb1", "libxcomposite1",
    "libxdamage1", "libxext6", "libxfixes3", "libxrandr2", "libxkbcommon0",
    "libwayland-client0", "libwayland-cursor0", "libwayland-egl1",
    "libdrm2", "libgbm1", "libasound2t64", "libatk1.0-0t64",
    "libatk-bridge2.0-0t64", "libatspi2.0-0t64", "libcups2t64",
    "libpango-1.0-0", "libpangocairo-1.0-0", "libpangoft2-1.0-0",
    "libcairo2", "libgdk-pixbuf-2.0-0", "libcloudproviders0",
    "libcolord2", "libepoxy0", "libxdmcp6", "libbsd0", "libmd0",
    "libxml2", "shared-mime-info",
    # NSS newer than trixie's (Firefox needs NSS_3.113)
    "libnss3",
]

# NSS 3.114 (satisfies NSS_3.113) fetched separately from snapshot.debian.org:
#   https://snapshot.debian.org/archive/debian/20250723T023903Z/pool/main/n/nss/libnss3_3.114-1_amd64.deb

DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".debs")
SYSROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".sysroot")
os.makedirs(DEST, exist_ok=True)
os.makedirs(SYSROOT, exist_ok=True)

uris = []
for pkg in PKGS:
    out = subprocess.run(["apt-get", "download", "--print-uris", pkg],
                         capture_output=True, text=True)
    line = out.stdout.strip().splitlines()[0] if out.stdout.strip() else None
    if not line:
        print(f"SKIP {pkg}: {out.stderr.strip().splitlines()[:1]}")
        continue
    uris.append(line.split()[0].strip("'\""))

for url in uris:
    name = url.rsplit("/", 1)[1]
    dest = os.path.join(DEST, name)
    if os.path.exists(dest):
        continue
    print("get", name)
    r = subprocess.run(["curl", "-fsSL", "-o", dest, url])
    if r.returncode != 0:
        print("  FAILED", url)
        sys.exit(1)

for deb in sorted(os.listdir(DEST)):
    if not deb.endswith(".deb"):
        continue
    subprocess.run(["dpkg-deb", "-x", os.path.join(DEST, deb), SYSROOT], check=True)
print("extracted", len([f for f in os.listdir(DEST) if f.endswith('.deb')]), "debs -> .sysroot")
