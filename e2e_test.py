"""
Yapper — End-to-end browser test via raw CDP.

Drives a real Chrome instance through the full TTS workflow:
  1. Load the page
  2. Confirm model grid renders
  3. Pick a small model (Kitten TTS Nano, ~24MB, fast on CPU)
  4. Click "Download & Load Model" and wait for ready state
  5. Type text and click Generate
  6. Verify a job card appears and produces an audio blob

Usage:
    python e2e_test.py                                  # uses defaults
    YAPPER_CDP=http://host:9222 python e2e_test.py     # custom CDP
    YAPPER_URL=http://localhost:5173 python e2e_test.py  # dev server
    YAPPER_URL=https://phantomic12.github.io/yapper/ python e2e_test.py  # prod
    YAPPER_JUNIT=results.xml python e2e_test.py        # write JUnit XML
"""

import json
import time
import base64
import os
import sys
import traceback
from pathlib import Path
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
import websocket

CDP = os.environ.get('YAPPER_CDP', 'http://localhost:9222')
URL = os.environ.get('YAPPER_URL', 'https://phantomic12.github.io/yapper/')
SCREENSHOT_DIR = Path(os.environ.get('YAPPER_SHOTS', '/tmp/yapper-shots'))
JUNIT_PATH = os.environ.get('YAPPER_JUNIT', '')
SCREENSHOT_DIR.mkdir(exist_ok=True)

# Default to Kitten TTS Nano: smallest quantized model, runs on CPU WASM
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


# ─── Test harness ────────────────────────────────────────────────────────
# Each step in main() is wrapped in a TestCase. Results are aggregated
# so a JUnit XML report can be written for CI consumption, and so a single
# failure prints its step name + reason instead of just a stack trace.

class TestResult:
    def __init__(self, name: str):
        self.name = name
        self.passed = False
        self.failed = False
        self.error: str | None = None
        self.duration_ms: float = 0.0
        self.stdout: list[str] = []

    def record_pass(self, duration_ms: float):
        self.passed = True
        self.duration_ms = duration_ms

    def record_fail(self, error: str, duration_ms: float):
        self.failed = True
        self.error = error
        self.duration_ms = duration_ms


def run_step(name: str, fn) -> TestResult:
    """Run a test step. Prints its stdout. Captures failure as a TestResult
    instead of crashing the whole script. Returns the result."""
    result = TestResult(name)
    print(f'\n  [{name}]')
    start = time.time()
    try:
        fn()
        result.record_pass((time.time() - start) * 1000)
        print(f'  ✓ {name}')
    except SystemExit as e:
        # Step called sys.exit — treat as a failure but don't kill CI
        result.record_fail(f'sys.exit({e.code})', (time.time() - start) * 1000)
        print(f'  ✗ {name}: sys.exit({e.code})')
    except Exception as e:
        result.record_fail(str(e), (time.time() - start) * 1000)
        print(f'  ✗ {name}: {e}')
        traceback.print_exc()
    return result


def write_junit(results: list[TestResult], path: str):
    """Write a JUnit XML report. GitHub Actions parses this for the
    Checks tab. Schema: testsuites > testsuite > testcase."""
    total = len(results)
    failures = sum(1 for r in results if r.failed)
    total_time = sum(r.duration_ms for r in results) / 1000.0
    root = ET.Element('testsuites', {
        'name': 'yapper.e2e',
        'tests': str(total),
        'failures': str(failures),
        'time': f'{total_time:.3f}',
    })
    suite = ET.SubElement(root, 'testsuite', {
        'name': 'yapper',
        'tests': str(total),
        'failures': str(failures),
        'time': f'{total_time:.3f}',
    })
    for r in results:
        tc = ET.SubElement(suite, 'testcase', {
            'classname': 'yapper',
            'name': r.name,
            'time': f'{r.duration_ms / 1000.0:.3f}',
        })
        if r.failed:
            failure = ET.SubElement(tc, 'failure', {'message': r.error or 'failed'})
            failure.text = r.error or ''
        if r.passed:
            ET.SubElement(tc, 'system-out').text = '\n'.join(r.stdout)
    tree = ET.ElementTree(root)
    ET.indent(tree, space='  ')
    tree.write(path, encoding='utf-8', xml_declaration=True)
    print(f'\n  JUnit report: {path}')


