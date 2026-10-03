"""
Yapper — End-to-end browser test via raw CDP.

Drives a real Chrome instance through the full TTS workflow:
  1. Load the page
  2. Confirm model grid renders
  3. Pick a small model (Kitten TTS Nano, ~24MB, fast on CPU)
  4. The selected model auto-downloads; wait for the ready state
  5. Type text and click Generate
  6. Verify a job card appears and produces an audio blob
  7. Upload a TXT document and verify extracted text renders as sentences
  8. Queue a read of that document ("Read aloud") with the loaded model
  9. Verify the live sentence/word highlight advances during playback
 10. Stop the read, then upload a PDF and verify pdfjs text extraction
 11. Reader document views: rendered PDF pages, DOCX/EPUB stamped markup
     with chapter navigation, XLSX tables joined to workbook sheet names,
     and PPTX slides with shape geometry from the file

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
import re
import fnmatch
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

# The step markers below are ✓ / ✗ / ❌, and Windows consoles default to
# cp1252, which cannot encode them. Without this, the *first* failing step
# raises UnicodeEncodeError while printing its own error, so the run dies with
# a traceback instead of a result — the harness becomes unusable for reporting
# the very failures it exists to catch. reconfigure() is 3.7+.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, ValueError):  # pragma: no cover - exotic stdout
    pass

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


def step_verify_page_render(cdp_holder):
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    # Poll for the app to actually mount. A fixed sleep raced a cold
    # dev-server profile: the first page load pays for Vite's initial
    # module transform, which can take far longer than any fixed wait, and
    # every downstream step then cascaded off '#app not mounted'.
    POLL_TIMEOUT = float(os.environ.get('YAPPER_RENDER_TIMEOUT', '60'))
    start = time.time()
    state: dict = {}
    while time.time() - start < POLL_TIMEOUT:
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
        if state.get('models', 0) >= 5:
            break
        time.sleep(1)

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


MODE_STATE_JS = """(function() {
    const shown = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return getComputedStyle(el).display !== 'none';
    };
    // Every scrap of copy a first-time visitor can actually read right now:
    // walk the rendered tree, keep what is genuinely on screen, and report
    // the memory figures. Unit tests assert the same rule against the markup
    // (src/advanced-mode.test.ts); this one trusts the stylesheet instead,
    // so a region marked data-advanced that the CSS failed to hide is caught
    // here rather than by a user.
    const visibleSizeFigures = (() => {
        const SIZE = /\\d+(?:\\.\\d+)?\\s*(?:MB|MiB|KB|GB)\\b/i;
        // One surface is allowed to quote a number: the upload cap, which is
        // a limit the user has to respect before they pick a file, not a
        // description of what the app is downloading. Selector-based on
        // purpose — it cannot be defeated by a reword. The fp16-fallback
        // warning is *not* exempt: it is always visible, so it carries a
        // plain-language sentence in this view and puts its byte counts in a
        // data-advanced span instead.
        const ALLOWED = '#document-formats';
        const hits = [];
        const walk = (el) => {
            if (el.nodeType !== 1) return;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            const allowed = el.closest(ALLOWED) !== null;
            let text = '';
            for (const n of el.childNodes) {
                if (n.nodeType === 3) text += n.textContent;
            }
            text = text.trim();
            if (!allowed && (SIZE.test(text) || SIZE.test(el.title || ''))) {
                hits.push(`${el.tagName.toLowerCase()}.${el.className || '-'}: ${text || el.title}`);
            }
            for (const child of el.children) walk(child);
        };
        walk(document.querySelector('#app') || document.body);
        return hits;
    })();
    return {
        advanced: document.documentElement.dataset.advanced === 'on',
        stored: localStorage.getItem('yapper.advanced.v1'),
        togglePressed: document.getElementById('advanced-toggle')
            ?.getAttribute('aria-pressed') || null,
        toggleLabel: document.getElementById('advanced-toggle-label')
            ?.textContent || null,
        modelGrid: shown('#model-grid'),
        qualityPresets: shown('#quality-presets'),
        activePreset: document.querySelector('.quality-preset--active')
            ?.dataset.quality || null,
        bottomBar: shown('#bottom-bar'),
        bottomPreset: document.getElementById('bottom-bar-preset')?.textContent || null,
        bottomModel: document.getElementById('bottom-bar-model')?.textContent || null,
        languageFilter: shown('.language-select-wrapper'),
        speedRow: shown('.speed-row'),
        textInput: shown('#text-input'),
        loadBtn: shown('#load-btn'),
        presetBlurbs: [...document.querySelectorAll('.quality-preset__blurb')]
            .map(el => el.textContent.trim()),
        presetSizesShown: [...document.querySelectorAll('.quality-preset__size')]
            .map(el => getComputedStyle(el).display !== 'none'),
        // How many of the two fp16-fallback sentences are on screen. One per
        // view, never two: the simple one is data-simple, the technical one
        // is data-advanced, and the stylesheet keeps them apart.
        f16Sentences: ['f16-copy', 'f16-copy-detail']
            .filter(role => {
                const el = document.querySelector(`[data-role="${role}"]`);
                return !!el && getComputedStyle(el).display !== 'none' && !!el.textContent.trim();
            }).length,
        sizeFigures: visibleSizeFigures,
    };
})()"""


def step_assert_simple_mode(cdp_holder):
    """The default view hides the knobs and names the model in one line.

    Computed style, not the attribute: a region can be marked advanced and
    still be on screen if the stylesheet stopped honouring it, which is the
    failure a first-time visitor would actually see.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    s = v(cdp.eval(MODE_STATE_JS, target['id'], timeout=10))

    if s.get('advanced'):
        raise AssertionError(
            'advanced mode is on by default — the simple view is the default')
    hidden = [k for k in ('modelGrid', 'languageFilter', 'speedRow') if s.get(k) is not False]
    if hidden:
        raise AssertionError(f'advanced regions visible in the simple view: {hidden} ({s})')
    if not s.get('qualityPresets'):
        raise AssertionError(f'quality presets are hidden in the simple view: {s}')
    if not s.get('activePreset'):
        raise AssertionError(f'no quality preset is active in the simple view: {s}')
    if not s.get('bottomBar') or not s.get('bottomPreset'):
        raise AssertionError(f'bottom bar is missing its preset readout: {s}')
    if s.get('toggleLabel') != 'More':
        raise AssertionError(f'bottom-bar toggle should read "More" in the simple view: {s}')
    if not s.get('textInput') or not s.get('loadBtn'):
        raise AssertionError(f'the short path is not intact in the simple view: {s}')
    # The point of the simple view: a download size is an engineering fact,
    # and nobody reading their sentence back needs one on screen.
    if s.get('sizeFigures'):
        raise AssertionError(
            f'memory figures are visible in the simple view: {s.get("sizeFigures")}')
    if any(s.get('presetSizesShown') or []):
        raise AssertionError(
            f'quality-preset size chips are rendered in the simple view: {s}')
    for blurb in s.get('presetBlurbs') or []:
        if re.search(r'\d+\s*MB', blurb, re.I):
            raise AssertionError(f'quality preset blurb leaks a size: {blurb!r}')
    if s.get('bottomModel') and re.search(r'\d+\s*MB', s['bottomModel'], re.I):
        raise AssertionError(f'bottom bar names a download size: {s["bottomModel"]!r}')
    if s.get('f16Sentences', 0) > 1:
        raise AssertionError(
            f'the fp16 warning shows both registers at once: {s}')
    print(f'      ✓ simple view: grid hidden, quality={s.get("activePreset")} '
          f'({s.get("bottomModel")}), text box and load button present')
    print(f'      ✓ no memory figures on screen (presets read '
          f'{s.get("presetBlurbs")})')


VOICE_AUDITION_JS = r"""
(() => {
  const btns = [...document.querySelectorAll('.voice-card__play')];
  return {
    loaded: (document.querySelector('.model-card--loaded') || {}).dataset?.modelId || null,
    total: btns.length,
    live: btns.filter(b => !b.disabled && !b.hasAttribute('data-blocked')).length,
    first: btns[0] ? btns[0].closest('.voice-card').dataset.voiceId : null,
  };
})()
"""

# Clicks one audition and reports both what played and whether the committed
# recording was the thing that answered. The fetch count is the real assertion:
# a model being loaded would make the button work anyway, so "it played" proves
# nothing on its own. "It played AND the browser went to /voice-samples/" is
# the only way to know the user is hearing a recorded clip.
VOICE_AUDITION_PLAY_JS = r"""
(async () => {
  const vid = %s;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('.voice-card[data-voice-id="' + vid + '"] .voice-card__play');
  if (!btn) return { ok: false, why: 'no play button for ' + vid };

  const played = [];
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    played.push(this.src);
    return orig.call(this).catch(() => {});
  };
  const sampleReqs = () =>
    performance.getEntriesByType('resource').filter(e => e.name.includes('/voice-samples/')).length;
  const before = sampleReqs();
  try {
    btn.click();
    const t0 = Date.now();
    while (!played.length && Date.now() - t0 < 30000) await sleep(100);
    await sleep(500);
    return { ok: played.length > 0, played, fetched: sampleReqs() - before };
  } finally {
    HTMLMediaElement.prototype.play = orig;
  }
})()
"""


