# Yapper 🔊

**Privacy-first text-to-speech that runs entirely in your browser.**

No cloud processing. No data sent anywhere. Models load once, then everything runs locally on your device via WebGPU (or WASM fallback).

## Features

- **100% local inference** — text never leaves your browser
- **WebGPU acceleration** — GPU-accelerated when available, WASM fallback otherwise
- **Multiple models** — SpeechT5, MMS-TTS (English, Spanish, French, German, Japanese, Chinese)
- **Models from Hugging Face** — zero hosting burden, loaded on demand
- **WAV download** — save generated audio as standard WAV files
- **Dark mode UI** — minimal, fast, no frameworks

## Tech Stack

- [Transformers.js](https://huggingface.co/docs/transformers.js) — Hugging Face models in the browser
- [ONNX Runtime Web](https://onnxruntime.ai) — WebGPU/WASM inference backend
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

## Deploy

Pushes to `main` auto-deploy to GitHub Pages via GitHub Actions.

## Privacy

- All text-to-speech inference runs **entirely in your browser**
- Model files are downloaded from [Hugging Face](https://huggingface.co) (public CDN) and cached locally
- **No analytics, no tracking, no server-side processing**
- Your text inputs never leave your device

## License

MIT
