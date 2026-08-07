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
- Types/helpers without heavy deps: `document-types.ts`.
- Alternate / WIP path: `docs.ts` + `ocr.ts` (self-hosted Tesseract paths under `public/lib/tesseract/`) — not wired from `main.ts` today.

**Events**

Prefer `engine.on('jobDone' | …)` from `events.ts`. Mutating a legacy callback bag is deprecated (see CONTRIBUTING).

**PWA**

`public/sw.js` caches the app shell only — not HF model weights.
