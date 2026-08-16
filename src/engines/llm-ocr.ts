// ─── LLM-powered OCR via Florence-2 (on-device, WebGPU/WASM) ──────
//
// Uses Microsoft's Florence-2-base-ft vision-language model, running entirely
// in the browser through Transformers.js + ONNX Runtime Web. Unlike
// Tesseract.js (rule-based pattern matching), Florence-2 is a transformer
// neural network that understands visual text structure — it handles complex
// layouts, varied fonts, and handwriting far better than traditional OCR.
//
// Model:  onnx-community/Florence-2-base-ft (~230M params, ~340MB fp32)
// Tasks:  <OCR> (plain text) | <OCR_WITH_REGION> (text + word bounding polygons)
// Speed:  ~2-5s per page on WebGPU, ~10-30s on WASM fallback
//
// All inference is local — no image data ever leaves the browser. The model
// downloads once from Hugging Face and is cached by the browser cache.

import {
  Florence2ForConditionalGeneration,
  AutoProcessor,
  RawImage,
  env,
} from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Florence-2-base-ft';

// Mixed dtype: keep the vision encoder at fp32 for best OCR quality,
// quantize the text decoder to q8 for a smaller download (~200-250MB total
// instead of ~340MB for full fp32). The vision encoder processes the image
// pixels; quantizing it degrades OCR accuracy noticeably.
const MODEL_DTYPE = {
  embed_tokens: 'fp16' as const,
  vision_encoder: 'fp32' as const,
  encoder_model: 'fp16' as const,
  decoder_model_merged: 'q8' as const,
};

// OCR a full page can produce a lot of text. 4096 tokens is generous
// (roughly 3000 words) and covers dense pages without truncation.
const MAX_NEW_TOKENS = 4096;

// ─── Public types ─────────────────────────────────────────────────

export interface LlmOcrProgress {
  status: string;
  /** 0..1 for download progress; -1 for non-progress events */
  progress: number;
}

/** A word-level bounding polygon (4 corners, pixel coordinates). */
export interface LlmOcrWord {
  text: string;
  /** [x1, y1, x2, y2, x3, y3, x4, y4] — 4-corner polygon in pixel coords */
  quad: number[];
}

export interface LlmOcrResult {
  /** Full recognized text. */
  text: string;
  /** Word-level polygons when `includeWords` was requested. */
  words?: LlmOcrWord[];
}

export interface LlmOcrOptions {
  /** Receives progress updates during recognition (per-page status). */
  onProgress?: (p: LlmOcrProgress) => void;
  /** When true, return word-level bounding polygons (uses OCR_WITH_REGION). */
  includeWords?: boolean;
}

// ─── Minimal type narrowing for the Florence-2 model/processor ────
// The published Transformers.js types cover the main surface but the
// Florence-2 processor's construct_prompts / post_process_generation
// methods are not fully typed. We narrow to the shape we actually call.

interface Florence2Processor {
  construct_prompts(text: string | string[]): string[];
  // The actual __call accepts string | string[] | null for text, but the
  // published type says string | null. We widen to unknown to avoid a
  // type mismatch when passing the prompts array from construct_prompts.
  __call(images: RawImage | RawImage[], text: unknown, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>>;
  batch_decode(ids: unknown, options: { skip_special_tokens: boolean }): string[];
  post_process_generation(text: string, task: string, imageSize: { width: number; height: number }): Record<string, unknown>;
  size_per_bin: number;
}

interface Florence2Model {
  generate(options: Record<string, unknown>): Promise<unknown>;
  dispose?(): void;
}

// ─── Engine ───────────────────────────────────────────────────────

/**
 * Thin wrapper around Florence-2 for document OCR.
 * One instance, reused across pages to amortize the model load.
 */
export class LlmOcrEngine {
  private model: Florence2Model | null = null;
  private processor: Florence2Processor | null = null;
  private loading: Promise<void> | null = null;
  private _isLoaded = false;

  get isLoaded(): boolean {
    return this._isLoaded;
  }

  /**
   * Lazily load the Florence-2 model + processor. Idempotent — concurrent
   * callers all await the same load promise. The model is ~200-250MB
   * (mixed dtype) and downloads once, cached by the browser.
   */
  async load(progressCallback?: (loaded: number, total: number) => void): Promise<void> {
    if (this._isLoaded) return;
    if (this.loading) return this.loading;
    this.loading = this._doLoad(progressCallback);
    await this.loading;
  }

