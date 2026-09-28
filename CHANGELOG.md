# Changelog

All notable changes to Yapper are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Kokoro no longer hangs — the "worker slowdown" is fixed at the root.**
  The engine used to call the `kokoro-js` package, which pins its own nested
  `@huggingface/transformers` 3.8.1 + onnxruntime-web 1.22.0-dev, and that
  stack's forward pass never returned in this app: main thread or worker,
  WebGPU or WASM, every generation stalled until the 180s watchdog killed the
  job. Every piece was verified healthy in isolation (ORT session create,
  tokenizer, phonemizer, voice fetch) — only kokoro-js's model call hung.
  `src/engines/kokoro.ts` now builds the same tiny pipeline directly on the
  app's own `@huggingface/transformers` 4.3.0 (the ORT build Kitten already
  uses in the worker): phonemize sentence → tokenize → style-vector row for
  the token count → StyleTextToSpeech2 → 24 kHz waveform, with per-sentence
  progress and word timings preserved. Measured on the machine that saw the
  stalls: a sentence loads in ~1.4s and generates 2.6s of audio in ~4.3s,
  end to end through the inference worker. `kokoro-js` is dropped from
  dependencies (`phonemizer` is now declared directly).
- **Kokoro device selection no longer assumes `device: null` means WebGPU.**
  In transformers 3.8.1 (and 4.3.0), `device: null` resolves to the WASM
  execution provider — the previous "null lets ORT prefer WebGPU" comment was
  wrong, and the previous never-pin-WebGPU choice silently CPU-bound every
  session. When the adapter has `shader-f16` the GPU is now requested
  explicitly, with an automatic WASM retry if session creation fails; without
  `shader-f16` WASM stays pinned (`chooseKokoroRuntime`).
- **SpeechT5 removed from the model picker.** The card looked functional but
  could only produce noise: SpeechT5 is a text→mel model, and a usable card
  needs the processor plus a HiFi-GAN vocoder that transformers.js does not
  assemble for this checkpoint (documented in `docs/tts-model-landscape.md`).
  Models can now carry a `hidden` flag, exposed to the picker via
  `visibleModels()`; hidden entries still resolve by id so persisted settings
  and historical job records keep working.
- **The OCR mode choice persists across reloads — and its radio buttons now
  show it.** `yapper.settings.v1` gained an `ocrMode` field (validated on
  read), and the mode selector's radios are synced from restored state at
  bind time; previously a saved "LLM" choice rendered visually as tesseract
  while state still held `llm`.
- **The headless e2e suite is safe to run on the developer's own Windows
  machine and passes end to end (all 23 steps).** The old runner was
  Linux-only and its cleanup would have killed the user's desktop Chrome;
  `scripts/run_e2e_windows.sh` launches its own isolated headless Chrome
  (temp profile, debug port 9223, dedicated dev port 5179) and kills only
  the browser it started — discovered via the real Windows PID of the debug
  socket, because Git Bash's `$!` is a bash job PID and killing that orphaned
  Chrome (which then poisoned later runs through a stale CDP port). It also
  refuses to run against an already-occupied CDP port instead of testing a
  ghost. `e2e_test.py` got two robustness fixes: the render step polls for
  the app to mount instead of a fixed 2s sleep (a cold profile can pay
  seconds of Vite transforms), and the Kokoro step no longer demands a
  click on the load button that auto-load turned into a status pill.
  `scripts/cleanup-e2e-profiles.ps1` recovers locked temp profiles from runs
  interrupted before their EXIT trap fired. Three bugs in that runner surfaced
  while extending the suite, all of which made a run fail as a blank page
  rather than as an error: it exported `YAPPER_URL` *before* the
  `[ -z "$YAPPER_URL" ]` test that decides whether to boot a dev server, so
  that branch was dead code and Chrome was pointed at a dead port; it probed
  `127.0.0.1` while Vite's default `localhost` binds the IPv6 loopback only on
  this machine, so the readiness check timed out against a healthy server (now
  pinned with `--host 127.0.0.1`); and it reaped the leftover Vite child with
  `pkill -f`, which Git Bash on Windows does not have, so every run left the
  port occupied and the next one refused to start. Vite is now reaped by the
  PID holding the port, the same way Chrome already was.

