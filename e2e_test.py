"""
Yapper — End-to-end browser test via raw CDP.

Drives a real Chrome instance through the full TTS workflow:
  1. Load the page
  2. Confirm model grid renders
  3. Pick a small model (Kitten TTS Nano, ~24MB, fast on CPU)
  4. Click "Download & Load Model" and wait for ready state
  5. Type text and click Generate
  6. Verify a job card appears and produces an audio blob
  7. Upload a TXT document and verify extracted text renders as sentences
  8. Queue a read of that document ("Read aloud") with the loaded model
  9. Verify the live sentence/word highlight advances during playback
 10. Stop the read, then upload a PDF and verify pdfjs text extraction

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

# Small documents committed alongside this script (see e2e/fixtures/). The
# PDF is a 641-byte single-page file whose text layer holds two lines, so
# pdfjs extraction is instant and adds no OCR/model weight to the run.
FIXTURES_DIR = Path(os.environ.get(
    'YAPPER_FIXTURES',
    str(Path(__file__).resolve().parent / 'e2e' / 'fixtures'),
))


class CDPError(RuntimeError):
    pass


class CDPSession:
    def __init__(self, browser_ws_url: str):
        self.ws = websocket.create_connection(browser_ws_url, timeout=30)
        self._msg_id = 0
        self._sessions: dict[str, str] = {}
        # URLs of every target the browser auto-attaches us to. Populated
        # from Target.attachedToTarget events sniffed inside wait_for().
        self.attached_targets: list[dict] = []

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
                if resp.get('method') == 'Target.attachedToTarget':
                    info = resp.get('params', {}).get('targetInfo', {})
                    if info.get('url'):
                        self.attached_targets.append(info)
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

    def eval_async(self, expr: str, target_id: str, timeout: float = 30.0):
        """Evaluate an async IIFE / promise expression and await its result."""
        sid = self._sessions.get(target_id)
        if not sid:
            raise CDPError('Not attached to target')
        msg_id = self.send(
            'Runtime.evaluate',
            {'expression': expr, 'returnByValue': True, 'awaitPromise': True},
            session_id=sid,
        )
        return self.wait_for(msg_id, timeout=timeout)

    def click_at(self, target_id: str, x: float, y: float):
        """Dispatch a trusted mouse click at viewport coordinates via the
        Input domain. Unlike element.click(), this counts as a user gesture
        in the renderer (user activation is set), which the reader's audio
        autoplay path needs."""
        sid = self._sessions.get(target_id)
        if not sid:
            raise CDPError('Not attached to target')
        for type_, button in (('mousePressed', 'left'), ('mouseReleased', 'left')):
            msg_id = self.send(
                'Input.dispatchMouseEvent',
                {
                    'type': type_,
                    'x': x, 'y': y,
                    'button': button,
                    'clickCount': 1,
                },
                session_id=sid,
            )
            resp = self.wait_for(msg_id, timeout=10)
            if resp and 'error' in resp:
                raise CDPError(f'Input.dispatchMouseEvent failed: {resp["error"]}')

    def find_element(self, target_id: str, selector: str) -> dict | None:
        """Resolve a CSS selector to a CDP node object (for DOM.* commands)."""
        # Runtime.evaluate with returnByValue=False hands back a RemoteObjectId
        # for the node, which DOM.getBoxModel etc. accept.
        msg_id = self.send(
            'Runtime.evaluate',
            {
                'expression': f'document.querySelector({json.dumps(selector)})',
                'returnByValue': False,
                'objectGroup': 'e2e',
            },
            session_id=self._sessions[target_id],
        )
        resp = self.wait_for(msg_id, timeout=10)
        if not resp or 'error' in resp:
            return None
        obj = resp.get('result', {}).get('result', {})
        if obj.get('subtype') == 'null' or 'objectId' not in obj:
            return None
        return {'objectId': obj['objectId']}

    def get_box_model(self, target_id: str, object_id: str) -> tuple[float, float] | None:
        """Return the (x, y) of an element's content-box top-left."""
        msg_id = self.send(
            'DOM.getBoxModel', {'objectId': object_id},
            session_id=self._sessions[target_id],
        )
        resp = self.wait_for(msg_id, timeout=10)
        if not resp or 'result' not in resp:
            return None
        quad = [float(n) for n in resp['result']['model']['content']]
        return quad[0], quad[1]

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

    def get_browser_targets(self) -> list[dict]:
        """Browser-level Target.getTargets — includes dedicated workers."""
        msg_id = self.send('Target.getTargets')
        resp = self.wait_for(msg_id, timeout=10)
        if resp and 'result' in resp:
            infos = resp['result'].get('targetInfos', [])
            assert isinstance(infos, list)
            return infos
        return []


