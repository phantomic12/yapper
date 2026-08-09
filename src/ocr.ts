// ─── OCR via Tesseract.js (runs in a Web Worker, fully local) ─────
//
// All Tesseract assets (worker, WASM core, eng.traineddata) are served from
// /lib/tesseract/ — self-hosted, no CDN at runtime. See public/lib/tesseract/.
//
// Traineddata note: eng.traineddata is ~4MB and is shipped in the repo so the
// first OCR works fully offline. Subsequent runs hit Tesseract's IndexedDB
// cache for the traineddata + WASM, so repeat OCRs are essentially instant.
//
// tesseract.js handles the worker plumbing internally; we only provide
// paths to local files. We expose a tiny `OcrEngine` class that mirrors the
// CustomEngine shape from src/engine.ts: load() + recognize(image).

import { createWorker, type Worker } from 'tesseract.js';

const BASE = `${import.meta.env.BASE_URL}lib/tesseract`.replace(/\/$/, '');

export interface OcrProgress {
  status: string;
  /** 0..1 */
  progress: number;
}

export interface OcrOptions {
  language?: string; // default 'eng'
  /** Receives progress updates during recognition. */
  onProgress?: (p: OcrProgress) => void;
}

/**
 * Thin wrapper around a Tesseract.js worker.
 * One instance per language; reuse across pages to amortize the WASM load.
 */
export class OcrEngine {
  private worker: Worker | null = null;
  private language: string;
  private loading: Promise<void> | null = null;

  constructor(language = 'eng') {
    this.language = language;
  }

  /** Lazily load the WASM core + traineddata. Idempotent. */
  async load(): Promise<void> {
    if (this.worker) return;
    if (this.loading) return this.loading;
    this.loading = this._doLoad();
    await this.loading;
  }

  private async _doLoad(): Promise<void> {
    const w = await createWorker(this.language, 1 /* LSTM only */, {
      workerPath: `${BASE}/worker.min.js`,
      corePath: `${BASE}/core`,
      langPath: `${BASE}/lang`,
      // eng.traineddata in /lang is the raw (un-gzipped) fast LSTM model
      gzip: false,
      // We log nothing — keeps the console clean. Bump to true to debug.
      logger: () => {},
    });
    this.worker = w;
  }

  /** Recognize text in an image. Returns plain text (Tesseract's default). */
  async recognize(image: Blob | HTMLCanvasElement | HTMLImageElement, options: OcrOptions = {}): Promise<string> {
    await this.load();
    if (!this.worker) throw new Error('OCR worker failed to initialize');
    // Forward progress. tesseract.js v5 has no progress callback on recognize,
    // so we emit a single synthetic event for consistency with the docs router.
    options.onProgress?.({ status: 'recognizing text', progress: 0 });
    try {
      const { data } = await this.worker.recognize(image);
      options.onProgress?.({ status: 'done', progress: 1 });
      return data.text;
    } catch (err) {
      options.onProgress?.({ status: 'error', progress: 0 });
      throw err;
    }
  }

  /** Free the WASM heap. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.worker) {
      try { await this.worker.terminate(); } catch { /* ignore */ }
      this.worker = null;
    }
    this.loading = null;
  }
}

// ─── Module-level singleton ─────────────────────────────────────
// One OCR engine per language, lazily created on first OCR call. Reusing the
// worker amortizes the multi-MB WASM init across every page in a doc.
const engines = new Map<string, OcrEngine>();

export function getOcrEngine(language = 'eng'): OcrEngine {
  let e = engines.get(language);
  if (!e) {
    e = new OcrEngine(language);
    engines.set(language, e);
  }
  return e;
}

export async function disposeAllOcrEngines(): Promise<void> {
  for (const e of engines.values()) await e.dispose();
  engines.clear();
}