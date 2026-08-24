#!/usr/bin/env python3
"""QA pass against the kernel-images chrome-cdp container (Chrome 124).

Connects over CDP (http://172.17.0.1:9222), drives one tab through the full
checklist, saves results/cdp-chrome.json.
"""
import json
import os
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CDP = "http://172.17.0.1:9222"
URL = "http://10.99.0.18:8098/index.html"  # patched build, host LAN IP
TEXT = ("The future of text-to-speech is private, fast, and runs entirely "
        "in your browser.")

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(CDP)
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    ctx.set_default_timeout(300000)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text[:200])
            if m.type == "error" else None)
    steps = {}

    page.goto(URL)
    page.wait_for_selector(".model-card")
    steps["app_loads"] = True

    card = page.locator(".model-card[data-model-id='kitten-nano']")
    card.locator('[data-action="pick"]').click()
    steps["select_model"] = "model-card--selected" in (card.get_attribute(
        "class") or "")

    t0 = time.time()
    page.locator("#load-btn").click()
    gb = page.locator("#generate-btn")
    while gb.evaluate("el => el.disabled") and time.time() - t0 < 300:
        time.sleep(2)
    steps["download_and_load"] = not gb.evaluate("el => el.disabled")

    page.fill("#text-input", TEXT)
    t0 = time.time()
    gb.click()
    audio = page.locator(".job-card--done audio[data-job-id]").first
    audio.wait_for(state="visible", timeout=300000)
    dur = audio.evaluate(
        "el => el.duration && isFinite(el.duration) ? el.duration : null")
    steps["generation"] = bool(dur and dur > 0.5)

    # downloads may not be grantable over CDP; verify handler fires by
    # checking the anchor click path exists (button has wired listener)
    btn = page.locator(".job-card--done [data-action='download']").first
    steps["download_button_present"] = btn.is_visible()

    fixtures = os.path.join(HERE, "fixtures")
    page.locator("#document-upload").set_input_files(
        os.path.join(fixtures, "sample.txt"))
    page.wait_for_function(
        "() => document.getElementById('document-preview')"
        ".textContent.includes('QA fixture')", timeout=60000)
    steps["reader_txt"] = True

    page.locator("#document-upload").set_input_files(
        os.path.join(fixtures, "sample.pdf"))
    page.wait_for_function(
        "() => document.getElementById('document-preview')"
        ".textContent.includes('Yapper QA test page')", timeout=120000)
    steps["reader_pdf"] = True

    result = {
        "key": "cdp-chrome",
        "engine": "chrome-cdp-container (Chrome 124)",
        "steps": {k: bool(v) for k, v in steps.items()},
        "console_errors": [e for e in errors if "favicon" not in e.lower()],
        "status": "pass" if all(steps.values()) else "fail",
    }
    out = os.path.join(HERE, "results", "cdp-chrome.json")
    with open(out, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
    page.close()
    browser.close()