def v(resp) -> dict:
    """Extract `.value` from a Runtime.evaluate response."""
    if not resp:
        return {}
    return resp.get('result', {}).get('result', {}).get('value') or {}


def banner(label: str):
    print(f'\n{"=" * 70}\n  {label}\n{"=" * 70}')


def fetch_cdp(path: str):
    try:
        with urllib.request.urlopen(f'{CDP}{path}') as r:
            return json.loads(r.read())
    except (urllib.error.URLError, ConnectionError) as e:
        raise CDPError(f'Cannot reach CDP at {CDP}: {e}')


def list_targets() -> list[dict]:
    """All CDP targets (pages, workers, iframes, …) via the HTTP endpoint."""
    targets = fetch_cdp('/json/list')
    assert isinstance(targets, list)
    return targets


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
    # Observe child targets (dedicated workers, iframes, …) from the PAGE
    # session. Browser-level auto-attach does NOT report dedicated workers
    # on current Chrome (verified on 151: /json/list, browser-level
    # Target.getTargets and browser-scope setAutoAttach all omit them),
    # while page-scope setAutoAttach fires Target.attachedToTarget when
    # the engine spawns the inference module worker. Enabled here, before
    # any load, so the spawn event can't slip past us.
    cdp.wait_for(cdp.send('Target.setAutoAttach', {
        'autoAttach': True, 'waitForDebuggerOnStart': False, 'flatten': True,
    }, session_id=sid), timeout=10)
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
              // Click handler lives on the inner [data-action="pick"] button,
              // not the outer .model-card div (see src/ui/model-panel.ts).
              // Calling card.click() on the div would fire on the wrong target.
              const pickBtn = card.querySelector('[data-action="pick"]');
              if (!pickBtn) return {{ ok: false, msg: 'no pick button on card' }};
              pickBtn.click();
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


def step_verify_worker_chunk_loaded(cdp_holder):
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    # The engine spawns inference in a dedicated module Worker from inside
    # WorkerBackedEngine.load(), so by now (model ready) it must exist.
    # Under the production bundle its URL is /assets/inference-worker-*.js;
    # under the Vite dev server it is /src/...?worker_file&type=module.
    # Either way the page-scope auto-attach enabled during navigation has
    # delivered a Target.attachedToTarget event for it (browser-level
    # discovery surfaces don't list dedicated workers on current Chrome).
    workers = [t for t in cdp.attached_targets
               if 'inference-worker' in t.get('url', '')]
    if not workers:
        raise AssertionError(
            'no inference worker target found. This means Vite did not '
            'emit it OR the engine did not spawn the worker — inference '
            'would be running on the main thread.'
        )
    print(f'      ✓ live inference worker target (url=…{str(workers[0].get("url", ""))[-50:]})')


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


# ─── Live generation progress (ticking timer) ────────────────────────────

JOB_HINT_SNAPSHOT_JS = """(function() {
    const cards = Array.from(document.querySelectorAll('.job-card'));
    return cards.map(c => ({
        status: Array.from(c.classList).find(x => x.startsWith('job-card--'))
            ?.replace('job-card--', ''),
        hint: c.querySelector('[data-role="job-hint"]')?.textContent
            || c.querySelector('.job-card__hint')?.textContent || null,
        progressMode: c.querySelector('[data-role="job-progress"]')?.getAttribute('data-mode') || null,
    }));
})()"""


