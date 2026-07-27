"""
Capture screenshots of the deployed yapper demo for use in the README.

Loads https://phantomic12.github.io/yapper/ in headless Chromium and saves:
  - 01-landing.png   — initial paint, model picker visible
  - 02-loaded.png    — after a model has been loaded (status: "Loaded")

Run with `npm run demo:capture` from the project root. Requires that
`npx playwright install chromium` has been run at least once.

By default this captures from the deployed production demo. Pass a
YAPPER_URL environment variable to point at a local dev server:
  YAPPER_URL=http://localhost:5173 npm run demo:capture

The output is written to ./demo-shots/ — copy the .png files into
docs/ or wherever the README expects them.
"""

import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = os.environ.get('YAPPER_URL', 'https://phantomic12.github.io/yapper/')
OUT_DIR = Path(__file__).parent / 'demo-shots'
OUT_DIR.mkdir(exist_ok=True)
# YAPPER_LOAD_TIMEOUT controls how long we wait for the model download
# in headless mode. The smallest model (Kitten Nano) is ~24MB, which
# can take a while on a slow CI link. Default 5 minutes; override via
# the env var to be tighter in dev or looser in CI.
LOAD_TIMEOUT_MS = int(os.environ.get('YAPPER_LOAD_TIMEOUT_MS', '300000'))


def main():
    print(f'→ {URL}')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-gpu'])
        ctx = browser.new_context(viewport={'width': 1280, 'height': 800}, device_scale_factor=2)
        page = ctx.new_page()

        page.goto(URL, wait_until='domcontentloaded', timeout=30_000)
        # Wait for the model grid to mount (it's rendered after the async render()).
        page.wait_for_selector('.model-card', timeout=15_000)
        # Give the GPU-detection async call a moment to settle so the status text is final.
        time.sleep(1.5)

        shot1 = OUT_DIR / '01-landing.png'
        page.screenshot(path=str(shot1), full_page=False)
        print(f'  ✓ {shot1} ({shot1.stat().st_size // 1024} KB)')

        # Click the Kitten Nano card and then the Load button so the
        # screenshot shows the "Loaded" state. We use Kitten Nano
        # because it's the smallest (~24 MB) and finishes first.
        page.click('.model-card[data-model-id="kitten-nano"]')
        time.sleep(0.3)
        page.click('#load-btn')

        # Wait for the engine to reach 'ready' state — the load button
        # label changes to '✓ Kitten TTS Nano (~24MB) loaded'. Bound
        # the wait so a CI failure doesn't hang forever.
        try:
            page.wait_for_function(
                "() => document.getElementById('load-btn')?.querySelector('span')?.textContent?.includes('loaded')",
                timeout=LOAD_TIMEOUT_MS,
            )
        except Exception as e:
            print(f'  ! load did not complete in time ({e}); capturing partial state')
            # Still save what we have so a CI failure produces a useful artifact
            shot_partial = OUT_DIR / '02-loaded.png'
            try:
                page.screenshot(path=str(shot_partial), full_page=False)
            except Exception:
                pass
            return

        # Give the card status badge a moment to flip to "Loaded"
        page.wait_for_selector('.model-card--loaded', timeout=10_000)
        time.sleep(0.5)

        shot2 = OUT_DIR / '02-loaded.png'
        page.screenshot(path=str(shot2), full_page=False)
        print(f'  ✓ {shot2} ({shot2.stat().st_size // 1024} KB)')

        # Also capture the audio-in-flight state: queue a sample and screenshot
        # while it's generating, to show the worker + progress in the README.
        try:
            page.click('[data-action="sample"]', timeout=2000)
            time.sleep(0.5)
            shot3 = OUT_DIR / '03-generating.png'
            page.screenshot(path=str(shot3), full_page=False)
            print(f'  ✓ {shot3} ({shot3.stat().st_size // 1024} KB)')
        except Exception as e:
            # Sample button might not be visible (load failed earlier). Skip.
            print(f'  (skipping 03-generating: {e})')

        browser.close()
        print(f'\nDone. Files in: {OUT_DIR}')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n\nInterrupted.')
        sys.exit(130)
