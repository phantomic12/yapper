#!/usr/bin/env python3
"""Fetch the WebKitGTK runtime dependency closure into qa/.sysroot.

Strategy: apt-get download libwebkit2gtk-4.1-0 + friends, then walk each
downloaded deb's Depends fields recursively so we get a complete closure.
"""
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, ".debs")
SYSROOT = os.path.join(HERE, ".sysroot")
os.makedirs(DEST, exist_ok=True)

SEEDS = [
    "libwebkit2gtk-4.1-0",
    "libgtk-4-1",          # for the pw MiniBrowser (built against GTK4)
    "libgstreamer1.0-0",
    "libenchant-2-2",
]

SKIP = re.compile(
    r"^(lib[a-z0-9.+-]+)$"  # we only chase lib* packages
)


def download(pkg: str) -> str | None:
    r = subprocess.run(["apt-get", "download", pkg], cwd=DEST,
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None
    # find the newest matching deb in DEST
    cands = [f for f in os.listdir(DEST)
             if f.startswith(pkg + "_") and f.endswith(".deb")]
    if not cands:
        return None
    return max(cands, key=lambda f: os.path.getmtime(os.path.join(DEST, f)))


def depends_of(deb: str) -> list[str]:
    out = subprocess.run(["dpkg-deb", "-f", deb, "Depends"],
                         capture_output=True, text=True).stdout
    pkgs = []
    for alt in out.split(","):
        first = alt.split("|")[0].strip()
        name = first.split()[0] if first else ""
        if SKIP.match(name):
            pkgs.append(name)
    return pkgs


def main():
    seen = set()
    queue = list(SEEDS)
    failed = []
    while queue:
        pkg = queue.pop()
        if pkg in seen:
            continue
        seen.add(pkg)
        deb = download(pkg)
        if not deb:
            failed.append(pkg)
            print("  MISS", pkg)
            continue
        path = os.path.join(DEST, deb)
        subprocess.run(["dpkg-deb", "-x", path, SYSROOT], check=True)
        deps = depends_of(path)
        print(f"  ok   {pkg} ({len(deps)} deps)")
        queue.extend(d for d in deps if d not in seen)
    print(f"\ndownloaded {len(seen)-len(failed)} pkgs, {len(failed)} missing")
    if failed:
        print("missing:", ", ".join(sorted(set(failed))))


if __name__ == "__main__":
    main()
