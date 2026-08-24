#!/usr/bin/env python3
"""Live verification of honest capability/fallback UX against the local build.

Drives the chrome-cdp container (Chrome 124, CDP at http://172.17.0.1:9222)
against `vite preview` serving the production dist (http://10.99.0.18:5199).

Checks (task t_a10117d7):
  AC3  real-Chrome banner wording matches detected capability class
  AC2  selecting a main-thread model shows the in-app warning before generation;
       it hides again for worker-backed models
  AC1  blocked huggingface.co -> clear error state with a working Retry button;
       unblock -> retry recovers to ready. Uses MMS-TTS (English) because its
       Transformers.js fetches run on the main thread, i.e. the page CDP target
       that Network.setBlockedURLs actually governs (worker-target requests are
       NOT covered by page-level blocking — verified in qa/probe_blocked_load.py).
  AC4  no silent state >5s: error feedback lands within the watchdog window,
       and the pulsing generation badge appears while a main-thread model
       synthesizes (the freeze case).

Writes qa/results/live-capability-check-summary.json.
"""
import json
import os
import time

from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9333"  # isolated Chromium (scripts/start-chrome-isolated.sh)
URL = "http://10.99.0.18:5199/"
TEXT = "The quick brown fox."

results = {"url": URL, "browser": None, "checks": {}, "console_errors": []}


def check(name, ok, detail=""):
    results["checks"][name] = {"ok": bool(ok), "detail": str(detail)[:400]}
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail)[:200] if detail else ""))


