#!/usr/bin/env python3
"""Emit kernel-metadata.json for the Kaggle GPU smoke kernel."""

import argparse
import json
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True)
    p.add_argument("--id", required=True, help="<kaggle-user>/<kernel-slug>")
    p.add_argument("--title", required=True)
    p.add_argument("--code-file", required=True)
    args = p.parse_args()

    meta = {
        "id": args.id,
        "title": args.title,
        "code_file": args.code_file,
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_internet": True,
        "competition_sources": [],
        "dataset_sources": [],
        "kernel_sources": [],
        "model_sources": [],
    }
    Path(args.out).write_text(json.dumps(meta, indent=2) + "\n")
    print(f"{args.out}: {meta['id']}")


if __name__ == "__main__":
    main()