# ─── Test steps ──────────────────────────────────────────────────────────

def step_connect_to_cdp(cdp_holder):
    version = fetch_cdp('/json/version')
    print(f'      Browser: {version.get("Browser", "?")}')
    print(f'      V8:      {version.get("V8-Version", "?")}')
    targets = fetch_cdp('/json/list')
    page_targets = [t for t in targets if t.get('type') == 'page']
    print(f'      Page targets: {len(page_targets)}')
    if not page_targets:
        raise CDPError('No page targets — open a tab first')
    cdp_holder['target'] = page_targets[0]
    print(f'      Using: {cdp_holder["target"]["url"][:80]}')


def step_attach_and_navigate(cdp_holder):
    target = cdp_holder['target']
    version = fetch_cdp('/json/version')
    browser_ws = version['webSocketDebuggerUrl']
    cdp = CDPSession(browser_ws)
    sid = cdp.attach(target['id'])
    if not sid:
        raise CDPError('Failed to attach to target')
    print(f'      ✓ Attached (session={sid[:16]}…)')
    cdp_holder['cdp'] = cdp

    cdp.send('Page.enable', session_id=sid)
    cdp.wait_for(cdp.send('Page.enable', session_id=sid))
    nav_id = cdp.send('Page.navigate', {'url': URL}, session_id=sid)
    cdp.wait_for(nav_id, timeout=10)
    print(f'      Navigated to {URL}; waiting for app render…')
    time.sleep(2)


def step_verify_page_render(cdp_holder):
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
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
    if not state.get('hasApp'):
        raise AssertionError('#app not mounted')
    if state.get('models', 0) < 5:
        raise AssertionError(f'Only {state.get("models")} model cards (expected ≥5)')
    shot1 = SCREENSHOT_DIR / '01-initial-load.png'
    cdp.screenshot(target['id'], shot1)
    print(f'      → {shot1} ({shot1.stat().st_size // 1024} KB)')


def step_select_model(cdp_holder):
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
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
    if s.get('selected') != DEFAULT_MODEL:
        raise AssertionError(f'selection failed: {s}')


def step_click_load(cdp_holder):
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    click = cdp.eval(
        """(function() {
            const btn = document.getElementById('load-btn');
            if (!btn) return { ok: false };
            btn.click();
            return { ok: true, disabled: btn.disabled };
        })()""",
        target['id'], timeout=5,
    )
    c = v(click)
    if not c.get('ok'):
        raise AssertionError('load-btn not found or click failed')
    print(f'      load-btn clicked (disabled={c.get("disabled")})')


def step_wait_for_model_ready(cdp_holder):
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    start = time.time()
    last_progress = None
    ready_timeout = float(os.environ.get('YAPPER_LOAD_TIMEOUT', '600'))
    while time.time() - start < ready_timeout:
        poll = cdp.eval(
            """(function() {
                const loadBtn = document.getElementById('load-btn');
                return {
                    loadLabel: loadBtn?.querySelector('span')?.textContent,
                };
            })()""",
            target['id'], timeout=10,
        )
        s = v(poll)
        prog = s.get('loadLabel', '') or ''
        if prog != last_progress:
            print(f'      [{int(time.time()-start):3d}s] {prog[:60]}')
            last_progress = prog

        if int(time.time() - start) == 5:
            cdp.screenshot(target['id'], SCREENSHOT_DIR / '02-loading.png')

        if prog and ('loaded' in prog.lower() or '✓' in prog):
            print(f'\n      ✓ Model loaded')
            cdp.screenshot(target['id'], SCREENSHOT_DIR / '03-ready.png')
            return

        time.sleep(3)
    raise AssertionError(f'Model did not load within {ready_timeout}s')


