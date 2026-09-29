"""
Verify the PDF document view rasterises in a real browser.

Why a script and not a unit test: pdfjs drives its render loop from
`requestAnimationFrame`, so a headless/uncomposited browser that never fires
rAF (the in-app preview panel is one) leaves `page.render().promise` hanging
forever with no error at all. That is not a property of the view — it is a
property of the browser — so the only honest place to check that a page
actually paints is a real Chrome, which is what scripts/run_e2e_windows.sh
already launches for the OCR steps.

    python scripts/check_docview.py
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import e2e_test  # noqa: E402
from e2e_test import CDPSession, fetch_cdp, list_targets, v  # noqa: E402

PORT = int(os.environ.get('YAPPER_DOCVIEW_CDP', '9226'))
URL = os.environ.get('YAPPER_URL', 'http://localhost:5200/')

MOUNT_JS = r"""
(async () => {
  const [docReader, view, ttsReader] = await Promise.all([
    import('/src/document-reader.ts'),
    import('/src/ui/document-view.ts'),
    import('/src/reader.ts'),
  ]);
  const buf = await (await fetch('/test-pdfs/text-based.pdf')).arrayBuffer();
  const file = new File([buf], 'text-based.pdf', { type: 'application/pdf' });
  const doc = await docReader.extractDocument(file, { watchdogEnabled: false });
  const host = document.createElement('div');
  host.id = 'docview-probe';
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;';
  document.body.appendChild(host);
  const errors = [];
  // Recorded clicks, and the sentence each one resolves to, so the check is
  // about the arithmetic rather than about "a handler fired".
  window.__picks = [];
  const v = await view.mountPdfView(host, file, doc.anchors || [], {
    // Scale 1 keeps anchor coordinates identical to CSS pixels, so the check
    // clicks the anchor's own rectangle instead of re-deriving the transform.
    scale: 1,
    onError: (e, p) => errors.push({ page: p, err: String(e).slice(0, 200) }),
    onPick: (offset) => window.__picks.push(offset),
  });
  v.highlight(0, 43);
  window.__text = doc.text;
  window.__anchors = doc.anchors || [];
  window.__sentences = ttsReader.prepareReaderData(doc.text, 300).sentences;
  return { anchors: (doc.anchors || []).length, pageCount: v.pageCount, errors };
})()
"""

# Clicks the middle of each anchor that is actually inside the viewport and
# reports what each one resolved to. One click would prove the handler runs;
# several, at different points in the document, prove the offset is computed
# from *where* was clicked rather than defaulting to the top of the page.
CLICK_JS = r"""
(() => {
  const host = document.getElementById('docview-probe');
  const surface = host.querySelector('.docview__surface');
  const box = surface.getBoundingClientRect();
  const results = [];

  for (const a of window.__anchors) {
    const x = box.left + a.x + a.width / 2;
    const y = box.top + a.y + a.height / 2;
    if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) continue;
    surface.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    const picked = window.__picks[window.__picks.length - 1];
    const sentence = window.__sentences.indexOf(
      window.__sentences.find(s => s.start !== undefined && picked >= s.start && picked < s.end) || null,
    );
    const s = window.__sentences[sentence];
    results.push({
      anchorRange: [a.start, a.end],
      anchorText: window.__text.slice(a.start, a.end).slice(0, 30),
      picked,
      insideAnchor: picked >= a.start && picked < a.end,
      sentenceIndex: sentence,
      sentenceText: s ? window.__text.slice(s.start, s.end).slice(0, 40) : null,
      anchorTextIsInSentence: !!(s && window.__text.slice(s.start, s.end).includes(
        window.__text.slice(a.start, a.end).trim())),
    });
  }
  return { clicks: results.length, results };
})()
"""

# Polls rather than sleeping a fixed amount: the render is async and the point
# of this check is that it *finishes*, so waiting a fixed 3s would pass just as
# happily on a hang.
CHECK_JS = r"""
(() => {
  const host = document.getElementById('docview-probe');
  if (!host) return { ready: false, why: 'view not mounted' };
  const canvas = host.querySelector('canvas');
  if (!canvas) return { ready: false, why: 'no canvas yet' };
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++;
  const boxes = [...host.querySelectorAll('.docview__hl')].map(b => ({
    left: b.style.left, top: b.style.top, width: b.style.width, height: b.style.height,
  }));
  return {
    ready: true,
    canvas: { w: canvas.width, h: canvas.height, cssW: canvas.style.width },
    darkPixels: dark,
    pageCountLabel: host.querySelector('.docview__count')?.textContent,
    highlightBoxes: boxes,
  };
})()
"""


def main() -> int:
    e2e_test.CDP = f'http://localhost:{PORT}'
    import shutil
    profile = Path(os.environ.get('TEMP', '/tmp')) / 'yapper-docview-profile'
    shutil.rmtree(profile, ignore_errors=True)

    chrome = next((p for p in (
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe') if Path(p).exists()), None)
    if not chrome:
        print('no Chrome found', file=sys.stderr)
        return 2

    proc = subprocess.Popen([
        chrome, '--headless=new', f'--remote-debugging-port={PORT}',
        "--remote-allow-origins=*", f'--user-data-dir={profile}',
        '--autoplay-policy=no-user-gesture-required', '--no-first-run',
        '--no-default-browser-check', '--disable-gpu', 'about:blank',
    ])
    try:
        for _ in range(40):
            time.sleep(0.5)
            try:
                fetch_cdp('/json/version')
                break
            except Exception:
                continue
        else:
            print('Chrome never came up', file=sys.stderr)
            return 2

        cdp = CDPSession(fetch_cdp('/json/version')['webSocketDebuggerUrl'])
        target = next(t['id'] for t in list_targets() if t.get('type') == 'page')
        sid = cdp.attach(target)
        cdp.send('Page.enable', session_id=sid)
        cdp.send('Runtime.enable', session_id=sid)
        cdp.send('Page.navigate', {'url': URL}, session_id=sid)

        for _ in range(90):
            time.sleep(1)
            try:
                if v(cdp.eval("!!document.querySelector('.model-card')", target)):
                    break
            except Exception:
                continue

        mount = v(cdp.eval_async(MOUNT_JS, target, timeout=120))
        print('mount:', json.dumps(mount))

        last = None
        for _ in range(40):
            time.sleep(0.5)
            last = v(cdp.eval(CHECK_JS, target, timeout=20))
            if last.get('ready'):
                break

        print('check:', json.dumps(last, indent=2))
        rasterised = bool(last and last.get('ready') and last.get('darkPixels', 0) > 0)

        clicks = v(cdp.eval(CLICK_JS, target, timeout=20))
        print('clicks:', json.dumps(clicks, indent=2))
        rows = (clicks or {}).get('results') or []
        clicks_ok = (
            len(rows) >= 2
            and all(r['insideAnchor'] and r['sentenceIndex'] >= 0 for r in rows)
            and len({r['sentenceIndex'] for r in rows}) >= 2
            and all(r['anchorTextIsInSentence'] for r in rows)
        )

        ok = rasterised and clicks_ok
        print()
        if not rasterised:
            print('FAIL — nothing was drawn')
        elif not clicks_ok:
            print('FAIL — clicking the page did not resolve to the right sentences')
        else:
            print(f"PASS — page rasterised and {len(rows)} clicks each resolved to "
                  f"{len({r['sentenceIndex'] for r in rows})} distinct sentences")
        return 0 if ok else 1
    finally:
        proc.terminate()


if __name__ == '__main__':
    sys.exit(main())