def step_assert_progress_ticks(cdp_holder):
    """AC: during a generation the card text must change at least twice over
    a 3s window (the ~500ms heartbeat drives a live seconds counter).

    Runs right after generate is clicked, while kitten-nano is still busy —
    if the job already finished (very fast machine) the step degrades to a
    no-op so CI doesn't flake on speed.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    def snap():
        return v(cdp.eval(JOB_HINT_SNAPSHOT_JS, target['id'], timeout=10))

    first = snap()
    gen_cards = [c for c in first if c.get('status') == 'generating']
    if not gen_cards:
        # Generation already finished before we sampled. Not a failure of
        # the feature — just too fast to observe.
        print('      (skip: job finished before progress could be sampled)')
        return

    samples = [gen_cards[0].get('hint')]
    deadline = time.time() + 3.0
    while time.time() < deadline:
        time.sleep(0.5)
        cur = snap()
        card = next((c for c in cur if c.get('status') == 'generating'), None)
        if card is None:
            break  # finished mid-window; judge on what we captured
        samples.append(card.get('hint'))

    distinct = len({s for s in samples if s})
    print(f'      hints observed over 3s: {samples}')
    if distinct < 2:
        raise AssertionError(
            f'generating card text changed {distinct}x over 3s '
            f'(need ≥2 for a ticking timer). Samples: {samples}. '
            f'This means the heartbeat is not reaching the UI.'
        )
    bar_modes = {c.get('progressMode') for c in first if c.get('status') == 'generating'}
    print(f'      ✓ timer ticks ({distinct} distinct hints), progress bar modes seen: {bar_modes}')


def _run_kokoro_generation(cdp_holder, text: str):
    """Select Kokoro q8f16, wait for load, queue a multi-sentence job."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    resp = cdp.eval(
        """(function() {
            // The pick handler lives on the inner [data-action="pick"]
            // button, not the outer .model-card div (see select_model step
            // and src/ui/model-panel.ts).
            const card = document.querySelector('.model-card[data-model-id="kokoro-82m"]');
            if (!card) return { ok: false, msg: 'no kokoro-82m model card' };
            const pickBtn = card.querySelector('[data-action="pick"]');
            if (!pickBtn) return { ok: false, msg: 'no pick button on kokoro card' };
            pickBtn.click();
            const loadBtn = document.getElementById('load-btn');
            if (!loadBtn || loadBtn.disabled) return { ok: false, msg: 'load button unavailable' };
            loadBtn.click();
            return { ok: true };
        })()""",
        target['id'], timeout=15,
    )
    r = v(resp)
    if not r.get('ok'):
        raise AssertionError(f'could not start Kokoro load: {r}')

    ready_timeout = float(os.environ.get('YAPPER_KOKORO_LOAD_TIMEOUT', '420'))
    start = time.time()
    while time.time() - start < ready_timeout:
        poll = v(cdp.eval(
            """(function() {
                const banner = document.querySelector('.status-banner');
                return {
                    state: document.getElementById('gpu-status-label')?.textContent
                        || document.querySelector('.load-btn')?.textContent || '',
                    error: banner?.classList.contains('status-banner--error')
                        ? banner.textContent : null,
                };
            })()""",
            target['id'], timeout=10,
        ))
        if poll.get('error'):
            raise AssertionError(f'Kokoro load failed: {poll["error"]}')
        # The load button label flips to "Model ready" style states; detect
        # readiness via the loaded model card class instead.
        loaded = v(cdp.eval(
            """(function() {
                const card = document.querySelector('.model-card[data-model-id="kokoro-82m"]');
                return { loaded: !!(card && card.classList.contains('model-card--loaded')) };
            })()""",
            target['id'], timeout=10,
        ))
        if loaded.get('loaded'):
            print(f'      ✓ kokoro-82m loaded in {int(time.time()-start)}s')
            break
        time.sleep(2)
    else:
        raise AssertionError(f'kokoro-82m did not become ready within {ready_timeout}s')

    type_resp = v(cdp.eval(
        f"""(function() {{
            const ta = document.getElementById('text-input');
            ta.value = {json.dumps(text)};
            ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
            document.getElementById('generate-btn').click();
            return {{ ok: true }};
        }})()""",
        target['id'], timeout=15,
    ))
    if not type_resp.get('ok'):
        raise AssertionError(f'failed to enqueue Kokoro job: {type_resp}')


