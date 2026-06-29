# Yapper 🔊

**Privacy-first text-to-speech that runs entirely in your browser.**

No cloud processing. No data sent anywhere. Models load once, then everything runs locally on your device via WebGPU (or WASM fallback).

## Features

- **100% local inference** — text never leaves your browser
- **WebGPU acceleration** — GPU-accelerated when available, WASM fallback otherwise
- **Multiple models** — Kokoro-82M, Kitten TTS Nano and more
- **Non-blocking queue** — stack up multiple generations, page stays usable
- **Voice selection** — pick from built-in voices per model
- **Document reader** — upload PDF, DOCX, ODT, EPUB, TXT or Markdown and listen in real time
- **Experimental layout OCR** — render scanned/image-based PDF pages and reconstruct reading order from detected text blocks
- **Keyboard accessible controls** — arrow-key navigation, skip links, focus indicators and ARIA live regions
- **Models from Hugging Face** — zero hosting burden, loaded on demand
- **WAV download** — save generated audio as standard WAV files
- **Dark mode UI** — minimal, fast, no frameworks

## Supported document formats

| Format | Reader support | Notes |
|--------|----------------|-------|
| PDF    | text + OCR     | Text layer extracted first; toggle OCR for scanned/layout pages |
| DOCX   | text           | Extracted with `mammoth` |
| ODT    | text           | Zipped XML text extraction |
| EPUB   | text           | HTML spine text extraction |
| TXT    | text           | Plain UTF-8 |
| MD     | text           | Markdown markup stripped |

## Tech Stack

- [Transformers.js](https://huggingface.co/docs/transformers.js) — Hugging Face models in the browser
- [ONNX Runtime Web](https://onnxruntime.ai) — WebGPU/WASM inference backend
- [pdfjs-dist](https://github.com/mozilla/pdf.js), [mammoth](https://github.com/mwilliamson/mammoth.js), [epubjs](https://github.com/futurepress/epub.js/), [jszip](https://github.com/Stuk/jszip) — document parsing
- [tesseract.js](https://github.com/naptha/tesseract.js/) — client-side OCR
- [Vite](https://vitejs.dev) — build tooling
- TypeScript, vanilla CSS — no framework overhead

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
# Output in dist/
```

## Privacy

- All text-to-speech inference, document parsing and OCR run **entirely in your browser**
- Model files and OCR training data are downloaded from public CDNs and cached locally
- **No analytics, no tracking, no server-side processing**
- Your text inputs and uploaded files never leave your device

## License

MIT
