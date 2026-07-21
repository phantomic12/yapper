# Changelog

All notable changes to Yapper are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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

### Changed
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

### Fixed
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

### Security
- **All 4 `npm audit` vulnerabilities resolved.** Pinned
  `@xmldom/xmldom@^0.9.8` via `package.json` `overrides`; `tar` and
  `protobufjs` updated via `npm audit fix`. `npm audit` now reports
  zero vulnerabilities.

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