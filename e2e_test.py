"""
Yapper — End-to-end browser test via raw CDP.

Drives a real Chrome instance through the full TTS workflow:
  1. Load the page
  2. Confirm model grid renders
  3. Pick a small model (Kitten TTS Nano, ~24MB, fast on CPU)
  4. Click "Download & Load Model" and wait for ready state
  5. Type text and click Generate
  6. Verify a job card appears and produces an audio blob

This script does NOT use the Hermes browser tool — it talks directly to a
local Chrome instance via the Chrome DevTools Protocol so the wileyplus /
yapper browser sessions stay isolated.

Usage:
    python e2e_test.py                 # uses CDP at $YAPPER_CDP or http://localhost:9222
    YAPPER_CDP=http://host:9222 python e2e_test.py
    YAPPER_URL=http://localhost:5173  python e2e_test.py   # dev server
    YAPPER_URL=https://phantomic12.github.io/yapper/ python e2e_test.py  # prod
"""

import json
import time
import base64
import os
import sys
from pathlib import Path
import urllib.request
import urllib.error
import websocket

CDP = os.environ.get('YAPPER_CDP', 'http://localhost:9222')
URL = os.environ.get('YAPPER_URL', 'https://phantomic12.github.io/yapper/')
SCREENSHOT_DIR = Path(os.environ.get('YAPPER_SHOTS', '/tmp/yapper-shots'))
SCREENSHOT_DIR.mkdir(exist_ok=True)

# We pick Kitten TTS Nano as the default test model: it's the smallest
# quantized model in the registry (~24MB) and runs reliably on CPU WASM,
# so the test works on machines without WebGPU.
DEFAULT_MODEL = 'kitten-nano'
TEST_TEXT = (
    'Hello. This is Yapper, a privacy-first text to speech engine '
    'running entirely in your browser. Mr. Smith approves.'
)


class CDPError(RuntimeError):
    pass


class CDPSession:
    def __init__(self, browser_ws_url: str):
        self.ws = websocket.create_connection(browser_ws_url, timeout=30)
        self._msg_id = 0
        self._sessions: dict[str, str] = {}

    def send(self, method: str, params=None, session_id=None):
        self._msg_id += 1
        msg = {'id': self._msg_id, 'method': method, 'params': params or {}}
        if session_id:
            msg['sessionId'] = session_id
        self.ws.send(json.dumps(msg))
        return self._msg_id

    def wait_for(self, msg_id: int, timeout: float = 30.0, debug: bool = False):
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
                if resp.get('id') == msg_id:
                    return resp
                if debug:
                    method = resp.get('method', '')
                    if method:
                        print(f'        [event] {method}', flush=True)
            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                continue
        return None

    def attach(self, target_id: str) -> str | None:
        msg_id = self.send('Target.attachToTarget', {'targetId': target_id, 'flatten': True})
        for _ in range(50):
            try:
                self.ws.settimeout(1)
                resp = json.loads(self.ws.recv())
                if resp.get('id') == msg_id:
                    sid = resp.get('result', {}).get('sessionId')
                    if sid:
                        self._sessions[target_id] = sid
                        return sid
                if resp.get('method') == 'Target.attachedToTarget':
                    sid = resp.get('params', {}).get('sessionId')
                    if sid:
                        self._sessions[target_id] = sid
                        return sid
            except websocket.WebSocketTimeoutException:
                continue
        return None

    def eval(self, expr: str, target_id: str, timeout: float = 30.0):
        sid = self._sessions.get(target_id)
        if not sid:
            raise CDPError('Not attached to target')
        msg_id = self.send(
            'Runtime.evaluate',
            {'expression': expr, 'returnByValue': True, 'awaitPromise': False},
            session_id=sid,
        )
        return self.wait_for(msg_id, timeout=timeout)

    def screenshot(self, target_id: str, path: Path) -> bool:
        sid = self._sessions.get(target_id)
        if not sid:
            raise CDPError('Not attached to target')
        msg_id = self.send(
            'Page.captureScreenshot',
            {'format': 'png', 'captureBeyondViewport': True},
            session_id=sid,
        )
        resp = self.wait_for(msg_id, timeout=30)
        if resp and 'result' in resp:
            data = resp['result'].get('data', '')
            if data:
                path.write_bytes(base64.b64decode(data))
                return True
        return False

    def close(self):
        self.ws.close()


