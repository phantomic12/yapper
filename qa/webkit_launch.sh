#!/usr/bin/env bash
# WebKitGTK MiniBrowser launcher for Playwright.
#
# Library resolution order matters:
#   1. BUNDLE lib + sys/lib — Playwright's MiniBrowser binary is linked
#      against the bundle's own libwebkitgtk-6.0 (needs
#      webkit_browser_inspector_get_default, absent from Debian's 2.52).
#   2. qa/.sysroot — system deps the bundle doesn't ship: gstreamer,
#      ICU 76, glib-networking TLS module, etc. (fetch_bundle_deps.py).
#
# IMPORTANT: libsoup comes from the SYSROOT (3.0.7) not the bundle when the
# bundle's copy conflicts with the sysroot glib; keep bundle first for
# webkit only.
#
# Assumes a persistent Xvfb on :99 (started separately by the QA driver).
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="$HERE/.pw-browsers/webkit-2336/minibrowser-gtk"
export WEBKIT_EXEC_PATH="$BUNDLE/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="$BUNDLE/lib"
export GIO_MODULE_DIR="$HERE/.sysroot/usr/lib/x86_64-linux-gnu/gio/modules"
export LD_LIBRARY_PATH="$BUNDLE/lib:$BUNDLE/sys/lib:$HERE/.sysroot/usr/lib/x86_64-linux-gnu:$HERE/.sysroot/lib/x86_64-linux-gnu"
export WEBKIT_FORCE_COMPLEX_TEXT=1
export DISPLAY="${DISPLAY:-:99}"
exec "$BUNDLE/bin/MiniBrowser" "$@"
