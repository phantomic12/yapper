#!/usr/bin/env python3
"""Emit the kernel script with the repo ref to test baked in.

The kernel clones yapper at GIT_REF (a branch name or tag) — or fetches
GIT_FETCH first when testing a PR merge commit (refs/pull/N/merge is not
fetched by default). Baking the ref in keeps the workflow YAML free of
string-templating into Python source.
"""

import argparse
import re
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--script", default=".github/scripts/gpu_smoke_kaggle.py")
    p.add_argument("--out", required=True)
    p.add_argument("--git-ref", required=True)
    p.add_argument("--git-fetch", default="")
    args = p.parse_args()

    text = Path(args.script).read_text()
    for name in ("GIT_REF", "GIT_FETCH"):
        if re.search(rf"^{name} = ", text, flags=re.M) is None:
            raise SystemExit(f"{args.script}: constant {name} not found")

    text = text.replace("GIT_REF = 'main'", f"GIT_REF = {args.git_ref!r}")
    text = text.replace("GIT_FETCH = ''", f"GIT_FETCH = {args.git_fetch!r}")
    Path(args.out).write_text(text)
    print(f"{args.out} (ref={args.git_ref!r}, fetch={args.git_fetch!r})")


if __name__ == "__main__":
    main()