def step_kokoro_segment_progress(cdp_holder):
    """AC: Kokoro on a multi-sentence input shows sentence-segment progress.

    Loads kokoro-82m (~86MB), generates a long multi-paragraph input, and
    asserts the hint ever showed a "sentence N" / "N sentences" segment
    marker. The input must be LONG enough to exceed kokoro-js's per-chunk
    token budget: short inputs are merged into ONE stream chunk, which
    emits exactly one segmentsDone=1 event — deliberately rendered as a
    bare timer by the UI (see formatGeneratingHint) — and can never
    satisfy this assertion.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    para = (
        'The quick brown fox jumps over the lazy dog while yapper reads '
        'every sentence aloud. Progress ticks as each segment completes, '
        'so a stalled generation is visible within seconds.'
    )
    # Six paragraphs ≈ 24 sentences / ~800 chars — comfortably over
    # kokoro-js's per-chunk token budget, guaranteeing multiple stream
    # chunks (and thus a segmentsDone>=2 event the UI renders).
    text = ' '.join(f'{para} ({i})' for i in range(1, 7))
    _run_kokoro_generation(cdp_holder, text)

    seg_timeout = float(os.environ.get('YAPPER_KOKORO_GEN_TIMEOUT', '420'))
    start = time.time()
    saw_segment = False
    last_print = ''
    done = False
    while time.time() - start < seg_timeout:
        s = v(cdp.eval(JOB_HINT_SNAPSHOT_JS, target['id'], timeout=10))
        gen_hints = [c.get('hint') or '' for c in s if c.get('status') == 'generating']
        label = gen_hints[0] if gen_hints else '(none generating)'
        if label != last_print:
            print(f'      [{int(time.time()-start):3d}s] {label}')
            last_print = label
        if any(('sentence' in h.lower()) for h in gen_hints):
            saw_segment = True
        if not gen_hints and any(c.get('status') == 'done' for c in s):
            done = True
            break
        time.sleep(0.5)
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '08-kokoro-progress.png')
    if not saw_segment:
        raise AssertionError(
            'kokoro generation completed without ever showing segment '
            f'progress ("sentence N" hint) within {seg_timeout}s'
        )
    print(f'      ✓ segment progress observed (job done={done})')


# ─── Document reader flow ────────────────────────────────────────────────
# The marquee feature: drop a document, watch the extracted text render as
# sentence spans, queue a read through the loaded engine, and confirm the
# live sentence/word highlight advances while playback runs.

# Injects a synthetic File into the hidden #document-upload input via a
# DataTransfer and fires 'change' — the exact event path a real picker
# upload takes (handleFile in src/ui/document-panel.ts). A raw CDP browser
# has no filesystem access to the host, so DOM.setFileInputFiles cannot be
# used against a remote container Chrome; a DataTransfer-built File is the
# faithful alternative.
INJECT_FILE_JS = """(function() {
    const bin = atob(%(b64)s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], %(name)s, { type: %(mime)s });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('document-upload');
    if (!input) return { ok: false, msg: 'no #document-upload input' };
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, name: file.name, size: file.size };
})()"""

READER_STATE_JS = """(function() {
    const view = document.getElementById('document-reader-view');
    const overlay = document.getElementById('reader-overlay');
    const active = document.querySelector('.reader-active-sentence');
    const activeWord = document.querySelector('.reader-active-word');
    return {
        previewVisible: (() => {
            const p = document.getElementById('document-preview');
            return !!p && p.style.display !== 'none';
        })(),
        sentenceCount: view ? view.querySelectorAll('.reader-sentence').length : 0,
        wordCount: view ? view.querySelectorAll('.reader-word').length : 0,
        text: view ? (view.textContent || '') : '',
        progressText: document.getElementById('document-progress')?.textContent || '',
        overlayOpen: !!overlay && overlay.style.display !== 'none',
        readerStatus: document.getElementById('reader-status')?.textContent || '',
        overlayStatus: document.getElementById('reader-overlay-status')?.textContent || '',
        pauseLabel: (document.getElementById('pause-document-btn') || {}).textContent || null,
        readerError: document.querySelector('.reader-error')?.textContent
            || document.getElementById('reader-error')?.textContent || null,
        statusBanner: document.querySelector('.status-banner span')?.textContent || null,
        jobCards: Array.from(document.querySelectorAll('.job-card')).map(c => ({
            status: Array.from(c.classList).find(x => x.startsWith('job-card--'))
                ?.replace('job-card--', ''),
        })),
        activeSentenceIndex: active ? Number(active.dataset.sentenceIndex) : null,
        activeWordIndex: activeWord ? Number(activeWord.dataset.wordIndex) : null,
    };
})()"""


def _inject_file(cdp, target_id, path: Path, mime: str):
    import base64 as b64mod
    b64 = b64mod.b64encode(path.read_bytes()).decode()
    js = INJECT_FILE_JS % {'b64': json.dumps(b64), 'name': json.dumps(path.name), 'mime': json.dumps(mime)}
    resp = cdp.eval(js, target_id, timeout=15)
    r = v(resp)
    if not r.get('ok'):
        raise AssertionError(f'file injection failed: {r}')
    print(f'      injected {path.name} ({path.stat().st_size} bytes)')


def step_upload_txt_document(cdp_holder):
    """Drop the TXT fixture and assert the reader view renders its sentences."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    _inject_file(cdp, target['id'], FIXTURES_DIR / 'sample.txt', 'text/plain')

    extract_timeout = float(os.environ.get('YAPPER_EXTRACT_TIMEOUT', '60'))
    start = time.time()
    s: dict = {}
    while time.time() - start < extract_timeout:
        resp = cdp.eval(READER_STATE_JS, target['id'], timeout=10)
        s = v(resp)
        if s.get('previewVisible') and s.get('sentenceCount', 0) >= 3 \
                and 'quick brown fox' in s.get('text', '') \
                and 'liquor jugs' in s.get('text', ''):
            print(f'      ✓ TXT extracted: {s["sentenceCount"]} sentences, '
                  f'{s["wordCount"]} words, progress="{s["progressText"][:50]}"')
            cdp.screenshot(target['id'], SCREENSHOT_DIR / '05-txt-extracted.png')
            return
        time.sleep(1)
    raise AssertionError(
        f'TXT text did not render in the reader view within {extract_timeout}s: '
        f'previewVisible={s.get("previewVisible")} sentences={s.get("sentenceCount")} '
        f'text[:80]={s.get("text", "")[:80]!r}')


