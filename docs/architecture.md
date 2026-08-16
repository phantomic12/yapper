# Architecture (one screen)

Yapper is a browser-only TTS SPA. Vite builds a static `dist/` for GitHub Pages; inference never leaves the tab.

```
┌─────────────┐     enqueue / events      ┌──────────────────────────────┐
│  main.ts    │ ─────────────────────────▶│  engine.ts  (TTSEngine)       │
│  UI + queue │                           │  MODELS, queue, WAV, speed   │
└──────┬──────┘                           └──────────────┬───────────────┘
       │                                                 │
       │ extractDocument                                 │ CustomEngine?
       ▼                                                 ▼
┌──────────────────┐                     ┌───────────────────────────────┐
│ document-reader  │                     │ engines/                      │
│ PDF/DOCX/ODT/…   │                     │  WorkerBackedEngine ────────┐ │
│ optional PDF OCR │                     │  kokoro.ts / kitten.ts      │ │
└────────┬─────────┘                     │  inference-worker.ts ◀──────┘ │
         │                               └───────────────────────────────┘
         ▼
┌──────────────────┐
│ reader.ts        │  DocumentReaderSession, chunks, highlight timing
└──────────────────┘
```

**Model routing**

- Kokoro + Kitten: `registerCustomEngine(modelId, new WorkerBackedEngine())` in `main.ts`. Worker speaks a small request/response protocol from `worker-bridge.ts`.
- SpeechT5 + MMS-TTS: Transformers.js pipeline inside `TTSEngine` (main thread).

**Documents**

- Ingestion: `document-reader.ts` (`extractDocument`).
- Playback UX: `reader.ts` (`DocumentReaderSession`, `prepareReaderData`).
- Types/helpers without heavy deps: `document-types.ts` (includes `OcrMode`, `quadToBbox`, `stripRtfControlWords`, `parseCsv`).
- Supported formats: PDF, DOCX, DOC, ODT, RTF, EPUB, XLSX, PPTX, CSV, HTML, TXT, MD.
- OCR (Tesseract): `ocr.ts` (`OcrEngine`, self-hosted Tesseract paths under `public/lib/tesseract/`) — fast, rule-based, ~4MB WASM. Good for clean printed text.
- OCR (LLM): `engines/llm-ocr.ts` (`LlmOcrEngine`, Florence-2 via Transformers.js) — slower, ~200MB download, but much better for complex layouts, varied fonts, and handwriting. Uses `<OCR_WITH_REGION>` task for word-level bounding polygons.
- OCR mode is selected per-document via the UI (`ocrMode` in `AppState`); `document-reader.ts` dispatches to the appropriate engine in `ocrPage()`.

**Events**

Prefer `engine.on('jobDone' | …)` from `events.ts`. Mutating a legacy callback bag is deprecated (see CONTRIBUTING).

**PWA**

`public/sw.js` caches the app shell only — not HF model weights.
