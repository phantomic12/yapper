#!/usr/bin/env python3
"""Interactive verification of the download-button fix on the patched local build."""
import time

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8098/index.html"
TEXT = "The future of text-to-speech is private, fast, and runs entirely in your browser."


def main(engine: str) -> bool:
    with sync_playwright() as pw:
        launcher = getattr(pw, engine)
        kwargs = {}
        if engine == "firefox":
            kwargs["env"] = {"MOZ_DISABLE_CONTENT_SANDBOX": "1"}
        browser = launcher.launch(**kwargs)
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()
        downloads = []
        page.on("download", lambda d: downloads.append(d.suggested_filename))
        page.goto(URL, wait_until="load")
        page.wait_for_selector(".model-card")
        card = page.locator(".model-card[data-model-id='kitten-nano']")
        card.locator('[data-action="pick"]').click()
        page.locator("#load-btn").click()
        gb = page.locator("#generate-btn")
        while gb.evaluate("el => el.disabled"):
            time.sleep(1)
        page.fill("#text-input", TEXT)
        gb.click()
        audio = page.locator(".job-card--done audio[data-job-id]").first
        audio.wait_for(state="visible", timeout=300000)
        with page.expect_download(timeout=20000) as dl:
            page.locator(".job-card--done [data-action='download']").first.click()
        path = f"/tmp/fixcheck-{engine}.wav"
        dl.value.save_as(path)
        import os
        size = os.path.getsize(path)
        magic = open(path, "rb").read(4)
        # click again to prove the listener isn't double-attached weirdness
        print(f"{engine}: download fired -> {downloads}, {size} bytes, header {magic}")
        browser.close()
        return magic == b"RIFF" and size > 20000


if __name__ == "__main__":
    import sys
    ok = main(sys.argv[1] if len(sys.argv) > 1 else "chromium")
    print("PASS" if ok else "FAIL")
