#!/usr/bin/env python3
"""Print the PR number from a GitHub event payload file."""

import json
import sys


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: event_pr_number.py <event-payload.json>")
    with open(sys.argv[1]) as fh:
        event = json.load(fh)
    num = event.get("number")
    if not isinstance(num, int):
        sys.exit(f"no PR number in {sys.argv[1]}")
    print(num)


if __name__ == "__main__":
    main()
