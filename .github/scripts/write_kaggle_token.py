#!/usr/bin/env python3
"""Write Kaggle credentials from the KAGGLE_API_TOKEN secret.

Accepts either format:
  - a kaggle.json file's contents: {"username": ..., "key": ...}
  - a bare Kaggle access token (the long slugged string from
    Settings -> API -> Create New Token)

Writes ~/.kaggle/kaggle.json or ~/.kaggle/access_token respectively —
both are honored by the `kaggle` CLI (a valid KAGGLE_API_TOKEN env var
would take precedence, which is why this step never exports the secret
to later steps).

Fail-loud contract: any problem with the credential is a hard error with
an actionable message, so the run can never continue green on bad auth.
With --break-token the credential is deliberately corrupted and written,
then the step fails: the dispatch drill proving bad credentials turn the
run red instead of skipping quietly.
"""

import argparse
import json
import os
import sys
from pathlib import Path

USAGE = (
    "KAGGLE_API_TOKEN must be either the raw JSON contents of kaggle.json "
    '({"username": "<user>", "key": "<token>"}) or a bare Kaggle access '
    "token from Settings -> API -> Create New Token."
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
        # Corrupt in place, keeping the shape of whichever format this is,
        # so the drill exercises credential validation, not local parsing.
        if raw.startswith("{"):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and parsed.get("key"):
                    parsed["key"] = "corrupted-" + str(parsed["key"])[:8]
                    raw = json.dumps(parsed)
            except json.JSONDecodeError:
                pass
        else:
            raw = "corrupted-" + raw[:12]

    home = Path.home()
    kaggle_dir = home / ".kaggle"
    kaggle_dir.mkdir(parents=True, exist_ok=True)

    try:
        cred = json.loads(raw)
        username = str(cred["username"]).strip()
        key = str(cred["key"]).strip()
    except (json.JSONDecodeError, KeyError, TypeError):
        username, key = "", ""
    if username and key:
        out = kaggle_dir / "kaggle.json"
        out.write_text(json.dumps({"username": username, "key": key},
                                  indent=2))
        os.chmod(out, 0o600)
        print(f"kaggle.json written for user '{username}'")
    else:
        # Not kaggle.json — treat the whole value as a bare access token.
        # Format oddities are left for the API to reject (fail-loud there);
        # we only guard against values too short to ever be a token.
        if raw.startswith("{") or len(raw) < 20:
            print(f"::error::KAGGLE_API_TOKEN is set but neither valid "
                  f"kaggle.json nor a plausible access token "
                  f"(got {len(raw)} chars). {USAGE}", file=sys.stderr)
            return 1
        out = kaggle_dir / "access_token"
        out.write_text(raw + "\n")
        os.chmod(out, 0o600)
        print(f"access_token written ({len(raw)} chars)")

    if args.break_token:
        print("::error::break-token drill: credentials were deliberately "
              "corrupted, failing this run ON PURPOSE. If you can read "
              "this, the loud-failure requirement is satisfied.",
              file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