def v(resp) -> dict:
    """Extract `.value` from a Runtime.evaluate response."""
    if not resp:
        return {}
    return resp.get('result', {}).get('result', {}).get('value') or {}


def banner(label: str):
    print(f'\n{"=" * 70}\n  {label}\n{"=" * 70}')


def fetch_cdp(path: str) -> dict:
    try:
        with urllib.request.urlopen(f'{CDP}{path}') as r:
            return json.loads(r.read())
    except (urllib.error.URLError, ConnectionError) as e:
        raise CDPError(f'Cannot reach CDP at {CDP}: {e}')


def step(n: int, total: int, label: str):
    print(f'\n[{n}/{total}] {label}')


def assert_true(cond: bool, msg: str):
    if not cond:
        print(f'      ❌ {msg}')
        sys.exit(1)
    print(f'      ✓ {msg}')


def main():
    banner('Yapper — E2E browser test via raw CDP')

    total = 9

    # 1. Discover Chrome
    step(1, total, f'Connecting to CDP at {CDP}')
    try:
        version = fetch_cdp('/json/version')
    except CDPError as e:
        print(f'      {e}')
        sys.exit(1)
    print(f'      Browser: {version.get("Browser", "?")}')
    print(f'      V8:      {version.get("V8-Version", "?")}')

    targets = fetch_cdp('/json/list')
    page_targets = [t for t in targets if t.get('type') == 'page']
    print(f'      Page targets: {len(page_targets)}')
    if not page_targets:
        print('      ❌ No page targets — open a tab first')
        sys.exit(1)
    target = page_targets[0]
    print(f'      Using: {target["url"][:80]}')

    # 2. Attach
    step(2, total, f'Attaching to target {target["id"][:16]}')
    browser_ws = version['webSocketDebuggerUrl']
    cdp = CDPSession(browser_ws)
    sid = cdp.attach(target['id'])
    if not sid:
        print('      ❌ Failed to attach')
        sys.exit(1)
    print(f'      ✓ Attached (session={sid[:16]}…)')

    # 3. Navigate
    step(3, total, f'Navigating to {URL}')
    cdp.send('Page.enable', session_id=sid)
    cdp.wait_for(cdp.send('Page.enable', session_id=sid))
    nav_id = cdp.send('Page.navigate', {'url': URL}, session_id=sid)
    cdp.wait_for(nav_id, timeout=10)
    print('      Waiting for app to render…')
    time.sleep(2)
    ready = cdp.eval(
        """(function() {
            return {
                title: document.title,
                hasApp: !!document.getElementById('app'),
                appChildren: document.getElementById('app')?.children.length || 0,
                models: document.querySelectorAll('.model-card').length,
                loadBtnExists: !!document.getElementById('load-btn'),
                gpuText: document.querySelector('.gpu-status__label')?.textContent?.trim(),
            };
        })()""",
        target['id'], timeout=10,
    )
    state = v(ready)
    print(f'      title:  {state.get("title")}')
    print(f'      models: {state.get("models")}')
    print(f'      GPU:    {state.get("gpuText", "")}')
    assert_true(state.get('hasApp'), '#app mounted')
    assert_true(state.get('models', 0) >= 5, f'{state.get("models")} model cards rendered')

    shot1 = SCREENSHOT_DIR / '01-initial-load.png'
    cdp.screenshot(target['id'], shot1)
    print(f'      → {shot1} ({shot1.stat().st_size // 1024} KB)')

    # 4. Select model
    step(4, total, f'Selecting model {DEFAULT_MODEL}')
    sel = cdp.eval(
        f"""(function() {{
            const card = document.querySelector('.model-card[data-model-id="{DEFAULT_MODEL}"]');
            if (!card) return {{ ok: false, msg: 'no card for {DEFAULT_MODEL}' }};
            card.click();
            return {{
                ok: true,
                selected: document.querySelector('.model-card--selected')?.dataset.modelId,
                name: card.querySelector('.model-card__name')?.textContent,
            }};
        }})()""",
        target['id'], timeout=10,
    )
    s = v(sel)
    print(f'      selected: {s.get("selected")}')
    print(f'      name:     {s.get("name")}')
    assert_true(s.get('selected') == DEFAULT_MODEL, f'{DEFAULT_MODEL} is selected')

    # 5. Click load
    step(5, total, 'Clicking "Download & Load Model"')
    click = cdp.eval(
        """(function() {
            const btn = document.getElementById('load-btn');
            if (!btn) return { ok: false };
            btn.click();
            return {
                ok: true,
                disabled: btn.disabled,
                label: document.getElementById('load-btn-label')?.textContent,
            };
        })()""",
        target['id'], timeout=5,
    )
    c = v(click)
    print(f'      btn disabled: {c.get("disabled")}')
    print(f'      btn label:    {c.get("label")}')
    assert_true(c.get('ok'), 'load button clicked')

    # 6. Wait for ready state
    step(6, total, 'Waiting for model load to complete')
    start = time.time()
    last_progress = None
    last_state = None
    ready_timeout = float(os.environ.get('YAPPER_LOAD_TIMEOUT', '600'))
    while time.time() - start < ready_timeout:
        poll = cdp.eval(
            """(function() {
                const banner = document.querySelector('.status-banner');
                const loadBtn = document.getElementById('load-btn');
                const genBtn = document.getElementById('generate-btn');
                const textarea = document.getElementById('text-input');
                return {
                    loadLabel: loadBtn?.querySelector('span')?.textContent,
                    bannerText: banner?.textContent?.trim()?.substring(0, 200),
                    bannerType: banner?.className,
                    genDisabled: genBtn?.disabled,
                    textareaDisabled: textarea?.disabled,
                };
            })()""",
            target['id'], timeout=10,
        )
        s = v(poll)
        prog = s.get('loadLabel', '') or ''
        if prog != last_progress:
            print(f'      [{int(time.time() - start):3d}s] {prog[:60]}')
            last_progress = prog

        # Capture mid-load screenshot at ~5s
        if int(time.time() - start) == 5:
            shot2 = SCREENSHOT_DIR / '02-loading.png'
            cdp.screenshot(target['id'], shot2)
            print(f'      → {shot2.name}')

        if s.get('loadLabel') and ('loaded' in s.get('loadLabel', '').lower()
                                   or '✓' in s.get('loadLabel', '')):
            print(f'\n      ✓ Model loaded')
            print(f'        banner:           {s.get("bannerText", "")[:80]}')
            print(f'        gen disabled:     {s.get("genDisabled")}')
            print(f'        textarea disabled: {s.get("textareaDisabled")}')
            last_state = 'ready'
            break

        if s.get('bannerType') and 'error' in s.get('bannerType'):
            print(f'      ❌ Error banner: {s.get("bannerText")}')
            shot_err = SCREENSHOT_DIR / '03-error.png'
            cdp.screenshot(target['id'], shot_err)
            sys.exit(1)

        time.sleep(3)

    if last_state != 'ready':
        print(f'      ❌ Model did not load within {ready_timeout}s')
        cdp.screenshot(target['id'], SCREENSHOT_DIR / '03-stuck.png')
        sys.exit(1)

    shot3 = SCREENSHOT_DIR / '03-ready.png'
    cdp.screenshot(target['id'], shot3)
    print(f'      → {shot3}')

    # 7. Type text
    step(7, total, f'Typing test text ({len(TEST_TEXT)} chars)')
    type_resp = cdp.eval(
        f"""(function() {{
            const ta = document.getElementById('text-input');
            ta.value = {json.dumps(TEST_TEXT)};
            ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
            return {{
                len: ta.value.length,
                charCount: document.getElementById('char-count')?.textContent,
            }};
        }})()""",
        target['id'], timeout=10,
    )
    t = v(type_resp)
    print(f'      typed: {t.get("len")} chars, char-count: {t.get("charCount")}')
    assert_true(t.get('len', 0) >= len(TEST_TEXT) - 2, 'text was typed into textarea')

    # 8. Click generate
    step(8, total, 'Clicking Generate (queues a TTS job)')
    gen = cdp.eval(
        """(function() {
            const btn = document.getElementById('generate-btn');
            if (btn.disabled) return { ok: false, msg: 'btn disabled' };
            btn.click();
            return { ok: true, ts: Date.now() };
        })()""",
        target['id'], timeout=15,
    )
    g = v(gen)
    assert_true(g.get('ok'), 'generate button clicked')
    print(f'      clicked at {g.get("ts")}')

    # 9. Poll for job completion + audio blob
    step(9, total, 'Polling for job completion (audio blob URL)')
    gen_timeout = float(os.environ.get('YAPPER_GEN_TIMEOUT', '300'))
    start = time.time()
    audio_ready = False
    while time.time() - start < gen_timeout:
        poll = cdp.eval(
            """(function() {
                const cards = Array.from(document.querySelectorAll('.job-card'));
                const jobs = cards.map(c => ({
                    status: Array.from(c.classList).find(x => x.startsWith('job-card--'))?.replace('job-card--', ''),
                    hasAudio: !!c.querySelector('audio[data-job-id]'),
                    audioSrc: c.querySelector('audio[data-job-id]')?.src?.substring(0, 60),
                    audioDuration: c.querySelector('audio[data-job-id]')?.duration,
                    text: c.querySelector('.job-card__text')?.textContent,
                }));
                const banner = document.querySelector('.status-banner');
                return {
                    jobs,
                    bannerType: banner?.className,
                    bannerText: banner?.textContent?.trim()?.substring(0, 120),
                };
            })()""",
            target['id'], timeout=10,
        )
        s = v(poll)
        jobs = s.get('jobs', [])
        if jobs:
            statuses = [j.get('status') for j in jobs]
            print(f'      [{int(time.time() - start):3d}s] jobs: {statuses}')

        done_job = next((j for j in jobs if j.get('status') == 'done' and j.get('hasAudio')), None)
        if done_job:
            print(f'\n      ✓ Audio generated')
            print(f'        status:   done')
            print(f'        src:      {done_job.get("audioSrc", "")[:60]}')
            print(f'        duration: {done_job.get("audioDuration")}s')
            print(f'        text:     {done_job.get("text", "")[:60]}')
            audio_ready = True
            break

        err_banner = s.get('bannerType') and 'error' in s.get('bannerType')
        if err_banner:
            print(f'      ❌ Error banner: {s.get("bannerText")}')
            cdp.screenshot(target['id'], SCREENSHOT_DIR / '04-gen-error.png')
            sys.exit(1)

        time.sleep(2)

    if not audio_ready:
        print(f'      ❌ No job reached done within {gen_timeout}s')
        cdp.screenshot(target['id'], SCREENSHOT_DIR / '04-stuck.png')
        sys.exit(1)

    shot4 = SCREENSHOT_DIR / '04-audio-output.png'
    cdp.screenshot(target['id'], shot4)
    print(f'      → {shot4} ({shot4.stat().st_size // 1024} KB)')

    cdp.close()
    print(f'\n{"=" * 70}')
    print('  ✓ ALL TESTS PASSED')
    print(f'  Screenshots in: {SCREENSHOT_DIR}')
    print(f'{"=" * 70}')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n\nInterrupted.')
        sys.exit(1)
    except Exception as e:
        import traceback
        print(f'\n❌ Fatal: {e}')
        traceback.print_exc()
        sys.exit(1)