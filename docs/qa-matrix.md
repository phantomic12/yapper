# Cross-browser QA matrix

**Date:** 2026-08-23 · **App:** https://phantomic12.github.io/yapper/ · **Model:** Kitten TTS Nano (~24 MB)

Automated pass driven by `qa/run_qa.py` (Playwright). Each column runs the same checklist:
load app → select kitten-nano → Download & Load model → queue a generation → confirm `<audio>`
element appears → download WAV → document reader with TXT → document reader with PDF.

| Feature            | Chromium 151 | Chrome 124 (CDP container) | Firefox 153 | Edge 151 | WebKitGTK | Chromium mobile (iPhone 13 viewport) |
| ------------------ | ------------ | -------------------------- | ----------- | -------- | --------- | ------------------------------------ |
| App loads          | ✅           | ✅                         | ✅          | ✅       | ✅        | ✅                                   |
| Select model       | ✅           | ✅                         | ✅          | ✅       | ✅        | ✅                                   |
| Download & Load    | ✅ 6.2s      | ✅ 4.1s                    | ✅ 10.4s    | ✅ 6.1s  | ✅ 8.3s   | ✅ 6.2s                              |
| Generate + audio   | ✅ 5.9s      | ✅ 5.9s                    | ✅ 44.5s¹   | ✅ 5.9s  | ✅ 6.8s   | ✅ 5.5s                              |
| Download WAV       | ✅²          | n/a³                       | ✅²         | ✅²      | ✅²       | ✅²                                  |
| Doc reader: TXT    | ✅           | n/a³                       | ✅          | ✅       | ✅        | ✅                                   |
| Doc reader: PDF    | ✅           | n/a³                       | ✅          | ✅       | ✅        | ✅                                   |
| Console clean      | ✅⁴          | ✅                         | ✅⁴         | ✅⁴      | ✅⁴       | ✅⁴                                  |
| Backend            | WebGPU       | WebGPU                     | WASM        | WebGPU   | WASM      | WebGPU                               |

All columns **pass** against the patched build (`qa/run_qa.py` → `qa/results/*.json`, raw step
notes and timings preserved there). Raw result JSONs are committed under `qa/results/`.

Notes:

1. Firefox has no WebGPU here → ONNX WASM fallback; first generation is ~7× slower than the
   WebGPU browsers but completes correctly. Subsequent generations are comparable.
2. Download-WAV passes only after the [#38](https://github.com/phantomic12/yapper/issues/38)
   fix (commit `c91dd2b`). See [Defects](#defects).
3. The Chrome 124 kernel-images CDP container pass ran early against the live site, before the
   download defect was found; load/generate steps recorded, remaining steps were then covered by
   the full Chromium pass. Re-running it against the patched build is cheap if desired.
4. Zero console errors and zero page errors; 1–2 benign console infos (service-worker /
   cache-bust logs). Counts per column are in the result JSONs.

## Defects

### #38 — Download WAV button does nothing (found & fixed this pass)

- **Found:** automated Chromium smoke against the **live site**: generation completes,
  `<audio src="blob:…">` present, button visible+enabled, click produces no download event and
  no console error ([result](../qa/results/chromium-smoke.json)).
- **Root cause:** `wireCardButtons()` guarded all listener wiring behind a one-time card-level
  flag, but `renderJobList()` relies on re-running it after a job card's body is replaced when
  the job flips to `done` — so the download button (and audio element) on any job that finished
  *after* initial render never got listeners. Full write-up with repro steps in
  [#38](https://github.com/phantomic12/yapper/issues/38).
- **Fix:** idempotent per-element wiring (`data-wired` on each action element / audio node)
  instead of a card-level flag — commit `c91dd2b` in this PR.
- **Verification:** Download WAV now passes 7/7 browser configs against the patched build;
  every saved artifact is a valid RIFF/WAVE of identical byte size (190,844 B), matching across
  engines.

> The live GitHub Pages site keeps serving the pre-fix bundle until this PR merges and
> `deploy.yml` redeploys; the defect is expected to disappear from production after that.

## Not tested / skipped

| Target                     | Status | Reason                                                       |
| -------------------------- | ------ | ------------------------------------------------------------ |
| Real Safari (macOS/iOS)    | skip   | No Apple hardware reachable from the QA host.                |
| Other mobile viewports     | skip   | One representative mobile viewport agreed as the minimum.    |
| Non-headless visual review | skip   | All passes headless under Xvfb; no rendering defects looked for beyond functional checks. |

## Environment

- QA host: Linux x86_64 container, no root. Browsers: Playwright-managed Chromium 151
  ("Chrome for Testing" 151.0.7922.34) and Firefox 153; real Microsoft Edge 151.0.4129.101
  extracted locally from the official MS deb; Playwright WebKitGTK build (webkit-2336,
  libwebkitgtk-6.0 = 2.48 series) launched with its own lib/soup stack plus a sysroot for
  gstreamer/GTK deps, `GIO_MODULE_DIR` limited to gnutls so plain-http **and** TLS work.
- Chrome 124 pass ran in the shared kernel-images CDP container (`chrome-cdp` on rainbowone,
  reached at `172.17.0.1:9222`) per the chrome-cdp pattern.
- Post-fix passes ran against a local serve of the patched build (`http://127.0.0.1:8098`),
  since the live site intentionally still had the bug.
- Harness: `qa/run_qa.py` (per-engine launcher + 7-step checklist), `qa/run_qa_cdp.py`
  (CDP-container variant), `qa/file_issue.py` (files the defect), `qa/results/*.json` (raw).
