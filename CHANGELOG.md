# Changelog

All notable changes to Yapper are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Live generation progress** on job cards. A `jobProgress` heartbeat
  (~500ms) from `TTSEngine.processQueue` drives a ticking seconds counter,
  an indeterminate progress bar, and — for Kokoro's streaming path — a
  determinate "sentence N" readout forwarded over a new
  `generate-progress` worker message (`worker-bridge` routes it to the
  pending slot like load progress). Pending jobs show queue position
  ("2nd in queue"). Updates touch only the card's hint/progress nodes;
  no innerHTML re-render at 2Hz. Heartbeats clear on done/error/cancel
  and on engine dispose.
- **E2E coverage**: `assert_progress_ticks` (card text changes ≥2x in 3s
  during kitten-nano generation) and `kokoro_segment_progress`
  (multi-sentence input shows segment markers) steps in `e2e_test.py`.

### Fixed
- **Kitten models failed to load on subpath deploys**: `publicLibUrl()`
  climbed three directory levels from the worker module URL, overshooting
  the app root whenever Yapper is served under a subpath (GitHub Pages
  serves `/yapper/`), so the tokenizer fetch hit `<origin>/lib/…` and 404'd.
  Found by the v0.2.0 release spot-check on the live site. Production
  workers now climb one level (`<deploy-root>/assets/` → deploy root) and
  dev-server modules two, independent of deploy depth; full e2e re-run
  green against dist served under a `/yapper/` subpath.

## [0.2.0] - 2026-08-24

### Fixed
- **GPU smoke test actually verifies inference**: the Kaggle kernel no
  longer attempts Docker-in-Docker (impossible inside a kernel — every
  scheduled run died with `KernelWorkerStatus.ERROR` in ~1 min while
  Frederisk/kaggle-action crashed parsing the kernel log). The workflow
  now drives the `kaggle` CLI directly, installs Chromium/Xvfb/Mesa in
  the kernel, runs `docker/gif/gpu_smoke_test.py` in-process, and gates
  green on real evidence: WebGPU adapter available + model load +
  generation with positive audio duration in `gpu-smoke-report.json`.

### Added
- **End-to-end test harness** (`e2e_test.py`, driven by
  `scripts/run_e2e.sh`): a raw-CDP headless-Chrome suite covering the
  document reader flow — TXT/PDF fixture upload, extracted-text
  rendering, read-aloud queueing, live highlight advance, stop
  teardown, and worker-backed inference — run in CI (`.github/workflows/e2e.yml`)
  against both the dev server and the production build.
- **Honest capability banner** (`src/capability.ts`, documented in
  `docs/capability-banner.md`): three-class WebGPU detection — `none`
  (no API: Firefox stable, iOS Safari), `partial` (API present but adapter
  unusable/stalled: Firefox Nightly behind its flag), `full` — each with
  distinct truthful banner wording, a colored status dot, and a hover
  explanation. Detection never hangs boot: adapter requests race a 2s
  timeout.
- **Download failure recovery**: failed Hugging Face downloads surface an
  assertive error banner with a one-click **Retry** button, and an engine
  watchdog reports a stalled download ("no progress for 5s") instead of
  hanging silently on flaky networks or blocked huggingface.co.
- **Main-thread model warning**: selecting SpeechT5 or an MMS-TTS model
  shows a prominent in-app warning that generation may briefly freeze the
  page (those models run Transformers.js on the main thread), so the
  non-blocking promise stays honest about which models are worker-backed.
- **Generation liveness indicator**: a pulsing "Generating audio… N jobs in
  progress" badge appears next to the queue while any job generates,
  including during main-thread synthesis that freezes timers — no silent
  state longer than 5s during load or generate.
- **GPU smoke run proof**: manual dispatches get a `break_token` input
  that corrupts `KAGGLE_API_TOKEN` to prove the run fails loudly; every
  run uploads its report JSON + probe screenshots as an artifact; a
  GPU smoke badge on the README tracks weekly kernel health.