- **The unit suite no longer depends on jsdom's object-URL internals**, which
  unblocks the jsdom 30.1 bump (Renovate PR #60). jsdom's
  `URL.createObjectURL` goes through Vitest's `makeCompatBlob`, which locates
  jsdom's internal blob impl by reading the *first own symbol* off a `Blob`.
  jsdom 30.1 moved that impl out of a symbol and into a private `#impl` class
  field, so a Blob has no own symbols, the lookup is `undefined`, and every
  call throws `Cannot read properties of undefined (reading '_buffer')`. The
  throw lands in the job loop immediately after a clip is synthesised — at
  `URL.createObjectURL(next.blob)` — so a perfectly good generation became a
  job error and 14 tests failed. Upstream as vitest-dev/vitest#11336; the
  suite now hands out deterministic `blob:` URLs from `src/test-setup.ts`
  instead, which is all the app ever promised (a finished job carries a usable
  URL). Verified green on both jsdom 30.0.1 and 30.1.1.

### Added
- **Every voice is auditionable before you download anything.** 44 recorded
  clips (Kokoro's 28, Kitten Nano's 8, Kitten Mini's 8) are committed under
  `public/voice-samples/` — 1.2 MB of 24 kHz mono MP3, served by the same
  Pages deploy as the app. Until now the "Hear it" buttons were dead until a
  model finished downloading (`TTSEngine.preview()` throws without one, and
  `updateVoicePreviewAvailability` blocked every button with "load the model
  first"), which made the one genuinely human decision in the app — which
  voice do I like? — the only decision you could not make first. A voice with
  a recording is now live whatever the engine is doing, and a voice without
  one still falls back to live synthesis, so adding a voice to a registry
  without re-recording degrades to "slower" rather than "broken".
  The clips are not hand-made: `scripts/generate_voice_samples.py` drives the
  app's own audition path in a headless browser and records what comes out, so
  a sample and a live synthesis are the same audio by construction rather than
  by a test that hopes they match. It needs no app support — the capture hooks
  `URL.createObjectURL` over CDP — and `?live-previews=1` forces real
  synthesis so a re-run cannot regenerate the samples from themselves.
  The manifest is keyed by **(model id, voice id)**, not voice id alone:
  `KITTEN_VOICES` is one shared constant, so `kitten-mini` and `kitten-nano`
  expose the same eight voice ids while conditioning on different embeddings.
  Keyed by voice alone, Mini would quietly play Nano's audio — a valid file,
  no error anywhere, and a user concluding that Mini sounds bad. The
  generated `src/voice-samples.data.ts` also pins the upstream revision each
  clip came from and an FNV-1a hash of `PREVIEW_TEXT`, and
  `src/voice-samples.test.ts` fails if either drifts from the app or if a
  referenced file is not actually committed, so 44 opaque binaries cannot
  quietly go stale. `kokoro-82m-fp16` borrows the int8 recordings (same repo,
  same 28 style vectors, only the dtype differs); the manifest records the
  alias and the advanced view says "recorded from Kokoro-82M" on the card
  rather than passing borrowed audio off as its own. Apache-2.0 covers both
  models; `public/voice-samples/PROVENANCE.md` carries the attribution those
  licences require, and Kokoro's synthetic training data means no real
  person's voice is reproduced.

### Changed
- **Vitest 5 and jsdom 30.1.1 are in; TypeScript 7 is deliberately not.**
  Renovate's grouped major bump could not land as written: its artifact step
  had failed, so the PR carried a `package.json` with no matching lockfile
  and `npm ci` refused to install — the red run was never a test failure.
  With the lockfile actually regenerated, the three majors split cleanly.
  Vitest 5.0.2 and `@vitest/ui` 5.0.2 pass the suite unchanged (459 tests, no
  test or config edits). TypeScript 7.0.2 typechecks the whole project clean
  on its own, but `typescript-eslint` refuses to load against it — its peer
  range is `>=4.8.4 <6.1.0`, so no version of the linter accepts it and this
  is not a config problem. Held at `^6.0.0`, and `renovate.json` now pins
  TypeScript to `6.0.x` so the bot stops proposing a bump that cannot pass.
  Revisit when the linter catches up.
- **The simple view no longer shows download sizes.** Somebody who opened a
  text-to-speech site to hear a sentence read back does not need to know that
  the "High" preset is a 156MB download, and every place a figure leaked into
  the short path is now behind the More toggle: the quality presets read
  "Fastest / Natural voices / Best fidelity" with the size in a
  `data-advanced` chip, model names are just names ("Kokoro-82M" rather than
  "Kokoro-82M (int8)" and "Kitten TTS Nano" rather than "Kitten TTS Nano
  (~24MB)"), and the live download line shows a percentage to everyone and
  megabytes to the advanced view. Nothing was deleted — the size ladder is one
  toggle away, and the preset tooltips were cleaned of it too, since a hover
  is still the simple view.
- **A new `data-simple` mark, the mirror of `data-advanced`.** Some copy
  belongs only to the short path, and it needed a way to say so that the
  stylesheet can act on. The fp16-fallback warning is the case in point: it
  stays visible in both views — it is true regardless of mode — but the
  simple view is told the consequence in the preset row's own words ("High
  quality runs the standard one instead") while the mechanism, model names and
  byte counts wait one click away. Both marks are attributes in the markup,
  so flipping the toggle is a repaint and never a re-render.
- **A regression guard for the rule, in two places.** The unit suite walks
  the mounted markup and fails if any size figure appears outside a
  `data-advanced` subtree; the e2e suite does the same against live computed
  styles, so a region the stylesheet failed to hide is caught there too. The
  one deliberate exception is the 25MB document upload cap, pinned by its own
  test: that is a limit to respect before choosing a file, not a description
  of what the app is downloading.
- **`e2e_test.py` accepts `YAPPER_E2E_ONLY`** to run just the matching steps
  (the three bootstrap steps always run), so a single area can be re-checked
  without sitting through the real model downloads. It matches shell-style
  patterns rather than substrings — with a substring filter, `mode` also
  matched `select_model` — and a pattern that matches nothing is reported as
  a typo instead of cheerfully "passing" the three bootstrap steps.
- **`scripts/run_e2e.sh` no longer kills the developer's own dev server.** Its
  startup `pkill -f "vite"` matched any Vite on any port; it now reaps only
  the process holding the run's own port and refuses to continue if something
  else is squatting on 5173, which is the same contract the Windows runner
  already had. Its cleanup reaped Vite with `pkill -f "vite --port 5173"`, a
  string that appears in no real command line (it is `node …/vite.js --port
  5173 …`), so the server survived every run and the next one refused to
  start.
- **`splitSentences` is now covered directly** (10 tests in
  `src/engines/kokoro.test.ts`). It decides where a sentence ends, which is
  what the per-segment progress and word timings in the job card are built
  on, so a regression there would not throw — it would quietly shatter
  "3.14" into two segments. Decimals, closing quotes/brackets, newlines,
  ellipses, an unterminated trailing fragment, and the deliberately
  not-abbreviation-aware behaviour are all now pinned.

### Added
- **No more "Download & Load Model" step — Speak just works**: picking  a quality preset, a model, or a voice now pulls the model down automatically
  in the background, and the text box, Speak and Play are usable from the
  first paint. Type and press Speak while the model is still downloading and
  the job queues and runs the moment the bytes land (the engine drains its
  queue on ready). The old full-width download button is now a quiet
  status/retry pill ("Downloading…" → "✓ ready" → "Retry download"); it still
  works as a manual reload but is never required. Play streams the same way —
  press it early and it loads, then starts.
- **Quality presets (Low / Medium / High)**: the default view chooses a model
  with one of three words instead of a wall of cards. Each preset is a *real*
  model, so the control stays honest rather than a placebo slider — Low is
  Kitten TTS Nano (fastest), Medium is Kokoro-82M int8 (where the natural
  voices live), High is Kokoro-82M fp16 (best fidelity, auto-falling back to
  int8 on GPUs without `shader-f16`). Their download sizes are shown in the
  advanced view, not here. The presets are a
  view over model selection, not a second source of truth: pick an off-ladder
  model (an MMS language model) in the advanced grid and no preset lights up
  while the bar reads "Custom". (`src/quality-presets.ts`.)
- **A bottom bar for the settings that don't belong on the short path**:
  theme and the "More" toggle live on a fixed bar at the foot of the page,
  which also carries a live readout of the selected model and quality preset.
  "More" reveals every advanced region inline and flips to "Less" while they
  are showing, so the dev controls are one unobtrusive tap away without
  sitting in the header.
- **A simple view, with the knobs one toggle away**: the app opens on the
  short path — quality presets, its voices, the
  text box and the two buttons — and the thirteen-card model grid, the
  language filter, the speed slider, the storage-budget line, the download /
  clear controls and the GPU status row sit behind the bottom bar's "More"
  toggle. Switching models is one click on a preset (or the full grid one
  tap away in "More"), so it is never a hunt for a settings toggle. Like the theme, the whole thing is one
  attribute on `<html>` (`src/advanced-mode.ts`) and the stylesheet hides
  every `[data-advanced]` region, so the CSS and the JS cannot disagree
  about what counts as advanced. The choice persists, and an inline `<head>`
  script applies it before first paint so the grid does not flash into view.
  Warnings are deliberately *not* behind the toggle: if the selected model
  runs on the main thread, or an fp16 model quietly resolved to int8, that
  is true in either view, and hiding it would trade a cluttered screen for a
  surprised one.
- **Light and dark themes**: a header control cycles Auto (follow the OS) →
  the opposite of the current appearance → the other explicit theme, and the
  choice persists across reloads. The palette was already entirely custom
  properties, so the switch is one attribute on `<html>`; a small inline
  script in `<head>` applies the stored theme before first paint so nobody
  gets a white flash on a dark page (or vice versa). The classified-block
  colours get darker equivalents in light mode — the pastel set was tuned for
  a near-black surface and falls under 3:1 on white.
- **Honest half-precision notice**: when the WebGPU adapter exists but lacks
  the `shader-f16` feature, the model panel now says so and explains that fp16
  cards (Kokoro-82M fp16) quietly resolve to the 88MB int8 build instead of the
  156MB fp16 one. `detectAcceleration()` in `src/capability.ts` collapses the
  capability class and the f16 probe into the one question the UI needs, and
  reports the "adapter works but can't run our kernels" case that the
  three-class banner cannot express.
- **Streaming playback**: a Play button and stream bar that start reading
  the text box out loud, sentence by sentence, while synthesis is still
  running. Audio is scheduled in overlapping parts (`src/ui/stream-player.ts`)
  with a two-part lookahead, so speech starts after the first chunk instead of
  waiting for the whole document. Pause/Stop and a "speaking sentence" readout
  are available throughout.
- **Karaoke word highlighting in the stream bar**: the "now speaking" line
  marks the individual word being read instead of reprinting the whole sentence
  every timeupdate. `splitAtWord` (`src/karaoke.ts`) cuts the sentence into
  before/active/after parts that always rejoin to the original text, so only
  the emphasis changes; a word that cannot be located falls back to the plain
  sentence rather than a blank line. Measured in the browser with Kitten Nano:
  17 repaints for 17 words, versus ~865 before the change — the reader session
  reports the active word on every audio `timeupdate`, so the repaint is gated
  on the word actually changing.
- **Persistence across reloads**: model, voice, speed, draft text, and language
  filter are saved to `localStorage`, and the generation history (with playable
  audio) is stored in IndexedDB under `yapper` / `jobs`
  (`src/persistence.ts`). Jobs that were mid-generation when the tab closed come
  back as pending rather than stuck. Writes are debounced and flushed on
  `pagehide`.
- **Download all as one file**: every finished clip is concatenated oldest-first
  into a single WAV audiobook (`src/audio-export.ts`, 0.35s gaps, resampled to
  the highest clip rate so mixed-rate histories don't sound pitch-shifted).
- **Two-page UI with a Document Reader**: the app is now split into Studio
  (models, voice, text, queue) and Reader (upload, OCR, extraction), with
  hash-routed pill tabs (`src/ui/page-nav.ts`). Includes a visual refresh —
  ambient gradient background, gradient hero text, page-transition animation,
  and hover lift on primary actions.
- **Structure-aware rendering for classified blocks**: the Reader page was
  rendering every classified block as one flat run of escaped text, which threw
  away the structure the classifier had just worked out. Tables now render as
  real tables (parsed from either markdown pipes or the column-aligned spacing
  extraction produces), code as a whitespace-preserving `<pre>` with its fence
  stripped, lists as `<li>` items without doubled bullet glyphs, quotes as
  `<blockquote>`, headings as headings. Rows, columns and text length are all
  capped, and the caps say how much was hidden — a one-column "table" falls back
  to a paragraph rather than rendering a pointless grid.
- **A sample document on the Reader page**: "No document handy? Read a sample"
  under the drop zone loads a built-in passage (`src/sample-document.ts`)
  through the real extraction, classification and reader pipeline, so a
  first-time visitor can see what the Reader does without going to find a
  PDF. The sample is deliberately shaped to exercise every block kind the
  classifier knows — heading, paragraph, list, quote, table — and a test
  fails if one of them stops being recognised.
- **Document structure classification**: extracted text is split into blocks and
  labelled heading / paragraph / list / quote / code / table, using both text
  heuristics and PDF layout geometry (`src/document-classify.ts`). The Reader
  page shows a count chip per kind and a card per block, each with its own
  Speak button. PDF heading detection uses the block's width and position
  relative to the widest block on the page.
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
  (multi-sentence input shows segment markers) steps in `e2e_test.py`, plus
  three reader steps: `load_sample_document` (the sample fills the panel with
  classified blocks and a real table), `pause_resume_reader` (Pause holds the
  highlight still and Resume brings it back — the label transition is the only
  signal the app gives, and a single reading would pass even with audio still
  playing), and `upload_scanned_pdf_ocr` (OCR toggle on, an image-only PDF
  fixture, and per-line layout blocks — the path that was silently returning
  nothing). The scanned fixture is generated by
  `e2e/fixtures/make_scanned_pdf.py`. All 21 steps pass.

### Fixed
- **No PDF would load on Chrome 128–139**: pdfjs-dist 6.3 calls several ES2025
  built-ins without a feature check — `Uint8Array.prototype.toHex` in the
  document-fingerprint path, `Map/Set.prototype.getOrInsertComputed` in its
  message tables — all of which postdate the engine floor this app advertises.
  On those versions every PDF import died with `hashOriginal.toHex is not a
  function`, an error that names nothing the user can act on, so the reader's
  headline format was simply unavailable. `src/pdfjs-engine-shim.js` defines
  them when missing (and only then, so current engines keep the native
  implementations); it is imported by the main thread and prepended to the
  pdfjs worker bundle, which has its own global scope and cannot inherit a
  main-thread patch.  `Promise.try` is deliberately *not* shimmed — that one is the
  documented engine gate. Verified on Chrome 130, where the same import
  previously threw.
- **The build shipped a pdfjs worker without the engine shim** (and, on a
  checkout that skipped `postinstall`, no worker at all): `vite.config.ts` and
  `scripts/copy-pdf-worker.mjs` were two copies of the same plain
  `copyFileSync`, and the build ran last. Both now call one exported
  `syncPdfWorker()`, and the Vite half moved from `closeBundle` to
  `buildStart` so the files land in `public/` before Vite copies it to `dist/`.
- **OCR returned zero characters for every scanned PDF**: tesseract.js returns
  its geometry as blocks → paragraphs → lines → words, and `data.words` — the
  flat array `src/ocr.ts` read — does not exist in this version (nor in the
  library's own typings). Recognition worked perfectly and the reader then
  grouped no words into no lines, producing a 0-character document with no
  error anywhere: the OCR toggle appeared to do nothing. The hierarchy is now
  walked, and text-without-words raises a named error instead of returning an
  empty result. The unit test had mocked the v4 shape, which is how this
  survived; it now mocks the real one.
- **Pause then Resume left the reader stuck**: `resumeAfterGesture()` only
  resumed when autoplay had been blocked, so pressing Pause and then Resume
  did nothing at all — the button said Resume, the click was inert, and Stop
  was the only way out. Being inside a user gesture is a property of the
  *caller*, not a precondition on the state, so it now resumes from any
  paused state and stays a no-op only while already playing.
- **Quoted blocks showed their ">" markers**: the block renderer strips the
  bullet from list items (which otherwise showed a doubled glyph) but passed a
  blockquote's `>` straight through, so a quotation in a real document rendered
  as a line of angle brackets. Every line's marker is now dropped, the same way
  the list branch does it.
- **Kokoro could not load at all**: kokoro-js bundles its own copy of
  `@huggingface/transformers` (3.8.1) and its own `onnxruntime-web` instance, so
  the `wasmPaths` that `src/engine.ts` configures for the app's top-level
  transformers never reached the environment that Kokoro sessions are actually
  created in. Unconfigured, transformers falls back to the jsdelivr CDN, which
  the app's CSP (`script-src 'self'`) blocks, so every Kokoro load failed with
  "no available backend found" — verified on a fresh page through the real UI.
  `src/engines/kokoro.ts` now sets `env.wasmPaths` (a live accessor onto that
  nested ORT env) to the same locally-copied runtime the rest of the app uses.
  Kokoro now loads in ~2s and generates normally.
- **ORT's WASM runtime was unresolvable in `npm run dev`**: as of Vite 8, the dev
  server refuses to serve anything under `public/` as an ES module ("This file
  is in /public ... should not be imported from source code"), so ORT's dynamic
  `import()` of `/ort-wasm/ort-wasm-simd-threaded.jsep.mjs` returned a 500 and
  every model that needs the WASM runtime failed locally. Production is
  unaffected — the file is emitted into `dist/` and imported normally. A dev-only
  middleware now streams those files straight off disk, matching the build
  output exactly.
- **Kokoro was demoted to the CPU for no reason**: the engine assumed the
  `q8` Kokoro card downloads `model_q8f16.onnx` and pinned the WASM execution
  provider on adapters without `shader-f16`. It does not — transformers.js maps
  `q8` to the `_quantized` suffix, i.e. `model_quantized.onnx`, which is int8
  weights with **fp32** compute and no f16 anywhere. The card was therefore GPU
  capable and being sent to the CPU regardless. The WASM pin is gone (ORT picks
  its own provider now), only the genuinely f16 graphs (`fp16`, `q4f16`) get
  substituted with the int8 build, and those substitutions stay on the GPU.
  Measured on an f16-less adapter, a 44-character sentence takes 4.8s on WASM
  and 5.4s on WebGPU — normal for this model, and the reason no "your CPU is too
  slow" warning ships: the slowness it would have warned about was not real.
- **The model registry described files it never downloaded**: the Kokoro cards
  claimed `model_q8f16.onnx` and a 156/163MB fp16 download. Corrected to the
  files transformers.js actually resolves (`model_quantized.onnx` at 88MB,
  `model_fp16.onnx` at 156MB), with a test that pins both.
- **The service worker is no longer registered in development**: its
  cache-first app-shell strategy kept serving the module graph it saw first, so
  edited source could look unchanged in the browser for minutes — which read as
  a broken build and sent this investigation down the wrong path twice.
  Registration moved from an inline script in `index.html` to `src/main.ts`
  behind `import.meta.env.PROD`.

- **Kitten output was garbled**: the bundled `voices.npz` style bank is indexed
  by *token count*, not by voice, and the engine was always reading row 0 —
  producing a ~1.35s burst of noise with a peak near 20 instead of speech. The
  row is now selected by the clip's token count, per-voice `speed_priors` are
  read from the model's `config.json` and multiplied into the user's speed
  setting, and 5000 samples of trailing decoder artifact are trimmed. Typical
  sentence now renders in ~3s at peak 0.77 with natural prosody.
- **Queue ran newest-first**: `processQueue` picked the first *pending* job in
  insertion order, which meant the most recently added item jumped the queue.
  Scheduling is now FIFO, and the "Nth in queue" labels were recounted to match
  (the list is rendered newest-first, so positions were being counted backwards).
- **Clipped/over-modulated audio**: a `limitPeaks` stage now scales a clip only
  when it is genuinely over-modulated, clamping isolated spikes (under 1% over)
  instead of attenuating the whole waveform.
- **Console storm and wrong audio on f16-less GPUs**: ORT's WebGPU kernels for
  these models are generated with WGSL `f16` storage. Adapters without the
  `shader-f16` feature failed WGSL validation on every kernel and produced bad
  audio. The execution provider is now pinned to WASM when the adapter lacks
  `shader-f16` (`webgpuAdapterHasFeature` in `src/capability.ts`).
- **Short utterances were silenced entirely**: Kitten trimmed a fixed 5000
  samples of trailing decoder artifact, which both reference implementations
  also do — but they assume the decoder always emits at least that much speech
  first. It doesn't for the fragments people actually type: "One." decodes to
  ~4800 samples, so `length - 5000` floored at zero and the clip was a 44-byte
  WAV header with no audio in it. The trim is now capped at a quarter of the
  clip, so sentences still lose the artifact while short ones survive. Found by
  noticing that the new storage footer reported 88 B for two finished clips.
- **Persisted audio grew without bound**: every clip was written to IndexedDB
  forever, so a long-running session would eventually hit the origin quota —
  and the writes that fail first are the newest ones, i.e. exactly the clip
  the user just generated. The store is now trimmed to a budget (24 clips /
  64MB) keeping the newest audio, a `QuotaExceededError` retries once with a
  halved budget, and the queue footer says how much is actually kept so drops
  are never silent.
- **A 26px phantom sliver** rendered under the queue whenever the queue count was
  zero, because the stylesheet's `display: flex` beat the `hidden` attribute.
  `hidden` is now forced globally.
- **Silent PDF extraction failures**: on engines without `Promise.try`
  (Chrome < ~128), pdfjs 6's worker protocol hangs instead of rejecting —
  every extraction died as an unhandled rejection while the document panel
  stuck on "Reading PDF file…" forever. Three legs to the fix: a fail-fast
  capability gate (`src/pdf-capability.ts`) that raises an actionable error
  naming the minimum browser versions before extraction starts; a 30s
  progress-stall watchdog (`withProgressWatchdog`) that converts any hung
  extraction (corrupt file, wedged worker) into a real rejection, kept
  alive by normal progress events; and a persistent inline error state in
  the reader panel (`#reader-error`, `.reader-error`) so the failure is
  visible where the user is looking, not only in the transient top banner.
  Verified live against Chrome 124 via CDP: corrupt/unsupported PDFs now
  surface both messages immediately.

- **Kitten models failed to load on subpath deploys**: `publicLibUrl()`
  climbed three directory levels from the worker module URL, overshooting
  the app root whenever Yapper is served under a subpath (GitHub Pages
  serves `/yapper/`), so the tokenizer fetch hit `<origin>/lib/…` and 404'd.
  Found by the v0.2.0 release spot-check on the live site. Production
  workers now climb one level (`<deploy-root>/assets/` → deploy root) and
  dev-server modules two, independent of deploy depth; full e2e re-run
  green against dist served under a `/yapper/` subpath.


### Changed
- **The network link check only ran when you asked for it**: `npm test` probed
  every HuggingFace model URL on each run, so a DNS hiccup or a rate-limited
  runner could fail the suite for a reason that has nothing to do with the
  change under test — and it cost 1.3s of every run. The network half of
  `src/links.test.ts` is now opt-in via `YAPPER_LINK_CHECK`, which
  `npm run test:links` sets through a dedicated `vitest.links.config.ts`
  instead of the `YAPPER_LINK_CHECK=1 vitest ...` shell prefix (POSIX syntax
  that cmd.exe reads as a program name, so the command never worked on
  Windows). CI already runs the check as its own step, so it still gates every
  push; the default run drops from 1.3s to 2ms and can no longer go red on a
  network blip.
- **The e2e suite could not get through the two-page layout**: the document
  flow moved to the Reader tab, but the harness went straight for
  `#read-document-btn` while that page was still `hidden`. `DOM.getBoxModel`
  returns nothing for a hidden node, so the step died on "could not measure
  ... position". Added `switch_to_reader` / `switch_to_studio` steps that
  activate the real tab (exercising the hash routing the app ships) and wait
  for the panel to become visible.
- **Trusted clicks could miss controls below the fold**: the harness measures a
  button and clicks those coordinates without scrolling, so on the tall Reader
  page the click landed elsewhere and the step timed out waiting for a state
  change the click never caused. Clicks now go through a shared
  `_click_trusted` helper that scrolls the control into view, re-measures, then
  clicks. This was masking the reader flow as broken when it works.
- **The e2e harness could not report failures on Windows**: step markers are
  ✓ / ✗ / ❌, and a cp1252 console raises `UnicodeEncodeError` while printing
  the *first* failure — so the run died with a traceback instead of a result.
  stdout/stderr are now reconfigured to UTF-8 on startup.

### Documentation
- **`docs/tts-model-landscape.md`**: which TTS models can run in a browser at
  all, and why. transformers.js's supported-architecture list is a hard
  ceiling — Dia, F5-TTS, Fish Speech, Qwen3-TTS and friends are not reachable
  here without hand-writing an ONNX pipeline per model — so Kokoro is
  effectively the quality ceiling for a browser TTS app today. The note also
  records the two candidates that looked viable and were not:
  Kokoro-82M-v1.1-zh (adds Mandarin, but kokoro-js has no Chinese G2P, so it
  would load and produce garbage) and Supertonic-TTS-2 (5 languages, but no
  quantized build at all — 262MB of fp32 for a browser download). Nothing was
  added to the registry; the one real gap is Chatterbox's zero-shot voice
  cloning, which is supported and has ONNX exports.
- **`docs/threaded-wasm.md`**: why cross-origin isolation is not enabled by
  default. COOP + COEP is the standard lever for ORT's thread pool, but
  measured here it made things worse — the inference worker's ORT init failed
  outright and the main thread stalled past two minutes, against a 2s load and
  4.8s generation without the headers (`hardwareConcurrency` is 24 on the test
  machine, so the default thread pool oversubscribes). The doc records the
  measurements, how to cap `numThreads` before trying it, the host requirements
  (GitHub Pages cannot set response headers at all), and what else to re-check
  under `require-corp`.

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
- **Hang watchdog** (`src/engines/timeouts.ts`, `src/engines/worker-bridge.ts`,
  `src/engine.ts`): no request to the inference layer can hang anymore. A
  hung WebGPU / ONNX Runtime call fires no error event, so every worker
  request now carries a per-type wall-clock bound (load 300s, generate
  180s, dispose 10s) and rejects with a typed `TimeoutError` carrying
  `elapsedMs` + engine kind. On expiry the wedged worker is terminated and
  respawned lazily via the existing factory — with a silent model reload —
  so the next generation starts on a clean GPU/ORT context.
- **Cancel-mid-generation recovery**: cancelling the active job now rejects
  its in-flight request immediately and disposes the custom engine session
  instead of awaiting an unkillable straggler; the queue accepts new work
  right away (next session is recreated lazily).
- **Main-thread generation watchdog**: SpeechT5/MMS `pipe()` calls are
  wrapped in a race against the same generate bound, so transformers.js
  cannot wedge the queue either. Timed-out jobs surface "Generation timed
  out after Ns. Try shorter text or reload the model."
### Fixed
- **Queue stalls**: `TTSEngine.processQueue` converts watchdog timeouts into
  job errors and continues with the next job; previously a single hung
  inference call left every later job queued forever behind it.
- **docs/architecture.md** — one-screen map of `engine`, `engines/`  (including `WorkerBackedEngine`), `document-reader`, `reader`, and
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