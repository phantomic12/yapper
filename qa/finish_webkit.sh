#!/usr/bin/env bash
# Finish WebKit sysroot: libwoff1 + final resolution check.
set -e
cd "$(dirname "$0")"
apt-get download libwoff1 >/dev/null 2>&1 || true
mv -f libwoff1_*.deb .debs/ 2>/dev/null || true
for d in .debs/libwoff1_*.deb; do [ -f "$d" ] && dpkg-deb -x "$d" .sysroot && echo "extracted $d"; done
export LD_LIBRARY_PATH="$PWD/.sysroot/usr/lib/x86_64-linux-gnu:$PWD/.sysroot/lib/x86_64-linux-gnu"
echo "=== webkit binaries unresolved libs ==="
for b in minibrowser-gtk/bin/MiniBrowser minibrowser-wpe/bin/MiniBrowser; do
  n=$(ldd ".pw-browsers/webkit-2336/$b" 2>/dev/null | grep -c 'not found' || true)
  echo "$b: $n missing"
done