### Architecture
- **`docs/architecture.md`** — one-screen map of `engine`, `engines/`
  (including `WorkerBackedEngine`), `document-reader`, `reader`, and
  the optional `docs`/`ocr` path.
- **Self-hosted Tesseract assets** documented under
  `public/lib/tesseract/` (worker, LSTM WASM core, `eng.traineddata`)
  for on-device PDF OCR in the document reader.

### Changed
- **README truthfulness pass**: models list matches `MODELS` (Kokoro
  q8/fp16, Kitten mini/nano, SpeechT5, 9× MMS-TTS); document formats
  match `document-reader.ts`; Kokoro/Kitten described as
  worker-backed so the main thread stays responsive for those
  engines; SpeechT5/MMS remain main-thread Transformers.js.
- **Demo capture docs**: animated `docs/demo.gif` / `docs/demo.mp4`
  regenerate via `scripts/capture_demo_v3.py`; `npm run demo:capture`
  (`scripts/capture_demo.py`) is stills-only into `scripts/demo-shots/`.
- **CONTRIBUTING** points at worker-bridge registration and
  `docs/architecture.md`.
- **Stale "main thread" comment removed** from `src/app-bootstrap.ts`
  (and tightened in `src/engines/kitten.ts` `getOrt()`): both still
  claimed "inference runs on the main thread" but Kokoro + Kitten
  actually run inside `WorkerBackedEngine` → `inference-worker.ts`.
  New comments describe the worker path explicitly and point at the
  `copy-ort-wasm` Vite plugin.
- **README launch polish**: CI/e2e/Pages status badges, a supported
  browsers section sourced from the cross-browser QA matrix, and demo
  GIF/MP4 re-captured against the current UI (`docs/demo.gif`,
  `docs/demo.mp4`). The GPU-smoke badge is deferred until the Kaggle
  workflow is reliably green.

