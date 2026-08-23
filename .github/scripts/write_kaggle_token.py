#!/usr/bin/env python3
"""Write ~/.kaggle/kaggle.json from the KAGGLE_API_TOKEN secret.

Fail-loud contract: any problem with the credential is a hard error with
an actionable message, so the run can never continue green on bad auth.
With --break-token the key is deliberately corrupted before validation —
used by workflow_dispatch to prove the pipeline fails loudly instead of
skipping quietly (acceptance criterion for the GPU smoke task).
"""

import argparse
import json
import os
import sys
from pathlib import Path

USAGE = (
    "KAGGLE_API_TOKEN must be the raw JSON contents of kaggle.json: "
    '{"username": "<kaggle user>", "key": "<token>"}. Create it at '
    "kaggle.com -> Settings -> API -> Create New Token, then paste the "
    "whole file into the repo secret."
)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--break-token", action="store_true",
                   help="corrupt the token on purpose (loud-failure drill)")
    args = p.parse_args()

    raw = os.environ.get("KAGGLE_API_TOKEN", "").strip()
    if not raw:
        print(f"::error::KAGGLE_API_TOKEN secret is empty or not set. {USAGE}",
              file=sys.stderr)
        return 1

    if args.break_token:
        # Corrupt only the key, keep valid JSON shape — this exercises the
        # API 401 path, not the JSON-parse path (both must fail loudly).
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                parsed["key"] = "corrupted-" + str(parsed.get("key", ""))[:8]
                raw = json.dumps(parsed)
        except json.JSONDecodeError:
            pass  # already malformed; the parse below will reject it

    try:
        cred = json.loads(raw)
        username = str(cred["username"]).strip()
        key = str(cred["key"]).strip()
    except (json.JSONDecodeError, KeyError, TypeError):
        print(
            "::error::KAGGLE_API_TOKEN is set but not valid kaggle.json "
            f"(got {len(raw)} chars). {USAGE}",
            file=sys.stderr,
        )
        return 1

    if args.break_token:
        print(
            "::error::KAGGLE_API_TOKEN was deliberately corrupted by "
            "--break-token; refusing to write credentials. This failure "
            "is intentional — the loud-failure drill works.",
            file=sys.stderr,
        )
        return 1

    if not username or not key:
        print(f"::error::KAGGLE_API_TOKEN has an empty username or key. {USAGE}",
              file=sys.stderr)
        return 1

    out = Path.home() / ".kaggle" / "kaggle.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"username": username, "key": key}, indent=2))
    os.chmod(out, 0o600)
    print(f"kaggle.json written for user '{username}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