  private async _doLoad(progressCallback?: (loaded: number, total: number) => void): Promise<void> {
    // Allow WebGPU when available; ORT-web falls back to WASM automatically.
    // We don't force `env.backends.onnx.wasm.proxy` — the inference runs on
    // the main thread (like SpeechT5/MMS). A worker wrapper could be added
    // later if UI jank during OCR becomes a problem.
    const opts = {
      dtype: MODEL_DTYPE,
      progress_callback: (data: { status: string; loaded?: number; total?: number }) => {
        if (data.status === 'progress' && progressCallback) {
          progressCallback(data.loaded ?? 0, data.total ?? 1);
        } else if (data.status === 'done' && progressCallback) {
          progressCallback(1, 1);
        }
      },
    };

    // Load model and processor in parallel — they hit different files in
    // the same HF repo so the browser can pipeline the requests.
    const [model, processor] = await Promise.all([
      Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, opts) as unknown as Florence2Model,
      AutoProcessor.from_pretrained(MODEL_ID) as unknown as Florence2Processor,
    ]);

    this.model = model;
    this.processor = processor;
    this._isLoaded = true;
  }

  /**
   * OCR an image. Accepts a canvas (from PDF page rendering) or a RawImage.
   * Returns the recognized text, and optionally word-level bounding polygons.
   */
  async recognize(
    image: HTMLCanvasElement | RawImage,
    options: LlmOcrOptions = {},
  ): Promise<LlmOcrResult> {
    await this.load();
    if (!this.model || !this.processor) {
      throw new Error('Florence-2 model failed to initialize');
    }

    // Convert canvas → RawImage if needed.
    let rawImage: RawImage;
    let imageSize: { width: number; height: number };
    if (image instanceof HTMLCanvasElement) {
      const ctx = image.getContext('2d');
      if (!ctx) throw new Error('Cannot get 2D context from canvas');
      const imageData = ctx.getImageData(0, 0, image.width, image.height);
      rawImage = new RawImage(imageData.data, image.width, image.height, 4);
      imageSize = { width: image.width, height: image.height };
    } else {
      rawImage = image;
      imageSize = { width: image.width, height: image.height };
    }

    const task = options.includeWords ? '<OCR_WITH_REGION>' : '<OCR>';
    options.onProgress?.({ status: 'recognizing text', progress: -1 });

    const prompts = this.processor.construct_prompts(task);
    const inputs = await this.processor.__call(rawImage, prompts);
    const generatedIds = await this.model.generate({
      ...inputs,
      max_new_tokens: MAX_NEW_TOKENS,
    });

    const generatedText = this.processor.batch_decode(generatedIds, {
      skip_special_tokens: false,
    })[0];

    const result = this.processor.post_process_generation(generatedText, task, imageSize);
    options.onProgress?.({ status: 'done', progress: 1 });

    if (options.includeWords) {
      const regionResult = result[task] as { labels: string[]; quad_boxes: number[][] };
      const words: LlmOcrWord[] = [];
      const labels = regionResult?.labels ?? [];
      const boxes = regionResult?.quad_boxes ?? [];
      for (let i = 0; i < labels.length && i < boxes.length; i++) {
        words.push({ text: labels[i], quad: boxes[i] });
      }
      // Join labels for the full text — Florence-2 returns individual
      // words/segments, so we join with spaces for a readable text stream.
      const text = labels.join(' ');
      return { text, words };
    }

    const text = (result[task] as string) ?? '';
    return { text };
  }

  /** Free the model from memory. Safe to call multiple times. */
  dispose(): void {
    if (this.model) {
      try {
        this.model.dispose?.();
      } catch {
        // Best-effort — the model may already be gone.
      }
      this.model = null;
    }
    this.processor = null;
    this._isLoaded = false;
    this.loading = null;
  }
}

// ─── Module-level singleton ───────────────────────────────────────
// One engine instance, lazily created on first LLM OCR call. Reusing the
// model amortizes the ~200MB download + init across every page in a doc.

let engine: LlmOcrEngine | null = null;

export function getLlmOcrEngine(): LlmOcrEngine {
  if (!engine) {
    engine = new LlmOcrEngine();
  }
  return engine;
}

export function disposeLlmOcrEngine(): void {
  engine?.dispose();
  engine = null;
}

/**
 * Check whether WebGPU is available. Florence-2 is usable on WASM but
 * painfully slow (~30s/page vs ~3s/page). The UI can use this to warn
 * users before they trigger a long OCR job on CPU-only machines.
 */
export async function isLlmOcrFeasible(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

// Re-export env so callers can configure Transformers.js settings if needed.
export { env };