def step_assert_audition_without_download(cdp_holder):
    """Every voice is audible before any model has been downloaded.

    This is the last thing the simple view used to make the user pay for: to
    answer "which voice do I like?" you had to finish a model download first.
    The recordings remove that, and this step is the only place that checks it
    against a real browser — a unit test can prove the lookup returns a URL,
    not that pressing the button fetches and plays one.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    s = v(cdp.eval(VOICE_AUDITION_JS, target['id'], timeout=10))

    if not s.get('total'):
        raise AssertionError(f'no voice audition buttons rendered: {s}')
    if s.get('live') != s.get('total'):
        raise AssertionError(
            f'{s["total"] - s["live"]} of {s["total"]} voices are still blocked '
            f'with no model loaded (model={s.get("loaded")}): {s}')

    res = v(cdp.eval_async(VOICE_AUDITION_PLAY_JS % json.dumps(s['first']),
                          target['id'], timeout=60))
    if not res.get('ok'):
        raise AssertionError(f'audition produced no audio: {res}')
    if not res.get('fetched'):
        raise AssertionError(
            'the audition played but never fetched a recording from '
            f'/voice-samples/ — it synthesised instead: {res}')


def step_enable_advanced_mode(cdp_holder):
    """The header toggle reveals the full set of controls and persists.

    Everything downstream (select_model, language filter, speed) drives
    controls that only exist in this view, so this has to run before them.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    before = v(cdp.eval(MODE_STATE_JS, target['id'], timeout=10))
    if before.get('advanced'):
        print('      (advanced mode already on)')
        return

    _click_trusted(cdp, target['id'], '#advanced-toggle')

    start = time.time()
    s: dict = {}
    while time.time() - start < 10:
        s = v(cdp.eval(MODE_STATE_JS, target['id'], timeout=10))
        if s.get('advanced') and s.get('modelGrid') is True:
            break
        time.sleep(0.5)
    if not s.get('advanced') or s.get('modelGrid') is not True:
        raise AssertionError(f'the advanced toggle did not reveal the model grid: {s}')
    if s.get('stored') != '1':
        raise AssertionError(f'advanced mode was not persisted: stored={s.get("stored")!r}')
    if s.get('togglePressed') != 'true':
        raise AssertionError(f'toggle aria-pressed out of step: {s.get("togglePressed")!r}')
    if s.get('toggleLabel') != 'Less':
        raise AssertionError(f'bottom-bar toggle should read "Less" when revealed: {s.get("toggleLabel")!r}')
    # The figures were relocated, not deleted — the whole point of hiding
    # them is that they are one toggle away.
    if not all(s.get('presetSizesShown') or []):
        raise AssertionError(
            f'quality-preset size chips are still hidden in advanced mode: {s}')
    if len(s.get('presetSizesShown') or []) != 3:
        raise AssertionError(f'expected a size chip on all three presets: {s}')
    if s.get('f16Sentences', 0) > 1:
        raise AssertionError(
            f'the fp16 warning shows both registers at once: {s}')
    print(f'      ✓ advanced view: grid visible, language filter and speed back '
          f'(aria-pressed={s.get("togglePressed")}, stored={s.get("stored")})')
    print(f'      ✓ download sizes back on screen where the numbers belong')


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
            // Since auto-load (selecting a model starts the download), the
            // load control flips into its disabled status-pill form while the
            // download runs. A manual click is only the fallback path.
            const loadBtn = document.getElementById('load-btn');
            if (loadBtn && !loadBtn.disabled) loadBtn.click();
            return { ok: true, autoLoad: !!(loadBtn && loadBtn.disabled) };
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
        overlayPauseLabel: (document.getElementById('reader-overlay-pause') || {}).textContent || null,
        ocrChecked: !!document.getElementById('ocr-toggle')?.checked,
        classifyChips: Array.from(
            document.querySelectorAll('#classify-chips .classify-chip')
        ).map(c => c.textContent),
        tableCount: document.querySelectorAll('#classify-list table').length,
        sampleHidden: !!document.getElementById('document-sample')?.hidden,
        layoutBlockCount: document.getElementById('layout-details')
            && document.getElementById('layout-details').style.display !== 'none'
            ? (() => {
                try { return JSON.parse(document.getElementById('layout-pre').textContent).length; }
                catch (e) { return -1; }
            })()
            : 0,
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


def _inject_bytes(cdp, target_id, data: bytes, name: str, mime: str):
    import base64 as b64mod
    b64 = b64mod.b64encode(data).decode()
    js = INJECT_FILE_JS % {'b64': json.dumps(b64), 'name': json.dumps(name), 'mime': json.dumps(mime)}
    resp = cdp.eval(js, target_id, timeout=15)
    r = v(resp)
    if not r.get('ok'):
        raise AssertionError(f'file injection failed: {r}')
    print(f'      injected {name} ({len(data)} bytes)')


def _inject_file(cdp, target_id, path: Path, mime: str):
    _inject_bytes(cdp, target_id, path.read_bytes(), path.name, mime)


def _inject_served_file(cdp, target_id, rel_path: str, mime: str):
    """Inject a fixture the app serves itself.

    Used for the reader fixtures, which live in `public/test-docs/` because
    they are committed for the app's own use. Copying them into e2e/fixtures
    would mean two copies of the same file to keep in step, and the step would
    then be testing a document the app never sees.
    """
    import urllib.request
    url = f'{URL.rstrip("/")}/{rel_path.lstrip("/")}'
    with urllib.request.urlopen(url, timeout=20) as resp:
        data = resp.read()
    _inject_bytes(cdp, target_id, data, Path(rel_path).name, mime)


PAGE_STATE_JS = """(function() {
    const pages = { studio: null, reader: null };
    for (const id of ['page-studio', 'page-reader']) {
        const el = document.getElementById(id);
        pages[id === 'page-studio' ? 'studio' : 'reader'] = el
            ? !el.hidden && getComputedStyle(el).display !== 'none'
            : false;
    }
    return {
        pages,
        hash: location.hash,
        activeTab: document.querySelector('.page-nav__tab--active')?.dataset.pageTarget || null,
    };
})()"""


def _click_trusted(cdp, target_id: str, selector: str) -> tuple[float, float]:
    """Scroll a control into view, then click it with a trusted CDP mouse event.

    DOM.getBoxModel reports layout coordinates, so a control below the fold
    yields a y outside the viewport and the synthesised click lands on whatever
    happens to be there instead — the step then times out waiting for a state
    change that the click never caused. The Reader page is tall enough (hero,
    drop zone, OCR options, preview) that 'Read aloud' sits below the fold
    after a document is extracted, so this is the normal case, not an edge one.

    Scrolling first and re-measuring also means the click lands on the button
    as a user would experience it, which is the whole point of using a trusted
    event over element.click() here (autoplay policy).
    """
    scrolled = cdp.eval(
        "(function(){const el=document.querySelector(%s);if(!el)return {ok:false};"
        "el.scrollIntoView({block:'center'});return {ok:true};})()" % json.dumps(selector),
        target_id, timeout=10)
    if not v(scrolled).get('ok'):
        raise AssertionError(f'{selector} not found')
    time.sleep(0.3)  # let the scroll settle before measuring

    node = cdp.find_element(target_id, selector)
    if not node:
        raise AssertionError(f'{selector} not found')
    box = cdp.get_box_model(target_id, node['objectId'])
    if not box:
        raise AssertionError(f'could not measure {selector} position')
    x, y = box[0] + 6, box[1] + 6
    cdp.click_at(target_id, x, y)
    return x, y


def _switch_page(cdp_holder, page: str):
    """Activate a page tab and wait for its panel to actually be visible.

    The app renders both pages into the DOM and toggles `hidden`, so a raw
    querySelector still finds buttons inside the inactive page — but
    DOM.getBoxModel returns nothing for a hidden node, so the trusted-click
    steps downstream would fail with 'could not measure ... position'.
    Switching through the real tab (not by poking the DOM) also exercises the
    hash routing the UI actually ships.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    js = (
        "(function(){"
        f"const tab = document.querySelector('.page-nav__tab[data-page-target=\"{page}\"]');"
        "if (!tab) return { ok: false, msg: 'no tab for page' };"
        "tab.click();"
        f"location.hash = '#{page}';"
        "return { ok: true };"
        "})()"
    )
    r = v(cdp.eval(js, target['id'], timeout=10))
    if not r.get('ok'):
        raise AssertionError(f'could not switch to the {page} page: {r}')

    start = time.time()
    s: dict = {}
    while time.time() - start < 10:
        s = v(cdp.eval(PAGE_STATE_JS, target['id'], timeout=10))
        if s.get('pages', {}).get(page):
            print(f'      ✓ {page} page active (hash={s.get("hash")!r})')
            return
        time.sleep(0.25)
    raise AssertionError(
        f'{page} page did not become visible within 10s: {json.dumps(s, default=str)}')


def step_switch_to_reader(cdp_holder):
    """The document flow lives on the Reader tab since the two-page revamp."""
    _switch_page(cdp_holder, 'reader')


def step_switch_to_studio(cdp_holder):
    """Back to the Studio tab for the steps that drive the text box."""
    _switch_page(cdp_holder, 'studio')


def step_load_sample_document(cdp_holder):
    """Load the built-in sample and confirm the structure renderer ran on it.

    The sample is the Reader page's first impression: a button that has to
    fill the whole panel — classified blocks, chips, a real table — or the
    page looks as empty as it did before the sample existed.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    x, y = _click_trusted(cdp, target['id'], '#document-sample-btn')
    start = time.time()
    s: dict = {}
    while time.time() - start < 20:
        s = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
        if s.get('classifyChips') and s.get('sentenceCount', 0) > 0:
            break
        time.sleep(0.5)
    if not s.get('classifyChips'):
        raise AssertionError(
            f'clicking "Read a sample" at ({x:.0f}, {y:.0f}) rendered no '
            f'classified blocks: {json.dumps(s, default=str)[:400]}')
    if not s.get('sampleHidden'):
        raise AssertionError('the sample offer is still showing after a document loaded')
    if s.get('tableCount', 0) < 1:
        raise AssertionError(
            f'sample classified blocks did not render a real table: '
            f'chips={s.get("classifyChips")} tableCount={s.get("tableCount")}')
    print(f'      ✓ sample loaded: chips={s.get("classifyChips")} '
          f'sentences={s.get("sentenceCount")} tables={s.get("tableCount")}')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '04b-sample-document.png')


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
    x, y = _click_trusted(cdp, target['id'], '#read-document-btn')
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


