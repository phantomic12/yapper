#!/usr/bin/env python3
"""Print the Kaggle username behind the credentials on disk.

Delegates to KaggleApi.authenticate() itself — the exact same resolution
the subsequent `kaggle kernels push` will perform — so whatever username
this prints is the one the push will actually use. Handles both
kaggle.json and ~/.kaggle/access_token (the latter is resolved server-side
via token introspection).

Exits non-zero when authentication fails; the workflow falls back to a
server-side id there, which makes the push fail loudly instead.
"""

import sys


def main() -> int:
    from kaggle.api.kaggle_api_extended import KaggleApi

    api = KaggleApi()
    try:
        api.authenticate()
    except SystemExit:
        return 1
    username = api.config_values.get("username")
    if not username:
        print("::error::authenticated without a resolvable username",
              file=sys.stderr)
        return 1
    print(username)
    return 0


if __name__ == "__main__":
    sys.exit(main())