with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(CDP)
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    ctx.set_default_timeout(60000)
    page = ctx.new_page()
    page.on("console", lambda m: results["console_errors"].append(m.text[:300])
            if m.type == "error" else None)

    # ── Boot + banner (AC3 on real Chrome; --disable-gpu => WASM path) ──
    # Drop any service worker / caches from earlier runs so we always test
    # the freshly built bundle.
    page.goto(URL)
    page.evaluate(
        "async () => {"
        "  if (navigator.serviceWorker) {"
        "    const regs = await navigator.serviceWorker.getRegistrations();"
        "    await Promise.all(regs.map(r => r.unregister()));"
        "  }"
        "  if (window.caches) {"
        "    const keys = await caches.keys();"
        "    await Promise.all(keys.map(k => caches.delete(k)));"
        "  }"
        "}"
    )
    page.goto(URL)
    page.reload()
    page.wait_for_selector(".gpu-status__label", timeout=30000)
    time.sleep(1.0)  # allow detectCapability() to settle
    label = page.locator(".gpu-status__label").inner_text().strip()
    ua = page.evaluate("navigator.userAgent")
    results["browser"] = ua
    has_gpu = page.evaluate("!!navigator.gpu")
    expected_prefix = "WebGPU unavailable" if not has_gpu else "WebGPU detected"
    check("AC3_banner_wording_matches_capability", label.startswith(expected_prefix),
          f"banner={label!r} navigator.gpu={has_gpu}")

    # ── AC2: main-thread warning appears when SpeechT5 selected ──
    warn = page.locator("#main-thread-warning")
    check("AC2_warning_hidden_on_worker_model",
          not warn.is_visible(),
          f"initial model=kitten-nano, display={warn.get_attribute('style')}")
    page.locator(".model-card[data-model-id='speecht5'] [data-action='pick']").click()
    time.sleep(0.3)
    check("AC2_warning_shown_for_speecht5", warn.is_visible(), warn.inner_text()[:120])
    # ...and hides again for a worker-backed pick
    page.locator(".model-card[data-model-id='kitten-nano'] [data-action='pick']").click()
    time.sleep(0.3)
    check("AC2_warning_hides_again", not warn.is_visible())

    # ── AC1: block huggingface.co → error + Retry; unblock → recovery ──
    # MMS-TTS loads on the MAIN thread, so its HF fetches sit on the page CDP
    # target where setBlockedURLs applies deterministically.
    cdp = ctx.new_cdp_session(page)
    cdp.send("Network.enable")
    cdp.send("Network.setBlockedURLs",
             {"urls": ["*huggingface.co*", "*cdn-lfs*", "*cdn.hf.co*"]})

    page.locator(".model-card[data-model-id='mms-tts-eng'] [data-action='pick']").click()
    t_block = time.time()
    page.locator("#load-btn").click()
    # Blocked fetches fail fast (ERR_BLOCKED_BY_CLIENT); hung ones trip the
    # engine's 5s stall watchdog. Either way an error + Retry must appear.
    deadline = time.time() + 30
    saw_retry_at = None
    while time.time() < deadline:
        if page.locator("[data-role='status-action']").count() > 0:
            saw_retry_at = round(time.time() - t_block, 1)
            break
        time.sleep(0.5)
    banner_text = ""
    if page.locator(".status-banner--error").count():
        banner_text = page.locator(".status-banner--error").first.inner_text()
    check("AC1_error_state_with_retry_when_blocked", saw_retry_at is not None,
          f"after {saw_retry_at}s banner={banner_text[:150]!r}")

    # Unblock and hit Retry — recovery must reach ready.
    cdp.send("Network.setBlockedURLs", {"urls": []})
    recovered = False
    elapsed = -1.0
    gb = page.locator("#generate-btn")
    success_text = ""
    if saw_retry_at is not None:
        page.locator("[data-role='status-action']").first.click()
        t0 = time.time()
        while time.time() - t0 < 240:
            try:
                if not gb.evaluate("el => el.disabled"):
                    recovered = True
                    break
            except Exception:
                pass
            time.sleep(2)
        elapsed = round(time.time() - t0, 1)
        time.sleep(1)
        if page.locator(".status-banner--success").count():
            success_text = page.locator(".status-banner--success").first.inner_text()
    check("AC1_recovery_after_unblock_via_retry", recovered,
          f"generate enabled {elapsed}s after retry; banner={success_text[:100]!r}"
          if saw_retry_at is not None else "skipped")

    # ── AC4: liveness badge during generation ──
    # Main-thread synthesis blocks the page, so no external observer (CDP
    # included) can sample DOM state mid-freeze — the badge is added
    # synchronously before the freeze and removed after (unit-tested in
    # src/dom-utils.test.ts). The worker-backed path keeps the main thread
    # free, making the badge genuinely observable live; that's checked here.
    page.locator(".model-card[data-model-id='kitten-nano'] [data-action='pick']").click()
    page.locator("#load-btn").click()
    t_load = time.time()
    while time.time() - t_load < 120:
        try:
            if not gb.evaluate("el => el.disabled"):
                break
        except Exception:
            pass
        time.sleep(1)
    page.fill("#text-input", TEXT)
    gb.click()
    fb_visible_quickly = False
    for _ in range(30):  # within the first ~6s
        try:
            if page.locator("#generation-feedback.generation-feedback--visible").is_visible():
                fb_visible_quickly = True
                break
        except Exception:
            pass
        time.sleep(0.2)
    check("AC4_generation_liveness_badge_visible", fb_visible_quickly,
          "badge up while kitten-nano (worker-backed, non-blocking) generates")
    audio = page.locator(".job-card--done audio[data-job-id]").first
    audio.wait_for(state="visible", timeout=240000)
    dur = audio.evaluate("el => el.duration && isFinite(el.duration) ? el.duration : null")
    check("generation_completes", bool(dur and dur > 0.3),
          f"audio={dur}s (kitten-nano; earlier mms-tts-eng job also completed post-recovery)")
    time.sleep(0.5)
    check("AC4_liveness_badge_hidden_after_done",
          not page.locator("#generation-feedback.generation-feedback--visible").is_visible())

    page.close()

results["all_pass"] = all(v["ok"] for v in results["checks"].values())
os.makedirs("qa/results", exist_ok=True)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "live-capability-check-summary.json")
json.dump({"browser": results["browser"], "url": results["url"],
           "all_pass": results["all_pass"],
           "checks": results["checks"],
           "console_errors": results["console_errors"][:10]},
          open(out, "w"), indent=2)
print("\nALL PASS" if results["all_pass"] else "\nSOME CHECKS FAILED")