def step_pause_resume_reader(cdp_holder):
    """Pause the reader from the overlay, then resume it from the same button.

    Both are user-facing controls whose failure mode is silent: if pause
    never took effect the label would stay 'Pause' and the audio would keep
    advancing, and if resume did nothing the session would sit stuck at one
    part. The overlay's Pause/Resume label is the only signal the app gives
    (the status line just counts parts), so assert on the label transition
    *and* that the highlight is not moving while paused.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _click_trusted(cdp, target['id'], '#reader-overlay-pause')
    paused: dict = {}
    start = time.time()
    while time.time() - start < 20:
        paused = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
        if paused.get('overlayPauseLabel') in ('Resume', 'Click to play'):
            break
        time.sleep(0.5)
    if paused.get('overlayPauseLabel') not in ('Resume', 'Click to play'):
        raise AssertionError(
            f'Pause did not take effect: label={paused.get("overlayPauseLabel")!r} '
            f'status={paused.get("readerStatus")!r}')

    # Frozen means frozen: sample the highlight twice and require it to sit
    # still. Comparing a single reading would pass even if audio kept going.
    first = (paused.get('activeSentenceIndex'), paused.get('activeWordIndex'))
    time.sleep(2.5)
    later = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
    second = (later.get('activeSentenceIndex'), later.get('activeWordIndex'))
    if second != first:
        raise AssertionError(
            f'highlight kept moving while paused: {first} → {second}')
    print(f'      ✓ paused (label={paused.get("overlayPauseLabel")!r}, '
          f'highlight held at {first})')

    _click_trusted(cdp, target['id'], '#reader-overlay-pause')
    resumed: dict = {}
    start = time.time()
    while time.time() - start < 20:
        resumed = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
        if resumed.get('overlayPauseLabel') == 'Pause':
            print(f'      ✓ resumed (label="Pause", status='
                  f'{resumed.get("readerStatus")!r})')
            return
        time.sleep(0.5)
    raise AssertionError(
        f'Resume did not take effect: label={resumed.get("overlayPauseLabel")!r} '
        f'status={resumed.get("readerStatus")!r}')


def step_upload_scanned_pdf_ocr(cdp_holder):
    """Turn OCR on and read a PDF that has no text layer at all.

    sample.pdf has a real text layer, so pdfjs extracts it and the OCR branch
    never runs — which is why this regression sat undetected: the OCR path
    read pages perfectly and then reported zero words, and the reader turned
    that into a 0-character document with no error anywhere. The fixture is
    an image-only page, so the only way to get text out of it is Tesseract.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    cap = v(cdp.eval(
        "({ hasPromiseTry: typeof Promise.try === 'function' })",
        target['id'], timeout=10,
    ))
    if not cap.get('hasPromiseTry'):
        print('      (skip: browser lacks Promise.try — pdfjs 6 needs Chrome ≥~128; '
              'CI uses Chrome stable)')
        return

    # The checkbox itself is visually hidden (0x0, opacity 0) inside its
    # label, so click the label the way a user does.
    x, y = _click_trusted(cdp, target['id'], 'label.switch')
    start = time.time()
    state: dict = {}
    while time.time() - start < 10:
        state = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
        if state.get('ocrChecked'):
            break
        time.sleep(0.5)
    if not state.get('ocrChecked'):
        raise AssertionError(
            f'clicking the OCR toggle at ({x:.0f}, {y:.0f}) did not check it')
    print('      ✓ OCR toggle enabled')

    _inject_file(cdp, target['id'], FIXTURES_DIR / 'scanned.pdf', 'application/pdf')

    # First OCR in a fresh profile also loads the self-hosted WASM core and
    # eng.traineddata (~8MB), so this gets a much longer budget than the
    # text-layer PDF step.
    ocr_timeout = float(os.environ.get('YAPPER_OCR_TIMEOUT', '240'))
    start = time.time()
    s: dict = {}
    saw_progress = False
    while time.time() - start < ocr_timeout:
        resp = cdp.eval(READER_STATE_JS, target['id'], timeout=10)
        s = v(resp)
        if 'OCR page' in (s.get('progressText') or ''):
            saw_progress = True
        if s.get('readerError'):
            raise AssertionError(f'reader panel surfaced an error: {s.get("readerError")!r}')
        text = s.get('text', '')
        if s.get('previewVisible') and 'Yapper scanned document' in text:
            if 'recognition' not in text:
                time.sleep(1)
                continue
            print(f'      ✓ OCR read the scanned page: {s.get("sentenceCount")} sentences, '
                  f'{s.get("layoutBlockCount")} layout blocks, '
                  f'progress="{s.get("progressText")[:60]}"')
            if not saw_progress:
                # Not fatal on its own (the page can finish between polls),
                # but say so rather than implying we watched it work.
                print('      (note: never sampled the "OCR page N: x%" progress line)')
            if (s.get('layoutBlockCount') or 0) < 2:
                raise AssertionError(
                    f'OCR produced no per-line layout blocks: '
                    f'layoutBlockCount={s.get("layoutBlockCount")} '
                    f'text={text[:120]!r}')
            cdp.screenshot(target['id'], SCREENSHOT_DIR / '08-scanned-pdf-ocr.png')
            return
        time.sleep(1)
    raise AssertionError(
        f'scanned PDF produced no OCR text within {ocr_timeout}s: '
        f'progress={s.get("progressText")!r} banner={s.get("statusBanner")!r} '
        f'readerError={s.get("readerError")!r} text[:100]={s.get("text", "")[:100]!r}')


def step_stop_reader(cdp_holder):
    """Stop playback via the overlay Stop button and confirm teardown."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']
    btn = cdp.find_element(target['id'], '#reader-overlay-stop')
    if not btn:
        raise AssertionError('#reader-overlay-stop not found')
    _click_trusted(cdp, target['id'], '#reader-overlay-stop')
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


DOCVIEW_STATE_JS = """(function() {
    const host = document.getElementById('document-view');
    const switchEl = document.querySelector('.docview-switch');
    const active = document.querySelector('.docview-switch__btn--active');
    const canvas = host ? host.querySelector('canvas') : null;
    let dark = 0;
    if (canvas && canvas.width) {
        try {
            const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < d.length; i += 4) if (d[i] < 200) dark++;
        } catch (e) { dark = -1; }
    }
    const overlay = document.getElementById('reader-overlay');
    const pause = document.getElementById('pause-document-btn');
    const surface = host && host.querySelector('.docview__surface');
    const box = surface ? surface.getBoundingClientRect() : null;
    return {
        mounted: !!host && !host.hidden,
        switchVisible: !!switchEl && !switchEl.hidden
            && getComputedStyle(switchEl).display !== 'none',
        activeView: active ? active.textContent.trim() : null,
        canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
        darkPixels: dark,
        highlightBoxes: host ? host.querySelectorAll('.docview__hl').length : 0,
        pageLabel: host ? ((host.querySelector('.docview__count') || {}).textContent || '') : '',
        overlayVisible: !!overlay && getComputedStyle(overlay).display !== 'none',
        pauseVisible: !!pause && getComputedStyle(pause).display !== 'none',
        viewport: { w: innerWidth, h: innerHeight },
        pageOrigin: box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null,
    };
})()"""


# Where to aim inside a page: a little in from the left edge and stepped down
# from the top, which is where body text starts. Several points because the
# first line's baseline moves with the fixture's margins, and the check is
# "clicking text reads from there", not "a specific pixel is text".
_PAGE_CLICK_OFFSETS = (40, 66, 92, 118, 150, 185, 225, 270, 320)


def step_document_view_renders_pdf(cdp_holder):
    """The reader shows the actual page, and clicking it reads from there.

    Runs immediately after upload_pdf_document, while that PDF is on screen.
    The assertions are deliberately about pixels and offsets rather than about
    the view being in the DOM: a document view that mounts but paints nothing
    is the failure this whole feature exists to fix, and it looks identical
    from the outside.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    state: dict = {}
    deadline = time.time() + 60
    while time.time() < deadline:
        state = v(cdp.eval(DOCVIEW_STATE_JS, target['id'], timeout=10))
        if state.get('canvas') or not state.get('mounted'):
            break
        time.sleep(0.5)

    if not state.get('mounted'):
        raise AssertionError(
            f'document view is not mounted for a PDF: {json.dumps(state, default=str)}')
    if not state.get('switchVisible'):
        raise AssertionError('the Document/Text switch is hidden for a PDF that has pages')
    if state.get('activeView') != 'Document':
        raise AssertionError(
            f'expected the Document view to be the default, got {state.get("activeView")!r}')
    if not state.get('canvas'):
        raise AssertionError(
            f'no page canvas appeared within 60s: {json.dumps(state, default=str)}')
    if state.get('darkPixels', 0) <= 0:
        raise AssertionError(
            f'page canvas is blank (darkPixels={state.get("darkPixels")}) — rasterisation failed')
    print(f'      ✓ page rasterised: {state["canvas"]["w"]}x{state["canvas"]["h"]}px, '
          f'{state["darkPixels"]} dark pixels, {state["pageLabel"]!r}')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '08-document-view.png')

    v(cdp.eval(
        "(function(){const h=document.getElementById('document-view');"
        "if(h)h.scrollIntoView({block:'start'});return {ok:!!h};})()",
        target['id'], timeout=10))
    time.sleep(0.3)
    state = v(cdp.eval(DOCVIEW_STATE_JS, target['id'], timeout=10))
    origin = state.get('pageOrigin')
    viewport = state.get('viewport') or {}
    if not origin:
        raise AssertionError('the page surface vanished before it could be clicked')

    clicked: dict = {}
    for offset in _PAGE_CLICK_OFFSETS:
        x = origin['left'] + 120
        y = origin['top'] + offset
        # A trusted click has to be inside the viewport to land where we mean.
        if not (0 < x < viewport.get('w', 0) and 0 < y < viewport.get('h', 0)):
            continue
        cdp.click_at(target['id'], x, y)
        # Poll rather than sample once: the click highlights the clicked
        # sentence immediately, but with a model loaded the session's own
        # highlight then takes over as audio starts, so a single read can race
        # the render loop and see neither.
        deadline = time.time() + 20
        while time.time() < deadline:
            time.sleep(0.4)
            clicked = v(cdp.eval(DOCVIEW_STATE_JS, target['id'], timeout=10))
            if clicked.get('highlightBoxes'):
                break
        if clicked.get('highlightBoxes'):
            break

    if not clicked.get('highlightBoxes'):
        raise AssertionError(
            'clicking the rendered page never produced a highlight — the click did '
            'not resolve to a sentence'
        )
    if clicked.get('overlayVisible'):
        raise AssertionError(
            'clicking the page opened the full-screen reader overlay; the document '
            'the user just clicked on should stay visible'
        )
    if clicked.get('pauseVisible'):
        print(f'      ✓ clicked the page: {clicked["highlightBoxes"]} highlight '
              f'box(es), reading started from there')
    else:
        print(f'      ✓ clicked the page: {clicked["highlightBoxes"]} highlight '
              f'box(es) (no session — engine not ready in this run)')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '08b-document-view-click.png')


DOCX_MIME = ('application/vnd.openxmlformats-officedocument'
             '.wordprocessingml.document')

