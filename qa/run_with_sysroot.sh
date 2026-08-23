#!/usr/bin/env bash
# Launch Firefox/WebKit from the local sysroot without polluting the shell env.
# Usage: run_with_sysroot.sh <command> [args...]
HERE="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$HERE/.sysroot/usr/lib/x86_64-linux-gnu:$HERE/.sysroot/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$@"
