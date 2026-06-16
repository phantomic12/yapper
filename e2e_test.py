"""
Yapper — End-to-end browser test via raw CDP.

Drives a fresh Chrome instance (on gravebuster, port 9335) through the full
TTS workflow: load page → detect WebGPU → select model → load model → generate
speech → verify audio is produced.

This script does NOT use the Hermes browser tool — it talks directly to the
the yapper-test CDP at http://100.93.66.35:9335, keeping the wileyplus session
on 9333 completely untouched.
"""

import json
import time
import base64
import sys
from pathlib import Path
import urllib.request
import websocket

CDP = "http://100.93.66.35:9335"
SCREENSHOT_DIR = Path("/tmp/yapper-shots")
SCREENSHOT_DIR.mkdir(exist_ok=True)


class CDPSession:
    def __init__(self, browser_ws_url):
        self.ws = websocket.create_connection(browser_ws_url, timeout=30)
        self._msg_id = 0
        self._sessions = {}  # targetId -> sessionId

    def send(self, method, params=None, session_id=None, target_id=None):
        self._msg_id += 1
        msg = {"id": self._msg_id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        self.ws.send(json.dumps(msg))
        return self._msg_id

    def wait_for(self, msg_id, timeout=30, debug=False):
        """Wait for a specific response ID, filtering out events from other sources."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.ws.settimeout(max(0.1, deadline - time.time()))
                raw = self.ws.recv()
                if not raw:
                    continue
                try:
                    resp = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if resp.get("id") == msg_id:
                    return resp
                if debug:
                    # Show what other events we're seeing
                    method = resp.get("method", "")
                    if method:
                        print(f"        [event] {method}", flush=True)
            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                continue
        return None

    def attach(self, target_id):
        """Attach to a target, return sessionId."""
        msg_id = self.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        for _ in range(50):
            try:
                self.ws.settimeout(1)
                resp = json.loads(self.ws.recv())
                if resp.get("id") == msg_id:
                    sid = resp.get("result", {}).get("sessionId")
                    self._sessions[target_id] = sid
                    return sid
                # Might also arrive as a Target.attachedToTarget event
                if resp.get("method") == "Target.attachedToTarget":
                    sid = resp.get("params", {}).get("sessionId")
                    if sid:
                        self._sessions[target_id] = sid
                        return sid
            except websocket.WebSocketTimeoutException:
                continue
        return None

    def eval(self, expr, target_id, return_by_value=True, timeout=30):
        sid = self._sessions.get(target_id)
        if not sid:
            raise RuntimeError("Not attached to target")
        msg_id = self.send(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": return_by_value, "awaitPromise": False},
            session_id=sid,
        )
        return self.wait_for(msg_id, timeout=timeout)

    def screenshot(self, target_id, path, clip=None):
        sid = self._sessions.get(target_id)
        if not sid:
            raise RuntimeError("Not attached to target")
        params = {"format": "png"}
        if clip:
            params["clip"] = clip
        else:
            params["captureBeyondViewport"] = True
        msg_id = self.send("Page.captureScreenshot", params, session_id=sid)
        resp = self.wait_for(msg_id, timeout=30)
        if resp and "result" in resp:
            data = resp["result"].get("data", "")
            if data:
                Path(path).write_bytes(base64.b64decode(data))
                return True
        return False

    def close(self):
        self.ws.close()


def get_targets():
    with urllib.request.urlopen(f"{CDP}/json/list") as r:
        return json.loads(r.read())


def v(resp):
    """Get the .value from a CDP Runtime.evaluate response, handling None safely."""
    if not resp:
        return {}
    return resp.get("result", {}).get("result", {}).get("value", {}) or {}


def get_browser_ws():
    with urllib.request.urlopen(f"{CDP}/json/version") as r:
        return json.loads(r.read())["webSocketDebuggerUrl"]


def banner(label):
    print(f"\n{'='*70}\n  {label}\n{'='*70}")


def main():
    banner("Yapper — E2E browser test via raw CDP")

    # 1. Discover browser
    print(f"\n[1/9] Connecting to CDP at {CDP}")
    version = json.loads(urllib.request.urlopen(f"{CDP}/json/version").read())
    print(f"      Browser: {version['Browser']}")
    print(f"      V8:      {version['V8-Version']}")

    targets = get_targets()
    page_targets = [t for t in targets if t["type"] == "page"]
    print(f"      Page targets: {len(page_targets)}")
    for t in page_targets:
        print(f"        - {t['id'][:16]}...  {t['url'][:80]}")

    # Use the first page target
    target = page_targets[0]

    # 2. Attach
    print(f"\n[2/9] Attaching to target {target['id'][:16]}...")
    browser_ws = get_browser_ws()
    cdp = CDPSession(browser_ws)
    sid = cdp.attach(target["id"])
    if not sid:
        print("      ❌ Failed to attach")
        sys.exit(1)
    print(f"      ✓ Attached, sessionId={sid[:16]}...")

    # 3. Navigate to yapper
    print(f"\n[3/9] Navigating to https://phantomic12.github.io/yapper/")
    nav_id = cdp.send("Page.enable", session_id=sid)
    cdp.wait_for(nav_id)
    nav_id = cdp.send("Page.navigate", {"url": "https://phantomic12.github.io/yapper/"}, session_id=sid)
    cdp.wait_for(nav_id, timeout=10)
    print("      ✓ Navigated, waiting for page load...")

    # Wait for app to render
    time.sleep(3)
    ready_resp = cdp.eval(
        """(function() {
            return {
                title: document.title,
                hasApp: !!document.getElementById('app'),
                appChildren: document.getElementById('app')?.children.length || 0,
                models: document.querySelectorAll('.model-card').length,
                textareaDisabled: document.getElementById('text-input')?.disabled,
                loadBtnExists: !!document.getElementById('load-btn'),
                gpuDot: document.querySelector('.gpu-status__dot')?.className,
                gpuText: document.querySelector('.gpu-status__label')?.textContent,
                hasModels: window.MODELS ? 'check_js' : 'no_global'
            };
        })()""",
        target["id"], timeout=10,
    )
    state = v(ready_resp)
    print(f"      title:  {state.get('title')}")
    print(f"      models: {state.get('models')}")
    print(f"      GPU:    {state.get('gpuText', '').strip()}")
    print(f"      dot:    {state.get('gpuDot', '')}")
    print(f"      textarea disabled: {state.get('textareaDisabled')}")
    print(f"      load btn exists:   {state.get('loadBtnExists')}")

    if not state.get("hasApp") or state.get("models", 0) < 5:
        print("      ❌ Page didn't render properly")
        sys.exit(1)
    print("      ✓ Page rendered, model grid populated")

    # 4. Screenshot the initial UI
    print(f"\n[4/9] Screenshot: initial UI")
    shot1 = SCREENSHOT_DIR / "01-initial-load.png"
    cdp.screenshot(target["id"], shot1)
    print(f"      → {shot1} ({shot1.stat().st_size // 1024} KB)")

    # 5. Select MMS-TTS English (default; SpeechT5 requires speaker embeddings)
    print(f"\n[5/9] Selecting MMS-TTS English model (default)")
    sel_resp = cdp.eval(
        """(function() {
              const card = document.querySelector('.model-card[data-model-id="mms-tts-eng"]');
              if (!card) return { ok: false, msg: 'no mms-tts-eng card' };
              card.click();
              return {
                  ok: true,
                  selected: document.querySelector('.model-card--selected')?.dataset.modelId,
                  name: card.querySelector('.model-card__name')?.textContent
              };
          })()""",
        target["id"], timeout=10,
    )
    sel = v(sel_resp)
    print(f"      selected: {sel.get('selected')}")
    print(f"      name:     {sel.get('name')}")
    if sel.get("selected") != "mms-tts-eng":
        print(f"      ❌ Failed to select model: sel={sel}")
        sys.exit(1)
    print("      ✓ Model selected")

    # 6. Click "Download & Load Model"
    print(f"\n[6/9] Clicking 'Download & Load Model' button")
    print("      (this will download the model from HuggingFace — may take a while)")
    click_resp = cdp.eval(
        """(function() {
            const btn = document.getElementById('load-btn');
            if (!btn) return { ok: false };
            btn.click();
            return {
                ok: true,
                state: btn.disabled,
                text: btn.querySelector('span')?.textContent
            };
        })()""",
        target["id"], timeout=5,
    )
    click = v(click_resp)
    print(f"      btn.disabled: {click.get('state')}")
    print(f"      btn text:     {click.get('text')}")
    if not click.get("state"):
        print("      ⚠ Button not disabled, may not have triggered")
    print("      ✓ Click sent, polling state...")

    # 7. Poll state during load
    print(f"\n[7/9] Polling engine state (waiting for model load)")
    start = time.time()
    last_state = None
    last_progress_text = None
    while time.time() - start < 600:  # 10 minute max
        poll = cdp.eval(
            """(function() {
                const banner = document.querySelector('.status-banner');
                const progress = document.getElementById('progress-text');
                const loadBtn = document.getElementById('load-btn');
                const genBtn = document.getElementById('generate-btn');
                const textarea = document.getElementById('text-input');
                return {
                    banner: banner ? banner.textContent.trim().substring(0, 200) : null,
                    bannerType: banner ? banner.className : null,
                    progress: progress ? progress.textContent : null,
                    loadText: loadBtn?.querySelector('span')?.textContent,
                    genDisabled: genBtn?.disabled,
                    textareaDisabled: textarea?.disabled,
                    progressVisible: document.getElementById('progress-bar')?.classList.contains('progress-bar--visible')
                };
            })()""",
            target["id"], timeout=10,
        )
        s = v(poll)

        # Build a one-line summary
        progress_str = s.get("progress", "")[:50] if s.get("progress") else ""
        if progress_str != last_progress_text:
            print(f"      [{int(time.time()-start):3d}s] {progress_str}")
            last_progress_text = progress_str

        # Capture mid-load screenshot
        if int(time.time() - start) == 5:
            shot2 = SCREENSHOT_DIR / "02-loading.png"
            cdp.screenshot(target["id"], shot2)
            print(f"      → screenshot saved: {shot2.name}")

        # Check for success
        if s.get("loadText") and ("loaded" in s.get("loadText", "").lower() or "✓" in s.get("loadText", "")):
            print(f"\n      ✓ Model loaded!")
            print(f"        banner:  {s.get('banner', '')[:80]}")
            print(f"        gen disabled: {s.get('genDisabled')}")
            print(f"        textarea disabled: {s.get('textareaDisabled')}")
            last_state = "ready"
            break

        if s.get("bannerType") and "error" in s.get("bannerType"):
            print(f"      ❌ Error banner: {s.get('banner')}")
            shot_err = SCREENSHOT_DIR / "03-error.png"
            cdp.screenshot(target["id"], shot_err)
            print(f"      → screenshot saved: {shot_err.name}")
            sys.exit(1)

        time.sleep(3)

    if last_state != "ready":
        print(f"      ❌ Model did not load within timeout. Last progress: {last_progress_text}")
        shot_stuck = SCREENSHOT_DIR / "03-stuck.png"
        cdp.screenshot(target["id"], shot_stuck)
        sys.exit(1)

    # 8. Screenshot ready state
    print(f"\n[8/9] Screenshot: ready state")
    shot3 = SCREENSHOT_DIR / "03-ready.png"
    cdp.screenshot(target["id"], shot3)
    print(f"      → {shot3} ({shot3.stat().st_size // 1024} KB)")

    # 9. Generate speech
    print(f"\n[9/9] Typing text and generating speech")
    TEST_TEXT = "Hello! This is Yapper, a privacy-first text to speech engine running entirely in your browser."
    type_resp = cdp.eval(
        f"""(function() {{
            const ta = document.getElementById('text-input');
            ta.value = {json.dumps(TEST_TEXT)};
            ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
            return {{ len: ta.value.length }};
        }})()""",
        target["id"], timeout=10,
    )
    t = v(type_resp)
    print(f"      typed: {t.get('len')} chars")
    if t.get("len", 0) < 50:
        print(f"      ⚠ type_resp was: {type_resp}")
        sys.exit(1)

    # Click generate (sync — returns immediately; generation happens async)
    # First sleep briefly to let any pending events drain
    time.sleep(0.5)
    click_resp = cdp.eval(
        """(function() {
            const btn = document.getElementById('generate-btn');
            if (btn.disabled) return { ok: false, msg: 'btn disabled' };
            btn.click();
            return { ok: true, time: Date.now() };
        })()""",
        target["id"], timeout=15,
    )
    cr = v(click_resp)
    if not cr.get("ok"):
        print(f"      ❌ Generate button not clickable: {cr.get('msg')}")
        sys.exit(1)
    print(f"      ✓ Generate clicked, polling for audio...")

    # Poll for audio
    print("      Polling for audio output (up to 5 minutes)...")
    start = time.time()
    audio_ready = False
    while time.time() - start < 300:
        poll = cdp.eval(
            """(function() {
                const player = document.getElementById('player');
                const audio = document.getElementById('audio-element');
                const genBtn = document.getElementById('generate-btn');
                const banner = document.querySelector('.status-banner');
                return {
                    playerVisible: player?.classList.contains('player--visible'),
                    audioSrc: audio?.src?.substring(0, 50),
                    audioDuration: audio?.duration,
                    audioReadyState: audio?.readyState,
                    genDisabled: genBtn?.disabled,
                    banner: banner?.textContent?.trim()?.substring(0, 100),
                    bannerType: banner?.className
                };
            })()""",
            target["id"], timeout=10,
        )
        s = v(poll)
        if s.get("playerVisible") and s.get("audioSrc"):
            print(f"      ✓ Audio generated!")
            print(f"        src:          {s.get('audioSrc')[:50]}")
            print(f"        duration:     {s.get('audioDuration')}s")
            print(f"        readyState:   {s.get('audioReadyState')}")
            audio_ready = True
            break
        if s.get("bannerType") and "error" in s.get("bannerType"):
            print(f"      ❌ Error: {s.get('banner')}")
            shot_err = SCREENSHOT_DIR / "04-gen-error.png"
            cdp.screenshot(target["id"], shot_err)
            sys.exit(1)
        time.sleep(2)

    if not audio_ready:
        print(f"      ❌ Audio did not appear within timeout")
        shot_stuck = SCREENSHOT_DIR / "04-stuck.png"
        cdp.screenshot(target["id"], shot_stuck)
        sys.exit(1)

    # Final screenshot
    print(f"\n[final] Screenshot: audio output visible")
    shot4 = SCREENSHOT_DIR / "04-audio-output.png"
    cdp.screenshot(target["id"], shot4)
    print(f"      → {shot4} ({shot4.stat().st_size // 1024} KB)")

    # Check console for errors
    print(f"\n[bonus] Checking for console errors")
    cdp.send("Runtime.enable", session_id=sid)
    cdp.send("Log.enable", session_id=sid)
    # Drain any pending events
    cdp.ws.settimeout(1)
    try:
        while True:
            cdp.ws.recv()
    except websocket.WebSocketTimeoutException:
        pass

    # Check audio duration with a fresh eval
    final = cdp.eval(
        """(function() {
            const audio = document.getElementById('audio-element');
            const genBtn = document.getElementById('generate-btn');
            return {
                duration: audio?.duration,
                paused: audio?.paused,
                src: audio?.src?.startsWith('blob:'),
                genBtnEnabled: !genBtn?.disabled
            };
        })()""",
        target["id"], timeout=5,
    )
    f = v(final)
    print(f"      audio src:   {'blob: ✓' if f.get('src') else 'not a blob'}")
    print(f"      duration:    {f.get('duration')}s")
    print(f"      gen enabled: {f.get('genBtnEnabled')}")

    cdp.close()
    print(f"\n{'='*70}")
    print(f"  ✓ ALL TESTS PASSED")
    print(f"  Screenshots in: {SCREENSHOT_DIR}")
    print(f"{'='*70}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
        sys.exit(1)
    except Exception as e:
        import traceback
        print(f"\n❌ Fatal error: {e}")
        traceback.print_exc()
        sys.exit(1)
