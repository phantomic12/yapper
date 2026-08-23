#!/usr/bin/env python3
"""File the download-button GitHub issue via the REST API."""
import json
import os
import sys
import urllib.request

TOKEN = os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"]
REPO = "phantomic12/yapper"

TITLE = "Download WAV button does nothing (listener never attached to done-state button)"
BODY = """## Summary

On a completed generation, clicking the **Download WAV** button on the job card does nothing — no file is downloaded and no error is shown. The audio itself plays fine; only the download action is dead.

## Repro steps

1. Open https://phantomic12.github.io/yapper/
2. Select **Kitten TTS Nano**, click **Download & Load Model**.
3. Queue a short generation and wait for the job card to finish (audio element appears).
4. Click **Download WAV** on the finished job card.

**Expected:** a `yapper-<jobid>-<ts>.wav` file downloads.
**Actual:** nothing happens. No console errors.

## Root cause

`wireCardButtons()` in `src/ui/job-queue.ts` guards all listener wiring behind a one-time flag:

```ts
function wireCardButtons(state: AppState, card: HTMLElement, list: HTMLElement) {
  // Click listeners are wired once per card. Using a flag prevents us
  // from re-attaching the same listener on every render.
  if (card.dataset.wired === 'true') return;
  card.dataset.wired = 'true';
```

But `renderJobList()` relies on calling it again to attach listeners to elements that appear later:

```ts
if (existing.body.innerHTML !== desiredBody) {
  existing.body.innerHTML = desiredBody;
  // Re-wire any buttons/audio that appeared in the new body.
  wireCardButtons(state, existing.card, list);   // <-- no-op due to the guard
}
```

A pending/generating card is wired when first appended (`cancel` button exists), which sets `data-wired`. When the same card flips to `done`, its body is replaced with the `<audio>` + Download WAV markup and `wireCardButtons` is called again — but returns immediately because of the flag, so the download button never gets its listener. Only cards created *directly* in the done state would work.

## Evidence

Automated Playwright pass (Chromium 151, headless): generation completes, `<audio src="blob:...">` present, `[data-action=download]` visible+enabled, click produces no download event. Injecting an equivalent `<a href=blobURL download>` anchor and clicking it fires the browser download immediately — so the blob URL is valid; only the app's click handler is missing. Verified against the live site on 2026-08-23.

## Fix sketch

Make wiring idempotent per element instead of per card (e.g. query unwired `[data-action]` elements and mark those), or drop the flag and use `{ once: true }`/AbortController-scoped listeners that tolerate being re-run after body replacement.

## Environment

- Live site, Chromium headless 151 + Chrome CDP container (Chrome 124)
- Found during cross-browser QA matrix pass (docs/qa-matrix.md)
"""

data = json.dumps({"title": TITLE, "body": BODY,
                   "labels": ["bug"]}).encode()
req = urllib.request.Request(
    f"https://api.github.com/repos/{REPO}/issues",
    data=data,
    headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    },
    method="POST",
)
with urllib.request.urlopen(req) as r:
    resp = json.loads(r.read().decode())
print("issue:", resp.get("number"), resp.get("html_url"))