def step_queue_reader_read(cdp_holder):
    """Click 'Read aloud' with a trusted CDP mouse click so audio autoplay
    counts as user-initiated, then confirm the reader session started."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    btn = cdp.find_element(target['id'], '#read-document-btn')
    if not btn:
        raise AssertionError('#read-document-btn not found')
    box = cdp.get_box_model(target['id'], btn['objectId'])
    if not box:
        raise AssertionError('could not measure #read-document-btn position')
    x, y = box[0] + 6, box[1] + 6
    cdp.click_at(target['id'], x, y)
    print(f'      clicked Read aloud at ({x:.0f}, {y:.0f})')

    start_timeout = float(os.environ.get('YAPPER_READ_START_TIMEOUT', '90'))
    start = time.time()
    s: dict = {}
    while time.time() - start < start_timeout:
        resp = cdp.eval(READER_STATE_JS, target['id'], timeout=10)
        s = v(resp)
        if s.get('overlayOpen') or s.get('activeSentenceIndex') is not None:
            print(f'      ✓ reading: overlayOpen={s.get("overlayOpen")} '
                  f'status="{s.get("readerStatus")}" jobs={s.get("jobCards")}')
            return
        if s.get('readerStatus') == 'Finished':
            raise AssertionError('reader finished instantly without playing')
        time.sleep(1)
    raise AssertionError(
        f'reader did not start within {start_timeout}s: '
        f'state={json.dumps(s, default=str)}'
        f'. If this fails only in CI, launch Chrome '
        f'with --autoplay-policy=no-user-gesture-required.')


def step_assert_highlight_advances(cdp_holder):
    """While the read plays, the highlighted sentence/word must move forward."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    # Budget covers worst-case first-chunk synthesis (~25s observed on CPU)
    # plus playback to the second word/sentence; exits early on success.
    window_s = float(os.environ.get('YAPPER_HIGHLIGHT_WINDOW', '120'))
    start = time.time()
    s: dict = {}
    first = None
    last = None
    last_print = ''
    while time.time() - start < window_s:
        resp = cdp.eval(READER_STATE_JS, target['id'], timeout=10)
        s = v(resp)
        cur = (s.get('activeSentenceIndex'), s.get('activeWordIndex'))
        label = f'sentence={cur[0]} word={cur[1]}'
        if label != last_print:
            print(f'      [{int(time.time()-start):3d}s] highlight {label} '
                  f'status="{s.get("readerStatus")}"')
            last_print = label
        if cur[0] is not None:
            if first is None:
                first = cur
            last = cur
            if (last[0] or 0) > (first[0] or 0) or (
                    last[0] == first[0] and (last[1] or 0) > (first[1] or 0)):
                print(f'      ✓ highlight advanced: {first} → {last}')
                cdp.screenshot(target['id'], SCREENSHOT_DIR / '06-highlight-advanced.png')
                return
        if s.get('readerStatus') == 'Finished' and last is not None:
            break
        time.sleep(1)
    raise AssertionError(
        f'highlight never advanced within {window_s}s '
        f'(first={first}, last={last}) state={json.dumps(s, default=str)}')