# Reads back the rendered DOCX surface: what was rendered, with what styling,
# and each run's own claim about which characters it covers.
DOCHTML_STATE_JS = """(function() {
    const host = document.getElementById('document-view');
    if (!host) return { mounted: false };
    const content = host.querySelector('.dochtml__content');
    const runs = content ? [...content.querySelectorAll('[data-off]')] : [];
    const parsed = runs.map(el => {
        const [start, end] = (el.dataset.off || '').split(':').map(Number);
        return { start, end, text: el.textContent };
    });
    const bad = parsed.filter(r => !Number.isFinite(r.start) || !Number.isFinite(r.end));

    // The stamps must reproduce the offsets the extracted text was built
    // with: runs contiguous inside a block, and one blank line (+2) between
    // blocks. Checked against the rendered DOM rather than against the
    // reader's text view, which is a different string — it is the same words
    // laid out one sentence per element, with the paragraph separators gone,
    // so comparing the two would fail on a correct document.
    const stamps = (function() {
        if (!content) return { ok: false, blocks: 0, reason: 'no content' };
        let cursor = 0;
        let blocks = 0;
        // The blocks may be flowed onto page sheets (the PDF-reader look);
        // the invariant is about the blocks themselves, whatever they are
        // nested in.
        const top = [...content.children];
        const sheets = top.filter(el => el.classList && el.classList.contains('docpage'));
        const blocksInOrder = sheets.length
            ? sheets.flatMap(sheet => [...sheet.querySelectorAll('.docpage__body > *')])
            : top;
        for (const block of blocksInOrder) {
            const spans = [...block.querySelectorAll('[data-off]')];
            if (!spans.length) continue;
            for (const span of spans) {
                const [start, end] = (span.dataset.off || '').split(':').map(Number);
                const len = (span.textContent || '').length;
                if (start !== cursor || end - start !== len) {
                    return {
                        ok: false, blocks,
                        reason: block.tagName + ' run [' + start + ',' + end + ') holds '
                            + len + ' chars but the text cursor is at ' + cursor,
                    };
                }
                cursor = end;
            }
            blocks++;
            cursor += 2;
        }
        return { ok: true, blocks, textLength: Math.max(0, cursor - 2) };
    })();

    return {
        stamps,
        mounted: !host.hidden,
        switchVisible: (function() {
            const s = document.querySelector('.docview-switch');
            return !!s && !s.hidden && getComputedStyle(s).display !== 'none';
        })(),
        activeView: (document.querySelector('.docview-switch__btn--active') || {}).textContent
            ? document.querySelector('.docview-switch__btn--active').textContent.trim() : null,
        runs: parsed,
        unparsableRuns: bad.length,
        headings: content ? content.querySelectorAll('h1, h2, h3').length : 0,
        listItems: content ? content.querySelectorAll('li').length : 0,
        boldRuns: content ? content.querySelectorAll('strong').length : 0,
        italicRuns: content ? content.querySelectorAll('em').length : 0,
        scriptTags: content ? content.querySelectorAll('script').length : 0,
        paragraphText: content ? (content.textContent || '').slice(0, 120) : '',
        highlightBoxes: host.querySelectorAll('.dochtml__hl').length,
        pageSheets: content ? content.querySelectorAll('.docpage').length : 0,
        runRects: runs.map(el => {
            const b = el.getBoundingClientRect();
            return { left: b.left, top: b.top, width: b.width, height: b.height };
        }),
        viewport: { w: innerWidth, h: innerHeight },
    };
})()"""


def step_document_view_renders_docx(cdp_holder):
    """A DOCX is shown as a document: real headings, bold, italic, bullets.

    This asserts the two things that would break silently. First, the markup is
    built from the same runs as the extracted text rather than by re-parsing the
    file, so every stamped range must slice the extracted text back to exactly
    the characters it renders — if that drifts, highlights land on the wrong
    words with no error anywhere. Second, the document's own markup must not be
    able to execute, because the file is user-supplied.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/reader-notes.docx', DOCX_MIME)

    state: dict = {}
    deadline = time.time() + 60
    while time.time() < deadline:
        state = v(cdp.eval(DOCHTML_STATE_JS, target['id'], timeout=10))
        if state.get('runs') or state.get('readerError'):
            break
        time.sleep(0.5)

    if not state.get('mounted'):
        raise AssertionError(
            f'the DOCX document view is not mounted: {json.dumps(state, default=str)[:400]}')
    if state.get('activeView') != 'Document':
        raise AssertionError(
            f'expected the Document view to be active, got {state.get("activeView")!r}')

    runs = state.get('runs') or []
    if len(runs) < 8:
        raise AssertionError(f'expected the fixture\'s runs to render, got {len(runs)}')
    if state.get('unparsableRuns'):
        raise AssertionError(f'{state["unparsableRuns"]} run(s) carried a malformed data-off')
    if state.get('scriptTags'):
        raise AssertionError('the document view executed markup out of the uploaded file')
    if not state.get('boldRuns') or not state.get('italicRuns'):
        raise AssertionError(
            'bold/italic did not survive into the rendered document '
            f'(bold={state.get("boldRuns")}, italic={state.get("italicRuns")})')
    if not state.get('headings') or not state.get('listItems'):
        raise AssertionError(
            f'headings/lists did not render (headings={state.get("headings")}, '
            f'lists={state.get("listItems")})')

    stamps = state.get('stamps') or {}
    if not stamps.get('ok'):
        raise AssertionError(
            'the rendered stamps do not line up with the extracted text: '
            f'{stamps.get("reason")}'
        )
    if not state.get('pageSheets'):
        raise AssertionError('the DOCX rendered without page sheets')
    print(f'      ✓ DOCX rendered as a document: {len(runs)} stamped runs across '
          f'{stamps.get("blocks")} blocks, {state["headings"]} headings, '
          f'{state["listItems"]} list items, {state["boldRuns"]} bold / '
          f'{state["italicRuns"]} italic, offsets consistent to '
          f'{stamps.get("textLength")} chars')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '09-document-view-docx.png')

    # The HTML surface resolves a click through the browser's caret hit-test
    # rather than through page geometry, so it is a different code path from
    # the PDF one and worth clicking once here.
    # The reader page is tall (drop zone, OCR options, structure list), so the
    # document view is usually below the fold; a trusted click has to land
    # inside the viewport to hit what it is aimed at.
    v(cdp.eval(
        "(function(){const h=document.getElementById('document-view');"
        "if(h)h.scrollIntoView({block:'start'});return {ok:!!h};})()",
        target['id'], timeout=10))
    time.sleep(0.3)
    state = v(cdp.eval(DOCHTML_STATE_JS, target['id'], timeout=10))

    rects = state.get('runRects') or []
    viewport = state.get('viewport') or {}
    clicked: dict = {}
    attempts = 0
    for rect in rects:
        x = rect['left'] + max(4, rect['width'] * 0.5)
        y = rect['top'] + rect['height'] / 2
        if not (0 < x < viewport.get('w', 0) and 0 < y < viewport.get('h', 0)):
            continue
        attempts += 1
        cdp.click_at(target['id'], x, y)
        deadline = time.time() + 20
        while time.time() < deadline:
            time.sleep(0.4)
            clicked = v(cdp.eval(DOCHTML_STATE_JS, target['id'], timeout=10))
            if clicked.get('highlightBoxes'):
                break
        if clicked.get('highlightBoxes'):
            break
    if not clicked.get('highlightBoxes'):
        raise AssertionError(
            f'clicking the rendered DOCX produced no highlight after {attempts} '
            f'click(s) inside a {viewport.get("w")}x{viewport.get("h")} viewport '
            f'({len(rects)} runs on screen)'
        )
    print(f'      ✓ clicked a run: {clicked["highlightBoxes"]} highlight box(es)')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '09b-document-view-docx-click.png')

    # Leave the reader stopped so the next document starts clean.
    cdp.eval("(function(){const b=document.getElementById('stop-document-btn');"
             "if(b&&getComputedStyle(b).display!=='none')b.click();return {ok:true};})()",
             target['id'], timeout=10)


def step_document_view_renders_odt(cdp_holder):
    """The committed ODT fixture, through the real package reader.

    ODT is the one supported format whose container is not an OOXML zip:
    its `mimetype` member is stored uncompressed and first, and the outline
    lives on `text:outline-level` rather than in a paragraph style. The unit
    suite covers the walker against XML built in-test, but only this step
    feeds it the package as a real writer lays it out — and it asserts the
    stamps still tile the extracted text, which is where a dropped list item
    or a lost heading would show up as a silent offset drift.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/test.odt', ODT_MIME)

    state: dict = {}
    deadline = time.time() + 60
    while time.time() < deadline:
        state = v(cdp.eval(DOCHTML_STATE_JS, target['id'], timeout=10))
        if state.get('runs') or state.get('readerError'):
            break
        time.sleep(0.5)

    if not state.get('mounted'):
        raise AssertionError(
            f'the ODT document view is not mounted: {json.dumps(state, default=str)[:400]}')
    if state.get('readerError'):
        raise AssertionError(f'the ODT failed to open: {state["readerError"]}')
    if state.get('headings') != 2:
        raise AssertionError(
            f'expected the fixture\'s two outline headings, got {state.get("headings")}')
    if not state.get('listItems'):
        raise AssertionError(
            'the ODT list rendered as plain paragraphs — the same document '
            'shows bullets in DOCX, so a list item flattened to a paragraph '
            'here is a format bug, not a document property')
    if not state.get('stamps', {}).get('ok'):
        raise AssertionError(
            f'ODT runs do not tile the extracted text: {state.get("stamps")}')
    text = ' '.join(r.get('text') or '' for r in state.get('runs') or [])
    for needle in ('Reader Probe', 'Outline levels', 'Bullet two does as well'):
        if needle not in text:
            raise AssertionError(
                f'{needle!r} never reached the page; the ODT walker dropped it. '
                f'First 120 chars: {state.get("paragraphText")!r}')
    print(f'      ✓ ODT rendered: headings={state.get("headings")} '
          f'lists={state.get("listItems")} '
          f'blocks={state.get("stamps", {}).get("blocks")} '
          f'textLength={state.get("stamps", {}).get("textLength")}')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '07b-odt-rendered.png')


ODT_MIME = 'application/vnd.oasis.opendocument.text'
RTF_MIME = 'application/rtf'
CSV_MIME = 'text/csv'
HTML_MIME = 'text/html'
EPUB_MIME = 'application/epub+zip'
XLSX_MIME = ('application/vnd.openxmlformats-officedocument'
             '.spreadsheetml.sheet')
PPTX_MIME = ('application/vnd.openxmlformats-officedocument'
             '.presentationml.presentation')

# Stamp invariant for formats whose text joins are not the DOCX paragraph
# contract (tables delimit cells, slides space-join their runs). What must
# hold for every format: each stamp covers exactly its element's characters,
# and stamps never overlap or run backwards.
GENERIC_STAMPS_JS = """(function() {
    const content = document.querySelector('#document-view .dochtml__content');
    if (!content) return { ok: false, reason: 'no content' };
    const stamps = [...content.querySelectorAll('[data-off]')].map(el => {
        const [start, end] = (el.dataset.off || '').split(':').map(Number);
        return { start, end, len: (el.textContent || '').length };
    });
    for (let i = 0; i < stamps.length; i++) {
        const s = stamps[i];
        if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end - s.start !== s.len) {
            return { ok: false, count: stamps.length, reason: 'stamp ' + i + ' holds ' + s.len
                + ' chars but spans [' + s.start + ',' + s.end + ')' };
        }
        if (i > 0 && s.start < stamps[i - 1].end) {
            return { ok: false, count: stamps.length,
                reason: 'stamp ' + i + ' starts before the previous one ends' };
        }
    }
    return { ok: true, count: stamps.length };
})()"""


