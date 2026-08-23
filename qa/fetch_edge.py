#!/usr/bin/env python3
"""Fetch + extract Microsoft Edge stable deb into qa/.edge/ (no root)."""
import os
import re
import subprocess
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
EDGE = os.path.join(HERE, ".edge")

index_url = ("https://packages.microsoft.com/repos/edge/pool/main/m/"
             "microsoft-edge-stable/")
with urllib.request.urlopen(index_url, timeout=30) as r:
    html = r.read().decode()

debs = sorted(set(re.findall(r"microsoft-edge-stable_[0-9.]+-1_amd64\.deb",
                             html)))
if not debs:
    raise SystemExit("no debs found")
# pick highest version
def ver(name):
    return [int(p) for p in name.split("_")[1].split("-")[0].split(".")]
debs.sort(key=ver)
chosen = debs[-1]
url = index_url + chosen
print("fetching", url)
deb_path = os.path.join(HERE, ".debs", chosen)
urllib.request.urlretrieve(url, deb_path)

os.makedirs(EDGE, exist_ok=True)
subprocess.run(["dpkg-deb", "-x", deb_path, EDGE], check=True)
binary = f"{EDGE}/opt/microsoft/msedge/msedge"
print("extracted:", binary, "exists:", os.path.exists(binary))