### Fixed
- **Dead "Download WAV" button (#38)**: `wireCardButtons()` guarded all
  listener wiring behind a one-time card-level flag, but the job list
  re-renders when a job flips to done — so buttons on cards that
  finished after initial render had no click listener. Wiring is now
  idempotent per element (`data-wired`), found by cross-browser live
  QA.
- **CSP blocks Hugging Face xet CDN**: model weights for xet-backed repos
  (`Xenova/mms-tts-*`, SpeechT5, etc.) are served from
  `https://us.aws.cdn.hf.co`, which the Content-Security-Policy did not
  allow in `connect-src` — downloads failed with `Failed to fetch` on any
  fresh browser (no cache), making retry recovery impossible. The origin is
  now whitelisted alongside `cdn-lfs.huggingface.co`. Found by the AC1
  blocked-network live test (`qa/verify_capability_ux.py`).
- **Mobile polish pass** (audited at 360x800 and 390x844): phone-width
  tap targets brought to comfortable sizes — job-card cancel "×"
  (~48px effective hit area), speed slider track/thumb, reader-overlay
  Pause/Stop/Close buttons (≥46px, stacked full-width), document
  action buttons, voice cards, language select, "Try sample" and
  "Download WAV" buttons; footer attribution links given 44px-tall
  hit areas; generating overlay card no longer fills small screens.
- **Service worker offline shell actually works now**: `favicon.svg`
  lived at the repo root (outside `public/`) so it was never emitted
  into `dist/` and returned 404 in production; `sw.js`
  `cache.addAll([...])` therefore failed on install and the worker
  went redundant — no offline caching at all. Moved the file into
  `public/`; verified offline reload now serves the cached shell
  (SW active, 9 assets cached).
- **iOS safe areas**: `viewport-fit=cover` added to the viewport meta;
  reader overlay header/legend and footer respect
  `env(safe-area-inset-*)`.
- **Broken CSS variable** in `.ocr-mode-selector`: referenced
  non-existent `var(--surface)` (transparent background); now
  `var(--bg-surface)`.
- **Dev/production parity fixes** surfaced by running the new e2e suite
  against both servers: `tesseract.js` (CommonJS) removed from Vite's
  `optimizeDeps.exclude` — unbundled CJS crashed the dev-server module
  graph with a blank page; tokenizer/lib assets under `/lib` now anchor
  on `document.baseURI` so `npm run dev` no longer fetched `index.html`
  instead of JSON; the CSP allows Hugging Face's xet CDN used by
  main-thread pipelines.
- **New `copy-ort-wasm` Vite plugin** (`vite.config.ts`) copies every
  onnxruntime-web WASM flavor into `public/ort-wasm/` with stable
  names. Belt-and-braces fallback: the Vite-emitted content-hashed
  URL is still the primary WASM source for `WorkerBackedEngine`, but
  any explicit `locateFile` / `wasmPaths` call now resolves to a
  non-hashed URL on stable filenames. Stops "no available backend
  found" regressions if the WASM hash strategy ever changes.

### Prior integration work (also in this release)

#### Added
- **Vitest test suite** with 94 tests covering the WAV encoder, speed
  resampling, sentence segmentation (including abbreviation handling),
  paragraph chunking, MIME routing, file-extension parsing, the
  hand-rolled `.npy`/`.npz` parsers, and the `MODELS` registry
  invariants. Test scripts: `npm test`, `npm run test:watch`,
  `npm run test:ui`, `npm run test:coverage`.
- **Link-health regression test** (`src/links.test.ts`) that HEAD-probes
  every model and asset in the registry and asserts each resolves at
  HF. Auto-skips when offline; force on with `YAPPER_LINK_CHECK=1`.
  Wired into a new `.github/workflows/ci.yml`.
- **ESLint** with `typescript-eslint` recommended rules. New scripts:
  `npm run lint`, `npm run lint:fix`.
- **`TTSEngine` event emitter** (`src/events.ts`). Public API is now
  `engine.on('event', fn) → unsubscribe`. The legacy `EngineEvents`
  callback bag still works for backward compatibility, but new code
  should use the typed emitter. Multiple `DocumentReaderSession`s no
  longer clobber each other's `onJobDone` listener.
- **Word-level highlight timing** (`pickHighlightedWord`). The document
  reader now uses per-word timings when the engine provides them
  (kokoro-js `stream()` populates these from phoneme durations) and
  falls back to chunk-position ratio for engines that don't (kitten,
  MMS-TTS).
- **PDF page cap** (`MAX_PDF_PAGES = 500` in `document-types.ts`) to
  prevent OOM on 1000+ page PDFs. Override via
  `extractDocument(file, { maxPdfPages })`.
- **`postinstall` script** (`scripts/copy-pdf-worker.mjs`) that copies
  `pdfjs-dist`'s worker into `public/` so `npm run dev` works on a
  fresh clone without manual setup. A matching Vite plugin runs on
  `npm run build` to keep `dist/` in sync.

#### Changed
- **`TTSEngine.loadModel` is now single-flight.** Two rapid clicks on
  "Download & Load Model" no longer race; the second call awaits the
  first.
- **`float32ToWav` rounds peak values** instead of truncating.
  `±0.99998` now maps to `±32767 / -32768` rather than `±32765/6`.
- **Kokoro engine respects the user-selected dtype.** The fp16 model
  card actually downloads the fp16 file now — previously it silently
  fell back to q8 because the engine hardcoded `dtype: 'q8'` and
  passed an invalid `modelFileName` option that kokoro-js ignored.
- **`kitten-mini` points at the correct ONNX file**
  (`kitten_tts_mini_v0_8.onnx`). Previously it 404'd because the
  default was the nano model's filename.
- **Five non-existent MMS-TTS language entries removed**
  (`ita`, `jpn`, `zho`, `nld`, `pol`). Their HF repos return 401.
  Matching language-filter options removed from the UI.
- **`extractDocument` rejects `useOcr: true` for non-PDFs** up
  front with a clear error instead of failing deep inside Tesseract.

#### Fixed
- **Sentence splitter preserves abbreviations.** "Mr. Smith went to
  Washington." is one sentence now; "Jan. 5, 2024" stays together.
  Protects ~50 known abbreviations and extends the lookahead to
  digits, CJK characters, and opening quotes.