def _assert_generic_stamps(cdp, target_id):
    stamps = v(cdp.eval(GENERIC_STAMPS_JS, target_id, timeout=10))
    if not stamps.get('ok'):
        raise AssertionError(f'stamped ranges are inconsistent: {stamps}')
    return stamps


EPUB_NAV_JS = """(function() {
    const sel = document.querySelector('#document-view .docview__section');
    const scroller = document.querySelector('#document-view .docview__pages');
    return {
        options: sel ? [...sel.options].map(o => o.textContent.trim()) : [],
        value: sel ? sel.value : null,
        scrollerTop: scroller ? scroller.scrollTop : -1,
    };
})()"""


def step_document_view_renders_epub(cdp_holder):
    """An EPUB is shown as a book: chapters from its TOC, offsets across the
    spine, and file markup that cannot execute."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/reader-probe.epub', EPUB_MIME)

    state: dict = {}
    deadline = time.time() + 60
    while time.time() < deadline:
        state = v(cdp.eval(DOCHTML_STATE_JS, target['id'], timeout=10))
        if state.get('runs') or state.get('readerError'):
            break
        time.sleep(0.5)
    if state.get('readerError'):
        raise AssertionError(f'EPUB extraction failed: {state.get("readerError")!r}')
    if not state.get('mounted') or state.get('activeView') != 'Document':
        raise AssertionError(
            f'EPUB document view is not active: {json.dumps(state, default=str)[:400]}')

    runs = state.get('runs') or []
    if len(runs) < 8:
        raise AssertionError(f'expected the fixture chapters to render, got {len(runs)} runs')
    stamps = state.get('stamps') or {}
    if not stamps.get('ok'):
        raise AssertionError(f'EPUB stamps do not line up: {stamps.get("reason")}')
    if state.get('scriptTags'):
        raise AssertionError('the document view executed markup out of the uploaded EPUB')
    if 'alert(1)' not in (state.get('paragraphText') or ''):
        raise AssertionError('the inert <script> string lost its text representation')
    if not state.get('headings') or state.get('headings', 0) < 2:
        raise AssertionError(f'chapter headings did not render: {state.get("headings")}')
    if not state.get('listItems') or state.get('listItems', 0) < 2:
        raise AssertionError(f'list items did not render: {state.get("listItems")}')

    nav = v(cdp.eval(EPUB_NAV_JS, target['id'], timeout=10))
    if nav.get('options') != ['Chapter One', 'Chapter Two']:
        raise AssertionError(
            f'chapter navigation should carry the TOC labels, got {nav.get("options")}')
    print(f'      ✓ EPUB rendered: {len(runs)} runs, {stamps.get("count")} stamps, '
          f'chapters {nav.get("options")}, script stayed inert')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '10-document-view-epub.png')

    # Jump to chapter two through the TOC and confirm the view follows.
    v(cdp.eval("""(function() {
        const sel = document.querySelector('#document-view .docview__section');
        if (!sel) return { ok: false };
        sel.value = '1';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
    })()""", target['id'], timeout=10))
    jumped: dict = {}
    deadline = time.time() + 10
    while time.time() < deadline:
        jumped = v(cdp.eval(EPUB_NAV_JS, target['id'], timeout=10))
        if jumped.get('scrollerTop', 0) > 0 and jumped.get('value') == '1':
            break
        time.sleep(0.3)
    if jumped.get('value') != '1' or jumped.get('scrollerTop', 0) <= 0:
        raise AssertionError(f'choosing Chapter Two did not move the view: {jumped}')
    print(f'      ✓ chapter jump moved the document (scrollTop={jumped.get("scrollerTop"):.0f})')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '10b-document-view-epub-ch2.png')


RE_TOOLS_JS = """(function() {
    const outlineItems = [...document.querySelectorAll('#document-view .docview__outline-item')];
    const tabs = [...document.querySelectorAll('#document-view .docview__tab')];
    const status = (document.getElementById('doc-statusbar') || {}).textContent || '';
    const recent = [...document.querySelectorAll('#docrecent-list .docrecent__open')].map(b => (b.textContent || '').trim());
    return {
        outlineCount: outlineItems.length,
        outlineLabels: outlineItems.map(b => (b.textContent || '').trim()),
        tabLabels: tabs.map(b => (b.textContent || '').trim()),
        status,
        recent,
        hasQuickRead: !!document.getElementById('readaloud-btn'),
        hasExport: !!document.getElementById('export-md-btn') && !!document.getElementById('export-notes-btn'),
        searchToggles: document.querySelectorAll('#document-view [data-role^="search-"]').length,
        helpVisible: !(document.getElementById('shortcut-help') || {}).hidden,
        blackoutVisible: !(document.getElementById('blackout') || {}).hidden,
    };
})()"""


def _wait_for_rendered(cdp, target_id: str, seconds: float = 60) -> dict:
    """Poll the stamped-markup view until a document is in it, or give up.

    Shared by the format steps below: each loads a different fixture, but the
    wait is the same — a mounted view with at least one [data-off] run, or an
    error the step should report instead of a bare timeout.
    """
    state: dict = {}
    deadline = time.time() + seconds
    while time.time() < deadline:
        state = v(cdp.eval(DOCHTML_STATE_JS, target_id, timeout=10))
        if state.get('runs') or state.get('readerError'):
            break
        time.sleep(0.5)
    return state


def _assert_rendered(state: dict, label: str) -> str:
    """Common checks for the stamped-markup path, plus the text it rendered."""
    if not state.get('mounted'):
        raise AssertionError(f'the {label} document view is not mounted: '
                             f'{json.dumps(state, default=str)[:300]}')
    if state.get('readerError'):
        raise AssertionError(f'{label} failed to open: {state["readerError"]}')
    if not state.get('stamps', {}).get('ok'):
        raise AssertionError(
            f'{label} runs do not tile the extracted text: {state.get("stamps")}')
    if state.get('scriptTags'):
        raise AssertionError(f'{label} executed markup out of the uploaded file')
    if not state.get('pageSheets'):
        raise AssertionError(
            f'{label} rendered no page sheets (pageSheets={state.get("pageSheets")})')
    return ' '.join(r.get('text') or '' for r in state.get('runs') or [])


def step_document_view_renders_rtf(cdp_holder):
    """RTF arrives with no OOXML package: just control words and groups.

    The fixture carries no heading at all, so this asserts the honest
    outcome — plain paragraphs, no invented chapters — plus the part that is
    genuinely easy to lose: `\\par` has to become a block boundary and the
    paragraph offsets still have to tile the extracted text, or every
    highlight after the first one lands on the wrong words.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/test.rtf', RTF_MIME)
    state = _wait_for_rendered(cdp, target['id'])
    text = _assert_rendered(state, 'RTF')

    if state.get('headings'):
        raise AssertionError(
            f'the RTF fixture has no headings; got {state["headings"]}')
    if state.get('stamps', {}).get('blocks') != 2:
        raise AssertionError(
            f"expected the fixture's two paragraphs, got "
            f'{state.get("stamps", {}).get("blocks")}')
    for needle in ('The quick brown fox jumps over the lazy dog', 'Lorem ipsum dolor sit amet'):
        if needle not in text:
            raise AssertionError(f'{needle!r} never reached the page: {text[:160]!r}')
    print(f'      ✓ RTF rendered: 2 paragraphs, no headings, '
          f'textLength={state.get("stamps", {}).get("textLength")}')