def step_stop_reader(cdp_holder):
    """Stop playback via the overlay Stop button and confirm teardown."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    btn = cdp.find_element(target['id'], '#reader-overlay-stop')
    if not btn:
        raise AssertionError('#reader-overlay-stop not found')
    box = cdp.get_box_model(target['id'], btn['objectId'])
    if not box:
        raise AssertionError('could not measure #reader-overlay-stop position')
    cdp.click_at(target['id'], box[0] + 6, box[1] + 6)
    time.sleep(1)
    resp = cdp.eval(READER_STATE_JS, target['id'], timeout=10)
    s = v(resp)
    if s.get('overlayOpen'):
        raise AssertionError('reader overlay still open after Stop')
    print(f'      ✓ reader stopped, overlay closed (status="{s.get("readerStatus")}")')


def step_upload_pdf_document(cdp_holder):
    """Drop the PDF fixture and assert pdfjs text extraction renders."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    # pdfjs-dist 6's fake-worker fallback requires Promise.try (Chrome ≥~128).
    # On older engines extraction dies with "Promise.try is not a function"
    # and the panel sticks on "Reading PDF file…" — an engine gap, not an app
    # regression. CI installs Chrome stable (which has it); degrade here.
    cap = v(cdp.eval(
        "({ hasPromiseTry: typeof Promise.try === 'function' })",
        target['id'], timeout=10,
    ))
    if not cap.get('hasPromiseTry'):
        print('      (skip: browser lacks Promise.try — pdfjs 6 needs Chrome ≥~128; '
              'CI uses Chrome stable)')
        return

    _inject_file(cdp, target['id'], FIXTURES_DIR / 'sample.pdf', 'application/pdf')

    extract_timeout = float(os.environ.get('YAPPER_EXTRACT_TIMEOUT', '120'))
    start = time.time()
    s: dict = {}
    while time.time() - start < extract_timeout:
        resp = cdp.eval(READER_STATE_JS, target['id'], timeout=10)
        s = v(resp)
        text = s.get('text', '')
        # The app now fails fast with an inline reader-panel error when the
        # engine can't run pdfjs 6 (missing Promise.try) or extraction
        # stalls — either way that's an environment failure worth flagging
        # loudly instead of waiting out the clock.
        if s.get('readerError'):
            raise AssertionError(f'reader panel surfaced an error: {s.get("readerError")!r}')
        if ('end-to-end test PDF' in text and 'Second line proves' in text
                and s.get('previewVisible')):
            print(f'      ✓ PDF extracted: {s["sentenceCount"]} sentences from '
                  f'{s["progressText"][:60]!r}')
            cdp.screenshot(target['id'], SCREENSHOT_DIR / '07-pdf-extracted.png')
            return
        time.sleep(1)
    raise AssertionError(
        f'PDF text did not render within {extract_timeout}s: '
        f'previewVisible={s.get("previewVisible")} '
        f'progress="{s.get("progressText")}" banner={s.get("statusBanner")!r} '
        f'readerError={s.get("readerError")!r} '
        f'text[:100]={s.get("text", "")[:100]!r}')


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
        ('verify_worker_chunk_loaded', lambda: step_verify_worker_chunk_loaded(cdp_holder)),
        ('type_and_generate', lambda: step_type_and_generate(cdp_holder)),
        ('assert_progress_ticks', lambda: step_assert_progress_ticks(cdp_holder)),
        ('wait_for_audio', lambda: step_wait_for_audio(cdp_holder)),
        # Document reader flow (marquee feature): upload TXT → render →
        # queue read on the already-loaded kitten-nano model → highlight
        # advances → stop, then upload PDF and confirm pdfjs extraction.
        # MUST run before the Kokoro step: Kokoro on CPU/WASM occupies the
        # inference queue for minutes, which would starve the reader jobs
        # (single-worker queue) and flake highlight/PDF assertions.
        ('upload_txt_document', lambda: step_upload_txt_document(cdp_holder)),
        ('queue_reader_read', lambda: step_queue_reader_read(cdp_holder)),
        ('assert_highlight_advances', lambda: step_assert_highlight_advances(cdp_holder)),
        ('stop_reader', lambda: step_stop_reader(cdp_holder)),
        ('upload_pdf_document', lambda: step_upload_pdf_document(cdp_holder)),
        # Live progress on Kokoro's streaming path, LAST: load the bigger
        # model, generate a multi-sentence input, and confirm sentence-
        # segment markers appear in the card hint while it runs. Slow on
        # CPU/WASM, so nothing is queued behind it.
        ('kokoro_segment_progress', lambda: step_kokoro_segment_progress(cdp_holder)),
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