- **XSS in `showStatus`**. Error messages flowed into `innerHTML`
  unescaped and could include user-controlled strings from third-party
  fetch failures. Now uses `escapeHtml`.
- **`clearFinished()` no longer leaks blob URLs** or the audio buffers
  behind them — they were held until `dispose()`.
- **`parseNpy` array-alignment crash.** The standalone `.npy` parser
  created a `Float32Array` view at an unaligned offset, which crashes
  on any v2/v3 header. Now copies into a fresh aligned ArrayBuffer.
- **`parseNpy` shape regex** now accepts canonical NumPy 1D shapes
  `(N,)` (it previously required a trailing digit and returned
  1-element zero arrays for every 1D file).
- **`renderJobCard` audio duration** uses `Math.floor` with a
  sample-rate guard instead of an obscure `(x/y) | 0` truncation.

#### Security
- **All 4 `npm audit` vulnerabilities resolved.** Pinned
  `@xmldom/xmldom@^0.9.8` via `package.json` `overrides`; `tar` and
  `protobufjs` updated via `npm audit fix`. `npm audit` now reports
  zero vulnerabilities.

## [0.1.0] - 2026-07-27

First public release. Live demo at
[phantomic12.github.io/yapper](https://phantomic12.github.io/yapper/).

### Added
- **Three TTS models in the registry**: Kokoro-82M (q8f16 and fp16
  variants, ~86MB / ~163MB), Kitten TTS Mini + Nano (~78MB / ~24MB),
  SpeechT5 (~330MB, multi-voice via xvector embeddings), and 9
  MMS-TTS language models (English, Spanish, French, German,
  Portuguese, Russian, Korean, Hindi, Arabic)
- **Browser-only inference** via Transformers.js + ONNX Runtime Web
  with WebGPU acceleration and WASM fallback. Models load once,
  then everything runs locally — no data ever leaves the device
- **Non-blocking job queue** — stack multiple generations, page
  stays usable while inference runs
- **Document reader** — upload PDF, DOCX, ODT, EPUB, TXT, or
  Markdown. Text layer extracted first; experimental layout OCR
  for scanned PDFs
- **Real-time highlighting** — sentence and word-level highlighting
  in the document reader, driven by kokoro-js phoneme durations
- **PWA**: installable standalone app with offline app-shell
  service worker, 11 icon sizes (16/32/48/152/167/180/192/256/512/
  512-maskable/1024), `apple-touch-icon`, and `apple-touch-startup-image`
  meta. Browsers that support PWA install get a "Add to Home Screen"
  prompt
- **Demo GIF + MP4** in the README, generated by a Docker pipeline
  with `--gpus all` (the headless capture runs the model load
  on a real GPU when the host has one)
- **GPU smoke test** (`.github/workflows/gpu-smoke.yml`) runs on
  Kaggle's free GPU tier weekly + on release publish, verifying
  WebGPU is exposed and a real model load + inference round-trip
  completes end-to-end
- **Link-health regression test** that HEAD-probes every model
  and asset URL in the registry, so renamed/removed HF repos
  fail CI instead of failing silently in production
- **100+ unit tests** (vitest) covering WAV encoding, sentence
  segmentation, paragraph chunking, file routing, .npy/.npz
  parsing, MODELS registry invariants, worker message-protocol
  encoding, and the kitten URL construction

### Changed
- **Off-thread inference via Web Worker** (`src/engines/inference-worker.ts`
  + `worker-bridge.ts`). The main thread stays responsive during
  long generations. Kokoro and Kitten both run inside a dedicated
  Worker; the engine's `CustomEngine` interface is preserved
  so queue/UI code is unaware workers exist
- **Selected vs loaded model distinction** — the model card shows
  "Selected" (radio chosen), "Loaded" (engine ready), or
  "Click to select" with a green border + tag for the loaded
  one
- **Real load progress** in the Load button label
  ("Downloading Kitten TTS Nano (~24MB)… 47% (11.3 MB)")

### Fixed
- **Nested `<button>` in `<button>` auto-closes the outer** (HTML
  parser quirk). The model card was changed to a `<div role="radio">`
  with an inner pick button; sample button is now a legal child
- **CSS `display: inline-block` overrode the `hidden` attribute**
  on the "Try sample" button. Added explicit
  `.model-card__sample[hidden] { display: none; }` so the button
  only shows once a model is loaded
- **Kitten tokenizer URL was 404ing in production builds** because
  `import.meta.env.BASE_URL + 'lib/...'` resolved to `/assets/lib/...`
  in the production bundle. Fixed to
  `new URL('../lib/...', import.meta.url)` so the URL is computed
  relative to whichever bundle loads kitten.ts (main or worker)
- **Kitten model/voices URL had double `KittenML/` path** —
  `MODEL_URL_BASE` was `'https://huggingface.co/KittenML/'` and
  `modelId` was already `'KittenML/...'`, producing
  `huggingface.co/KittenML/KittenML/.../voices.npz`. Removed the
  duplicate org from the URL base

### Security
- **Pinned `@xmldom/xmldom@^0.9.8`** via `package.json` `overrides`
- **Service worker** with cache-first strategy for the app shell,
  network-first for everything else. Cross-origin (HF, jsdelivr)
  is explicitly NOT cached to avoid fighting the browser's own cache

## Commit message convention

Every commit message has the form `<type>: <subject>` where `<type>`
is one of:

| Type       | Use for                                                      |
|------------|--------------------------------------------------------------|
| `feat:`    | New user-facing feature                                      |
| `fix:`     | Bug fix                                                      |
| `test:`    | Tests, test infrastructure, CI                               |
| `docs:`    | Documentation only                                           |
| `refactor:`| Code change that doesn't add a feature or fix a bug        |
| `chore:`   | Build, dependencies, tooling                                |
| `perf:`    | Performance improvement                                      |

The subject line is ≤ 72 chars and uses imperative mood
("add X", not "added X"). The body, when present, explains *why*
the change was made; the diff already shows *what*.

## Cutting a release

The full release process lives in this file so the next person
doesn't reinvent it:

```bash
# 1. Bump package.json (semver: 1.2.3 → 1.3.0 for features, → 1.2.4 for fixes)
npm version patch   # or `minor` / `major`

# 2. Push the version tag and the commit
git push --follow-tags

# 3. Create the GitHub release from the tag, with release notes
gh release create vX.Y.Z \
  --title "vX.Y.Z — Short summary" \
  --notes "$(cat <<'EOF'
Notable changes since vA.B.C:

- feat: one-line description (#PR)
- fix: one-line description (#PR)
EOF
)"

# 4. The deploy workflow publishes GitHub Pages automatically once
#    the new tag is pushed. No manual `npm run build` for the page
#    itself.
```

The `package.json` `version` field, the git tag, and the GitHub
release MUST all match. Bumping `package.json` alone (without a tag)
will leave the live demo out of date with the release notes.

## Cross-platform e2e testing

`e2e_test.py` is written against headless Chrome via the DevTools
Protocol. The Linux CI runner ships Chrome pre-installed and uses
`start-chrome.sh` to launch it. On macOS / Windows:

- **macOS:** Install Google Chrome to `/Applications/Google Chrome.app`.
  The harness auto-detects the system Chrome when `--no-sandbox` is
  not needed. Pass `--no-sandbox` if you see "DevToolsActivePort
  not found" — Chrome refuses to attach to a non-default sandbox
  user.
- **Windows (WSL):** Same as macOS but install Chrome on the Windows
  side. From WSL, `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`
  is the canonical path. The start-chrome.sh wrapper will need a
  small WSL-specific adjustment (TBD — see issue #6).
- **Run locally:** `python3 e2e_test.py --headless --no-sandbox` from
  the repo root, with `npm run dev` running in another terminal.

If e2e tests are skipped in CI, the `vitest` unit tests (94+) and
the link-health test still gate the merge.