def step_document_view_renders_html(cdp_holder):
    """HTML is user markup: keep its structure, drop its behaviour.

    The fixture's <h1> has to survive as a heading (and become the document's
    one section), while its <script> and <style> must not run and must not
    leak into the text either — a reader that voiced `console.log("ignore
    this")` would be both wrong and, for the script, a security hole.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/test.html', HTML_MIME)
    state = _wait_for_rendered(cdp, target['id'])
    text = _assert_rendered(state, 'HTML')

    if state.get('headings') != 1:
        raise AssertionError(
            f'the fixture has one <h1>; got {state.get("headings")} headings')
    for dropped in ('ignore this', 'sans-serif', 'console.log'):
        if dropped in text:
            raise AssertionError(
                f"{dropped!r} from the page's script/style leaked into the text")
    for needle in ('The quick brown fox jumps over the lazy dog', 'She sells seashells'):
        if needle not in text:
            raise AssertionError(f'{needle!r} never reached the page: {text[:160]!r}')
    print(f'      ✓ HTML rendered: 1 heading kept, script/style dropped '
          f'(blocks={state.get("stamps", {}).get("blocks")})')


def step_upload_csv_document(cdp_holder):
    """A CSV is a table the reader has to say out loud.

    CSV has no visual form, so it renders in the reader's own sentence view —
    the assertion that matters is the quoting: the fixture's `She said
    ""hello""` has to survive as `She said "hello"` inside a row whose other
    cell contains commas too, or the spoken text drops words and the cell
    boundaries bleed into each other.

    The fixture is also three rows in three columns, which the chapter
    heuristic is meant to REJECT: too few rows to call it a table of
    sections. Asserting the absence is deliberate — a reader that invented
    chapters here would do it on real spreadsheets too.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/test.csv', CSV_MIME)

    extract_timeout = float(os.environ.get('YAPPER_EXTRACT_TIMEOUT', '60'))
    start = time.time()
    s: dict = {}
    while time.time() - start < extract_timeout:
        s = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
        if s.get('previewVisible') and 'Quote test' in s.get('text', ''):
            break
        time.sleep(0.5)

    if not s.get('previewVisible'):
        raise AssertionError(f'the CSV never rendered: {json.dumps(s, default=str)[:300]}')
    text = s.get('text', '')
    for needle in ('She said "hello"', 'The quick brown fox jumps over the lazy dog'):
        if needle not in text:
            raise AssertionError(
                f'{needle!r} did not survive CSV parsing: {text[:200]!r}')
    # A doubled quote must collapse to one, not stay as "".
    if '""hello""' in text:
        raise AssertionError(f'escaped quotes were not collapsed: {text[:200]!r}')
    # Every row's cells must be present, and each row is its own
    # sentence: rows are separated by a blank line so the reader
    # speaks a spreadsheet row by row, not as one unbroken utterance.
    # The fixture is a header plus three rows.
    if s.get('wordCount', 0) < 20:
        raise AssertionError(
            f'the CSV lost rows: only {s.get("wordCount")} words in {text[:200]!r}')
    if s.get('sentenceCount', 0) != 4:
        raise AssertionError(
            f'the CSV must read as 4 sentences (one per row), got '
            f'{s.get("sentenceCount")}: {text[:200]!r}')
    for cell in ('Name, Description, Value', 'Dog, Lazy companion, 7', '99'):
        if cell not in text:
            raise AssertionError(f'{cell!r} is missing from the rendered CSV')

    # The Outline button lives inside the stamped document view, and it is
    # only rendered when the outline has entries at all (document-view.ts).
    # So for this fixture its absence is the assertion: three rows do not
    # make a table of chapters, and no view means no outline to fake them.
    outline = v(cdp.eval("""(function() {
        const btn = document.querySelector('[data-role="toggle-outline"]');
        return { present: !!btn,
                 labels: Array.from(document.querySelectorAll(
                     '.docview__outline button, .docview__outline li'))
                     .slice(0, 8).map(i => i.textContent.trim()) };
    })()""", target['id'], timeout=10))
    if outline.get('present') or outline.get('labels'):
        raise AssertionError(
            f'a 3-row CSV must yield no chapters, but the outline offers '
            f'{json.dumps(outline.get("labels"))}')
    print('      ✓ CSV yielded no phantom chapters')
    print(f'      ✓ CSV rendered: {s.get("wordCount")} words as '
          f'{s.get("sentenceCount")} sentences, quoting intact')


DOC_MIME = 'application/msword'


def step_upload_doc_document(cdp_holder):
    """A legacy .doc speaks a paragraph at a time.

    The fixture is a real OLE2 compound file — the container Word 97-2003
    documents live in — whose WordDocument stream carries UTF-16LE text
    with the CR paragraph marks Word uses. Extraction is best-effort byte
    scraping, so it also lifts the container's own two stream names
    ("Root Entry", "WordDocument") as short paragraphs before the text;
    that noise belongs to the format's binary soup, not to the fixture.
    The assertion that matters is the join: the three document paragraphs
    must each read as their own sentence, not run together as one
    unbroken utterance the way a single-newline join produced.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/test.doc', DOC_MIME)

    extract_timeout = float(os.environ.get('YAPPER_EXTRACT_TIMEOUT', '60'))
    start = time.time()
    s: dict = {}
    while time.time() - start < extract_timeout:
        s = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
        if s.get('previewVisible') and 'quick brown fox' in s.get('text', ''):
            break
        time.sleep(0.5)

    if not s.get('previewVisible'):
        raise AssertionError(f'the .doc never rendered: {json.dumps(s, default=str)[:300]}')
    text = s.get('text', '')
    for needle in ('The quick brown fox jumps over the lazy dog',
                   'She sells seashells by the seashore',
                   'How vexingly quick daft zebras jump'):
        if needle not in text:
            raise AssertionError(f'{needle!r} did not survive .doc extraction: {text[:200]!r}')
    # Two container-name paragraphs plus one per document paragraph.
    if s.get('sentenceCount', 0) != 5:
        raise AssertionError(
            f'the .doc must read as 5 sentences (2 stream names, 3 paragraphs), '
            f'got {s.get("sentenceCount")}: {text[:200]!r}')
    print(f'      ✓ .doc rendered: {s.get("wordCount")} words as '
          f'{s.get("sentenceCount")} sentences, one per paragraph')


def step_document_view_reading_tools(cdp_holder):
    """The reading toolbox around the document: outline panel, section tabs,
    status bar, recent shelf, search toggles, shortcut help, blackout."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/reader-probe.epub', EPUB_MIME)

    state: dict = {}
    deadline = time.time() + 60
    while time.time() < deadline:
        state = v(cdp.eval(DOCHTML_STATE_JS, target['id'], timeout=10))
        if state.get('runs') or state.get('readerError'):
            break
        time.sleep(0.5)
    if not state.get('mounted') or state.get('readerError'):
        raise AssertionError(f'EPUB did not mount for the tools step: {state}')

    # Open the outline panel: chapter headings become jumpable items.
    v(cdp.eval("""(function() {
        const btn = document.querySelector('#document-view [data-role="toggle-outline"]');
        if (!btn) return { ok: false };
        btn.click();
        return { ok: true };
    })()""", target['id'], timeout=10))
    tools = v(cdp.eval(RE_TOOLS_JS, target['id'], timeout=10))
    if tools.get('outlineCount', 0) < 2:
        raise AssertionError(f'outline should list the chapter headings: {tools}')
    if tools.get('tabLabels') != ['Chapter One', 'Chapter Two']:
        raise AssertionError(f'section tabs should carry the TOC labels: {tools.get("tabLabels")}')
    if 'words' not in tools.get('status', '') or 'min read' not in tools.get('status', ''):
        raise AssertionError(f'status bar should show size and reading time: {tools.get("status")!r}')
    if not tools.get('hasQuickRead') or not tools.get('hasExport'):
        raise AssertionError(f'quick read / export controls are missing: {tools}')
    if tools.get('searchToggles', 0) < 6:
        raise AssertionError(f'search toolbar should carry its toggles: {tools.get("searchToggles")}')
    if 'reader-probe.epub' not in tools.get('recent', []):
        raise AssertionError(f'the opened document should appear on the recent shelf: {tools.get("recent")}')
    print(f'      ✓ reading tools live: {tools.get("outlineCount")} outline items, '
          f'tabs {tools.get("tabLabels")}, status {tools.get("status")!r}')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '13-document-view-tools.png')

    # Jump through the outline: the clicked item marks itself current.
    jumped = v(cdp.eval("""(function() {
        const items = [...document.querySelectorAll('#document-view .docview__outline-item')];
        if (items.length < 2) return { ok: false };
        items[1].click();
        return { ok: items[1].getAttribute('aria-current') === 'true' };
    })()""", target['id'], timeout=10))
    if not jumped.get('ok'):
        raise AssertionError('clicking an outline item did not mark it current')

    # Keyboard: ? opens the cheat sheet, Escape closes it again.
    for key, expect_visible in (('?', True), ('Escape', False)):
        v(cdp.eval("""(function(key) {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
            return { ok: true };
        })(%s)""" % json.dumps(key), target['id'], timeout=10))
        vis = v(cdp.eval(RE_TOOLS_JS, target['id'], timeout=10)).get('helpVisible')
        if vis is not expect_visible:
            raise AssertionError(f'key {key!r} should set help visible={expect_visible}, got {vis}')

    # b blacks the screen out; the next keypress dismisses it.
    v(cdp.eval("""(function() {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
        return { ok: true };
    })()""", target['id'], timeout=10))
    if not v(cdp.eval(RE_TOOLS_JS, target['id'], timeout=10)).get('blackoutVisible'):
        raise AssertionError('the b key did not black the screen out')
    v(cdp.eval("""(function() {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
        return { ok: true };
    })()""", target['id'], timeout=10))
    if v(cdp.eval(RE_TOOLS_JS, target['id'], timeout=10)).get('blackoutVisible'):
        raise AssertionError('a keypress did not dismiss the blackout')
    print('      ✓ shortcut help and presenter blackout respond to the keyboard')


XLSX_STATE_JS = """(function() {
    const host = document.getElementById('document-view');
    const content = host ? host.querySelector('.dochtml__content') : null;
    const tables = content ? [...content.querySelectorAll('table')] : [];
    return {
        mounted: !!host && !host.hidden,
        tableCount: tables.length,
        captions: tables.map(t => (t.querySelector('caption') || {}).textContent || ''),
        headers: content ? content.querySelectorAll('th').length : 0,
        cells: content ? content.querySelectorAll('td').length : 0,
        text: content ? (content.textContent || '') : '',
    };
})()"""


def step_document_view_renders_xlsx(cdp_holder):
    """A spreadsheet renders as an accessible table carrying its real sheet
    name — the caption proves the workbook.xml to worksheet join; the
    filename-order fallback would read "Sheet 1"."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/test.xlsx', XLSX_MIME)

    state: dict = {}
    deadline = time.time() + 60
    while time.time() < deadline:
        state = v(cdp.eval(XLSX_STATE_JS, target['id'], timeout=10))
        if state.get('tableCount'):
            break
        time.sleep(0.5)
    if not state.get('mounted') or not state.get('tableCount'):
        raise AssertionError(
            f'spreadsheet table did not render: {json.dumps(state, default=str)[:400]}')
    if state.get('captions') != ['Sheet1']:
        raise AssertionError(
            f'expected the workbook\'s own sheet name as caption, got {state.get("captions")}')
    if state.get('headers') != 3 or state.get('cells') != 3:
        raise AssertionError(
            f'expected a 3x2 table with a header row, got {state.get("headers")} th / '
            f'{state.get("cells")} td')
    stamps = _assert_generic_stamps(cdp, target['id'])
    if 'quick brown fox' not in (state.get('text') or ''):
        raise AssertionError('shared strings did not resolve into the cells')
    # Rows join with a blank line, so the reader speaks each row
    # as its own sentence — the row-by-row treatment CSV rows
    # already get. The fixture is a header row plus one data row.
    reader: dict = {}
    deadline = time.time() + 10
    while time.time() < deadline:
        reader = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
        if reader.get('sentenceCount'):
            break
        time.sleep(0.3)
    if reader.get('sentenceCount') != 2:
        raise AssertionError(
            f'the sheet must read as 2 sentences (one per row), got '
            f'{reader.get("sentenceCount")}: '
            f'{(reader.get("text") or "")[:200]!r}')
    print(f'      ✓ spreadsheet rendered: caption {state.get("captions")}, '
          f'{state.get("headers")} header cells, {stamps.get("count")} stamps, '
          f'{reader.get("sentenceCount")} row-sentences')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '11-document-view-xlsx.png')

    # Search reads the same text the table shows: "quick" occurs twice
    # (two rows quote the pangram), and jumping to the second one must
    # highlight it inside the table.
    v(cdp.eval("""(function() {
        const input = document.querySelector('#document-view .docview__search');
        if (!input) return { ok: false };
        input.value = 'quick';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
    })()""", target['id'], timeout=10))
    results: dict = {}
    deadline = time.time() + 10
    while time.time() < deadline:
        results = v(cdp.eval("""(function() {
            return {
                matches: document.querySelectorAll('#document-view .docview__result').length,
                status: (document.querySelector('#document-view .docview__search-status')
                    || {}).textContent || '',
            };
        })()""", target['id'], timeout=10))
        if results.get('matches'):
            break
        time.sleep(0.3)
    if results.get('matches') != 2:
        raise AssertionError(f'expected 2 search hits in the sheet, got {results}')
    v(cdp.eval("""(function() {
        const hits = document.querySelectorAll('#document-view .docview__result');
        if (hits.length > 1) hits[1].click();
        return { ok: hits.length > 1 };
    })()""", target['id'], timeout=10))
    highlighted = False
    deadline = time.time() + 10
    while time.time() < deadline:
        highlighted = v(cdp.eval(
            "({ hl: document.querySelectorAll('#document-view .dochtml__hl').length })",
            target['id'], timeout=10)).get('hl', 0) > 0
        if highlighted:
            break
        time.sleep(0.3)
    if not highlighted:
        raise AssertionError('jumping to a spreadsheet search hit produced no highlight')
    print(f'      ✓ search found both cells and highlighted the chosen one')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '11b-document-view-xlsx-search.png')


PPTX_STATE_JS = """(function() {
    const host = document.getElementById('document-view');
    const slides = host ? [...host.querySelectorAll('.dochtml__slide')] : [];
    const shapes = host ? [...host.querySelectorAll('.dochtml__slide-shape')] : [];
    return {
        mounted: !!host && !host.hidden,
        slides: slides.map(s => ({
            label: s.getAttribute('aria-label') || '',
            style: s.getAttribute('style') || '',
            text: s.textContent || '',
        })),
        shapes: shapes.map(s => ({ style: s.getAttribute('style') || '', text: s.textContent || '' })),
        headings: host ? host.querySelectorAll('.dochtml__slide h2').length : 0,
    };
})()"""


def step_document_view_renders_pptx(cdp_holder):
    """A deck shows as navigable slides with the contract extraction has
    always spoken: runs joined by spaces, slides separated by blank lines."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_served_file(cdp, target['id'], 'test-docs/test.pptx', PPTX_MIME)

    state: dict = {}
    deadline = time.time() + 60
    while time.time() < deadline:
        state = v(cdp.eval(PPTX_STATE_JS, target['id'], timeout=10))
        if state.get('slides'):
            break
        time.sleep(0.5)
    if not state.get('mounted') or not state.get('slides'):
        raise AssertionError(
            f'presentation slides did not render: {json.dumps(state, default=str)[:400]}')
    slide = state['slides'][0]
    if slide['label'] != 'Slide 1':
        raise AssertionError(f'expected a labelled slide card, got {slide["label"]!r}')
    if 'The quick brown fox jumps over the lazy dog' not in slide['text']:
        raise AssertionError(f'first run lost: {slide["text"][:120]!r}')
    if 'Lorem ipsum dolor sit amet.' not in slide['text']:
        raise AssertionError(f'second paragraph lost: {slide["text"][:120]!r}')
    stamps = _assert_generic_stamps(cdp, target['id'])
    # Slides join with blank lines and a slide's runs with spaces,
    # so each slide segments as its own sentence. This fixture is
    # one slide, and its only terminal punctuation ends the slide.
    reader: dict = {}
    deadline = time.time() + 10
    while time.time() < deadline:
        reader = v(cdp.eval(READER_STATE_JS, target['id'], timeout=10))
        if reader.get('sentenceCount'):
            break
        time.sleep(0.3)
    if reader.get('sentenceCount') != 1:
        raise AssertionError(
            f'the deck must read as 1 sentence (one per slide), got '
            f'{reader.get("sentenceCount")}: '
            f'{(reader.get("text") or "")[:200]!r}')
    print(f'      ✓ presentation rendered: {len(state["slides"])} slide card, '
          f'{stamps.get("count")} stamps, spoken text intact, '
          f'{reader.get("sentenceCount")} slide-sentence')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '12-document-view-pptx.png')


# A deck built here rather than committed: the shape geometry is the point
# of the check, so the fixture shows exactly the numbers asserted below.
# EMUs: 914400 per inch; this deck is 4:3 (914400 x 685800).
SYNTH_PPTX_PRESENTATION = '''<?xml version="1.0"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="914400" cy="685800"/>
</p:presentation>'''

SYNTH_PPTX_SLIDE = '''<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="100000"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="91440" y="100000"/><a:ext cx="731520" cy="585800"/></a:xfrm></p:spPr>
      <p:txBody>
        <a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t> world</a:t></a:r></a:p>
        <a:p><a:pPr algn="ctr"/><a:r><a:t>Second line</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>'''


def _build_layout_deck() -> bytes:
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('ppt/presentation.xml', SYNTH_PPTX_PRESENTATION)
        z.writestr('ppt/slides/slide1.xml', SYNTH_PPTX_SLIDE)
    return buf.getvalue()


def step_document_view_pptx_layout(cdp_holder):
    """Slide layout fidelity: text lands where the file says it stands.

    The synthetic deck declares exact shape geometry (title across the top,
    body inset at 10%), so the rendered shape containers must carry those
    proportions — this is the assertion that catches the view quietly
    falling back to a flat text column."""
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    _inject_bytes(cdp, target['id'], _build_layout_deck(), 'layout-deck.pptx', PPTX_MIME)

    state: dict = {}
    deadline = time.time() + 60
    while time.time() < deadline:
        state = v(cdp.eval(PPTX_STATE_JS, target['id'], timeout=10))
        if state.get('shapes') or state.get('slides'):
            break
        time.sleep(0.5)
    if not state.get('slides'):
        raise AssertionError(
            f'synthetic deck did not render: {json.dumps(state, default=str)[:400]}')
    shapes = state.get('shapes') or []
    if len(shapes) != 2:
        raise AssertionError(
            f'expected both shapes to keep their frames, got {len(shapes)}: {shapes}')
    title_shape = next((s for s in shapes if 'Quarterly Review' in s['text']), None)
    body_shape = next((s for s in shapes if 'Second line' in s['text']), None)
    if not title_shape or not body_shape:
        raise AssertionError(f'shape text is misplaced: {shapes}')
    if 'left:0.000%' not in title_shape['style'] or 'width:100.000%' not in title_shape['style']:
        raise AssertionError(f'title frame lost: {title_shape["style"]!r}')
    if 'left:10.000%' not in body_shape['style'] or 'width:80.000%' not in body_shape['style']:
        raise AssertionError(f'body frame lost: {body_shape["style"]!r}')
    if 'aspect-ratio' not in state['slides'][0]['style']:
        raise AssertionError(
            f'slide card does not carry its aspect ratio: {state["slides"][0]["style"]!r}')
    if not state.get('headings'):
        raise AssertionError('the title placeholder did not become the slide heading')
    stamps = _assert_generic_stamps(cdp, target['id'])
    print(f'      ✓ slide geometry preserved: title {title_shape["style"][:48]!r}…, '
          f'body {body_shape["style"][:48]!r}…, {stamps.get("count")} stamps')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '12b-document-view-pptx-layout.png')


# ─── Driver ──────────────────────────────────────────────────────────────

# Reads a real zip out of the page without a download directory: the
# object URL handed to the anchor is captured, then its entries are parsed
# from the central directory and the two text members are inflated with
# DecompressionStream. Downloading for real would need
# Browser.setDownloadBehavior plus a writable path, and this keeps the
# assertion on the bytes the app actually assembled.
ZIP_CAPTURE_JS = """(function() {
    window.__abZip = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
        if (!window.__abZip && obj instanceof Blob && obj.size > 512) window.__abZip = obj;
        return orig(obj);
    };
    return { ok: true };
})()"""

ZIP_LIST_JS = """(async function () {
    const blob = window.__abZip;
    if (!blob) return { ok: false, msg: 'no captured blob yet' };
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false, msg: 'no end-of-central-directory record' };
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entries = [];
    for (let n = 0; n < count; n++) {
        if (dv.getUint32(off, true) !== 0x02014b50) return { ok: false, msg: 'bad central dir' };
        const nlen = dv.getUint16(off + 28, true);
        const elen = dv.getUint16(off + 30, true);
        const clen = dv.getUint16(off + 32, true);
        entries.push({
            name: dec.decode(buf.subarray(off + 46, off + 46 + nlen)),
            method: dv.getUint16(off + 10, true),
            csize: dv.getUint32(off + 20, true),
            usize: dv.getUint32(off + 24, true),
            lho: dv.getUint32(off + 42, true),
        });
        off += 46 + nlen + elen + clen;
    }
    return { ok: true, size: buf.length, entries };
})()"""

ZIP_READ_JS = """(async function (name) {
    const blob = window.__abZip;
    if (!blob) return { ok: false, msg: 'no captured blob' };
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    let entry = null;
    for (let n = 0; n < count && !entry; n++) {
        const nlen = dv.getUint16(off + 28, true);
        const elen = dv.getUint16(off + 30, true);
        const clen = dv.getUint16(off + 32, true);
        const nm = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nlen));
        if (nm === name) {
            entry = {
                method: dv.getUint16(off + 10, true),
                csize: dv.getUint32(off + 20, true),
                lho: dv.getUint32(off + 42, true),
            };
        }
        off += 46 + nlen + elen + clen;
    }
    if (!entry) return { ok: false, msg: 'entry ' + name + ' not in bundle' };
    const lho = entry.lho;
    if (dv.getUint32(lho, true) !== 0x04034b50) return { ok: false, msg: 'bad local header' };
    const nlen = dv.getUint16(lho + 26, true);
    const elen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + nlen + elen;
    const raw = buf.subarray(start, start + entry.csize);
    let bytes;
    if (entry.method === 0) {
        bytes = raw;
    } else {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return { ok: true, text: new TextDecoder().decode(bytes).slice(0, 20000) };
})(%s)"""


def _done_clips(cdp, target_id: str) -> int:
    """How many clips in the reader's job list finished generating."""
    resp = cdp.eval(READER_STATE_JS, target_id, timeout=10)
    cards = v(resp).get('jobCards') or []
    return sum(1 for c in cards if c.get('status') == 'done')


def step_audiobook_chapters_export(cdp_holder):
    """Read a sectioned document, export the bundle, and open the zip.

    Chapter markers are only meaningful if they survive the whole path a
    user's audio takes: section offsets are into the extracted text, the
    chapters are located by finding those offsets in the merged transcript,
    and the result is written into the exported zip. Asserting the zip is
    what actually downloads catches a bundle that quietly lost the VTT, and
    checking the karaoke HTML carries the nav proves the standalone player
    was built with chapters rather than falling back to plain cues.
    """
    target = cdp_holder['target']
    cdp = cdp_holder['cdp']

    # reader-notes.docx: a Heading1 and a Heading2, so the export has more
    # than one chapter to place.
    _inject_served_file(cdp, target['id'], 'test-docs/reader-notes.docx', DOCX_MIME)
    deadline = time.time() + 60
    state: dict = {}
    while time.time() < deadline:
        state = v(cdp.eval(DOCHTML_STATE_JS, target['id'], timeout=10))
        if state.get('runs') or state.get('readerError'):
            break
        time.sleep(0.5)
    if not state.get('runs'):
        raise AssertionError(
            f'the DOCX did not render before the export step: {json.dumps(state, default=str)[:300]}')

    # One finished clip is enough: the bundle assembles from whatever the
    # session has produced, and reading the whole probe would add minutes.
    _click_trusted(cdp, target['id'], '#read-document-btn')
    clip_timeout = float(os.environ.get('YAPPER_AUDIOBOOK_CLIP_TIMEOUT', '180'))
    start = time.time()
    done = 0
    while time.time() - start < clip_timeout:
        done = _done_clips(cdp, target['id'])
        if done:
            break
        time.sleep(1.5)
    if not done:
        raise AssertionError(
            f'no clip finished generating within {clip_timeout}s, so the '
            f'audiobook has nothing to assemble')

    stop = cdp.find_element(target['id'], '#reader-overlay-stop')
    if stop:
        _click_trusted(cdp, target['id'], '#reader-overlay-stop')
    time.sleep(1)

    armed = v(cdp.eval(ZIP_CAPTURE_JS, target['id'], timeout=10))
    if not armed.get('ok'):
        raise AssertionError(f'could not arm the blob capture: {armed}')

    _click_trusted(cdp, target['id'], '#export-audiobook-btn')
    listing: dict = {}
    start = time.time()
    while time.time() - start < 60:
        # The zip readers are async IIFEs (blob.arrayBuffer()), so
        # they need awaitPromise — a plain eval returns the Promise
        # object itself, which serialises to {} and reads as "no zip".
        listing = v(cdp.eval_async(ZIP_LIST_JS, target['id'], timeout=30))
        if listing.get('ok') and listing.get('entries'):
            break
        time.sleep(0.5)
    if not listing.get('ok'):
        raise AssertionError(
            f'the export produced no readable zip: {listing.get("msg")!r}. '
            f'A notice may be showing in the reader panel.')

    names = [e['name'] for e in listing['entries']]
    base = 'reader-notes'
    for suffix in ('.wav', '.vtt', '-chapters.vtt', '-karaoke.html'):
        expected = base + suffix
        if expected not in names:
            raise AssertionError(
                f'{expected} is missing from the exported bundle: {names}')
    print(f'      ✓ bundle holds {len(names)} files: {", ".join(names)}')

    chapters = v(cdp.eval_async(ZIP_READ_JS % json.dumps(base + '-chapters.vtt'),
                                target['id'], timeout=30))
    if not chapters.get('ok'):
        raise AssertionError(f'could not read the chapters VTT: {chapters.get("msg")!r}')
    vtt = chapters['text']
    if not vtt.startswith('WEBVTT'):
        raise AssertionError(f'the chapters file is not WebVTT: {vtt[:40]!r}')
    if vtt.count('-->') < 1:
        raise AssertionError('the chapters file has no cues')
    for heading in ('Reader Probe', 'Rendering fidelity'):
        if heading not in vtt:
            raise AssertionError(
                f'chapter {heading!r} never made it into the markers: {vtt[:300]!r}')
    print(f'      ✓ chapters: {vtt.count("-->")} cues, both headings present')

    karaoke = v(cdp.eval_async(ZIP_READ_JS % json.dumps(base + '-karaoke.html'),
                               target['id'], timeout=30))
    if not karaoke.get('ok'):
        raise AssertionError(f'could not read the karaoke HTML: {karaoke.get("msg")!r}')
    html = karaoke['text']
    # A CSS class, not a JS identifier: the suite runs against the built
    # bundle, where local function names are minified away. It lives in the
    # page's <head>, which is why the read is capped at the first 20k.
    if 'chapnav' not in html:
        raise AssertionError(
            'the exported karaoke page has no chapter navigation: the '
            'chapters were dropped on the way into the bundle')
    print('      ✓ karaoke page carries chapter navigation')
    cdp.screenshot(target['id'], SCREENSHOT_DIR / '09-audiobook-chapters.png')


def main():
    banner('Yapper — E2E browser test via raw CDP')

    cdp_holder: dict = {}
    results: list[TestResult] = []

    steps = [
        ('connect_to_cdp', lambda: step_connect_to_cdp(cdp_holder)),
        ('attach_and_navigate', lambda: step_attach_and_navigate(cdp_holder)),
        ('verify_page_render', lambda: step_verify_page_render(cdp_holder)),
        # The app opens in its simple view: the model grid, language filter
        # and speed slider are behind one toggle, so the model-selection
        # steps below have to turn advanced mode on first.
        ('assert_simple_mode', lambda: step_assert_simple_mode(cdp_holder)),
        # Before any model is selected or loaded: the recordings must make
        # every voice audible on their own.
        ('assert_audition_without_download',
         lambda: step_assert_audition_without_download(cdp_holder)),
        ('enable_advanced_mode', lambda: step_enable_advanced_mode(cdp_holder)),
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
        ('switch_to_reader', lambda: step_switch_to_reader(cdp_holder)),
        ('load_sample_document', lambda: step_load_sample_document(cdp_holder)),
        ('upload_txt_document', lambda: step_upload_txt_document(cdp_holder)),
        ('queue_reader_read', lambda: step_queue_reader_read(cdp_holder)),
        ('assert_highlight_advances', lambda: step_assert_highlight_advances(cdp_holder)),
        ('pause_resume_reader', lambda: step_pause_resume_reader(cdp_holder)),
        ('stop_reader', lambda: step_stop_reader(cdp_holder)),
        ('upload_pdf_document', lambda: step_upload_pdf_document(cdp_holder)),
        # The same PDF, seen the way a user sees it: real pages on screen, and
        # a click on the page starting the read from that sentence.
        ('document_view_renders_pdf', lambda: step_document_view_renders_pdf(cdp_holder)),
        # A DOCX has no page geometry, so it takes the other rendering path:
        # markup built from the extracted runs and highlighted by offset.
        ('document_view_renders_docx', lambda: step_document_view_renders_docx(cdp_holder)),
        # The one non-OOXML container: outline levels on text:h, and a
        # package whose mimetype member must stay stored.
        ('document_view_renders_odt', lambda: step_document_view_renders_odt(cdp_holder)),
        # Reflowable formats beyond DOCX: EPUB chapters from the book's own
        # TOC, spreadsheets as tables named by the workbook, presentations
        # as slides that keep the file's shape geometry.
        ('document_view_renders_epub', lambda: step_document_view_renders_epub(cdp_holder)),
        ('document_view_renders_xlsx', lambda: step_document_view_renders_xlsx(cdp_holder)),
        ('document_view_renders_pptx', lambda: step_document_view_renders_pptx(cdp_holder)),
        ('document_view_pptx_layout', lambda: step_document_view_pptx_layout(cdp_holder)),
        # The toolbox around the document: outline, tabs, status bar, recent
        # shelf, keyboard shortcuts, and the presenter blackout.
        ('document_view_reading_tools', lambda: step_document_view_reading_tools(cdp_holder)),
        # The fixtures that predate the chapter work but never reached a
        # browser step: RTF's control words, HTML's own markup, and CSV's
        # quoting (plus the chapters it must NOT invent).
        ('document_view_renders_rtf', lambda: step_document_view_renders_rtf(cdp_holder)),
        ('document_view_renders_html', lambda: step_document_view_renders_html(cdp_holder)),
        ('upload_csv_document', lambda: step_upload_csv_document(cdp_holder)),
        # The legacy binary format, with the same row-by-row respect:
        # a .doc reads one sentence per paragraph.
        ('upload_doc_document', lambda: step_upload_doc_document(cdp_holder)),
        # The export, opened up: read a sectioned DOCX, let one clip finish,
        # export the bundle and read the zip back out of the page to confirm
        # the chapter VTT and the karaoke player's nav both made it in.
        ('audiobook_chapters_export', lambda: step_audiobook_chapters_export(cdp_holder)),
        ('upload_scanned_pdf_ocr', lambda: step_upload_scanned_pdf_ocr(cdp_holder)),
        # Live progress on Kokoro's streaming path, LAST: load the bigger
        # model, generate a multi-sentence input, and confirm sentence-
        # segment markers appear in the card hint while it runs. Slow on
        # CPU/WASM, so nothing is queued behind it.
        ('switch_to_studio', lambda: step_switch_to_studio(cdp_holder)),
        ('kokoro_segment_progress', lambda: step_kokoro_segment_progress(cdp_holder)),
    ]

    # YAPPER_E2E_ONLY selects a subset of steps by shell-style pattern, in
    # their original order. Most steps download a real model, so the full
    # suite outlasts a short shell window; this makes a fast loop on one
    # area possible without reordering or editing the list above. The first
    # three steps always run: the suite cannot evaluate anything without a
    # page.
    #
    # Patterns, not substrings, and the difference is not cosmetic: with a
    # substring filter "mode" also matches "select_model", so a run meant to
    # touch the simple/advanced steps silently dragged in model selection.
    #   YAPPER_E2E_ONLY=assert_simple_mode   exact name
    #   YAPPER_E2E_ONLY='*mode'              both mode steps, not select_model
    #   YAPPER_E2E_ONLY='kokoro*,*reader'    a comma-separated list
    only = os.environ.get('YAPPER_E2E_ONLY', '').strip()
    if only:
        patterns = [p.strip() for p in only.split(',') if p.strip()]
        always = {'connect_to_cdp', 'attach_and_navigate', 'verify_page_render'}
        picked = [(n, f) for (n, f) in steps
                  if n in always or any(fnmatch.fnmatch(n, p) for p in patterns)]
        # A pattern that matches nothing is a typo, and running just the
        # three bootstrap steps would report a cheerful "3 STEPS PASSED"
        # for a run that tested nothing at all. Say so and stop.
        selected = [n for (n, _) in picked if n not in always]
        if not selected:
            print(f'  YAPPER_E2E_ONLY={only!r} matched no step.', file=sys.stderr)
            print('  Known steps: ' + ', '.join(n for (n, _) in steps), file=sys.stderr)
            sys.exit(2)
        steps = picked
        print(f'  (filtered: {patterns} → {selected})')

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