def step_type_and_generate(cdp_holder):
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    type_resp = cdp.eval(
        f"""(function() {{
            const ta = document.getElementById('text-input');
            ta.value = {json.dumps(TEST_TEXT)};
            ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
            return {{ len: ta.value.length }};
        }})()""",
        target['id'], timeout=10,
    )
    t = v(type_resp)
    if t.get('len', 0) < 50:
        raise AssertionError(f'failed to type into textarea: {t}')
    print(f'      typed: {t.get("len")} chars')

    time.sleep(0.5)
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
    if not g.get('ok'):
        raise AssertionError(f'generate-btn not clickable: {g.get("msg")}')
    print(f'      generate clicked at {g.get("ts")}')


def step_wait_for_audio(cdp_holder):
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    gen_timeout = float(os.environ.get('YAPPER_GEN_TIMEOUT', '300'))
    start = time.time()
    while time.time() - start < gen_timeout:
        poll = cdp.eval(
            """(function() {
                const cards = Array.from(document.querySelectorAll('.job-card'));
                const jobs = cards.map(c => ({
                    status: Array.from(c.classList).find(x => x.startsWith('job-card--'))?.replace('job-card--', ''),
                    hasAudio: !!c.querySelector('audio[data-job-id]'),
                    audioDuration: c.querySelector('audio[data-job-id]')?.duration,
                }));
                return { jobs };
            })()""",
            target['id'], timeout=10,
        )
        s = v(poll)
        jobs = s.get('jobs', [])
        if jobs:
            print(f'      [{int(time.time()-start):3d}s] statuses={[j.get("status") for j in jobs]}')
        done_job = next((j for j in jobs if j.get('status') == 'done' and j.get('hasAudio')), None)
        if done_job:
            print(f'      ✓ Audio: duration={done_job.get("audioDuration")}s')
            cdp.screenshot(target['id'], SCREENSHOT_DIR / '04-audio-output.png')
            return
        time.sleep(2)
    raise AssertionError(f'no job reached done within {gen_timeout}s')


# ─── Driver ──────────────────────────────────────────────────────────────

def main():
    banner('Yapper — E2E browser test via raw CDP')

    cdp_holder: dict = {}
    results: list[TestResult] = []

    steps = [
        ('connect_to_cdp', lambda: step_connect_to_cdp(cdp_holder)),
        ('attach_and_navigate', lambda: step_attach_and_navigate(cdp_holder)),
        ('verify_page_render', lambda: step_verify_page_render(cdp_holder)),
        ('select_model', lambda: step_select_model(cdp_holder)),
        ('click_load', lambda: step_click_load(cdp_holder)),
        ('wait_for_model_ready', lambda: step_wait_for_model_ready(cdp_holder)),
        ('type_and_generate', lambda: step_type_and_generate(cdp_holder)),
        ('wait_for_audio', lambda: step_wait_for_audio(cdp_holder)),
    ]

    for name, fn in steps:
        results.append(run_step(name, fn))

    # Close CDP if open
    cdp = cdp_holder.get('cdp')
    if cdp is not None:
        try:
            cdp.close()
        except Exception:
            pass

    failures = sum(1 for r in results if r.failed)
    print(f'\n{"=" * 70}')
    if failures == 0:
        print(f'  ✓ ALL {len(results)} STEPS PASSED')
    else:
        print(f'  ✗ {failures}/{len(results)} STEPS FAILED')
    print(f'  Screenshots in: {SCREENSHOT_DIR}')
    print(f'{"=" * 70}')

    if JUNIT_PATH:
        write_junit(results, JUNIT_PATH)

    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n\nInterrupted.')
        sys.exit(1)
    except Exception as e:
        print(f'\n❌ Fatal: {e}')
        traceback.print_exc()
        sys.exit(1)