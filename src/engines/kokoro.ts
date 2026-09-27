import type { CustomEngine, TTSModel, Voice } from '../engine';
import { webgpuAdapterHasFeature } from '../capability';

// Kokoro-82M via the official kokoro-js package (xenova).
// Browser-friendly: kokoro-js bundles eSpeak NG WASM and onnxruntime-web.
// Voice .bin files are loaded from HF at runtime, cached in the browser cache.
//
// Model:  onnx-community/Kokoro-82M-v1.0-ONNX (HF)
// Voices: 28 built-in, see kokoro-js's KokoroTTS.voices
//   af_* = American female (af_heart, af_bella, af_nicole, ...)
//   am_* = American male   (am_adam, am_michael, am_eric, ...)
//   bf_* = British female  (bf_emma, bf_isabella, ...)
//   bm_* = British male    (bm_george, bm_daniel, ...)
// Sample rate: 24000 Hz

// Re-declare just the voice list we care about (full list is in kokoro-js).
// We hardcode names + categories so the UI shows them without loading the model first.
const VOICE_META: Record<string, { name: string; lang: string; gender: 'Female' | 'Male' }> = {
  af_heart:    { name: 'Heart',     lang: 'en-us', gender: 'Female' },
  af_bella:    { name: 'Bella',     lang: 'en-us', gender: 'Female' },
  af_nicole:   { name: 'Nicole',    lang: 'en-us', gender: 'Female' },
  af_aoede:    { name: 'Aoede',     lang: 'en-us', gender: 'Female' },
  af_kore:     { name: 'Kore',      lang: 'en-us', gender: 'Female' },
  af_sarah:    { name: 'Sarah',     lang: 'en-us', gender: 'Female' },
  af_nova:     { name: 'Nova',      lang: 'en-us', gender: 'Female' },
  af_sky:      { name: 'Sky',       lang: 'en-us', gender: 'Female' },
  af_alloy:    { name: 'Alloy',     lang: 'en-us', gender: 'Female' },
  af_jessica:  { name: 'Jessica',   lang: 'en-us', gender: 'Female' },
  af_river:    { name: 'River',     lang: 'en-us', gender: 'Female' },
  am_adam:     { name: 'Adam',      lang: 'en-us', gender: 'Male'   },
  am_michael:  { name: 'Michael',   lang: 'en-us', gender: 'Male'   },
  am_eric:     { name: 'Eric',      lang: 'en-us', gender: 'Male'   },
  am_liam:     { name: 'Liam',      lang: 'en-us', gender: 'Male'   },
  am_onyx:     { name: 'Onyx',      lang: 'en-us', gender: 'Male'   },
  am_echo:     { name: 'Echo',      lang: 'en-us', gender: 'Male'   },
  am_fenrir:   { name: 'Fenrir',    lang: 'en-us', gender: 'Male'   },
  am_puck:     { name: 'Puck',      lang: 'en-us', gender: 'Male'   },
  am_santa:    { name: 'Santa',     lang: 'en-us', gender: 'Male'   },
  bf_emma:     { name: 'Emma',      lang: 'en-gb', gender: 'Female' },
  bf_isabella: { name: 'Isabella',  lang: 'en-gb', gender: 'Female' },
  bf_alice:    { name: 'Alice',     lang: 'en-gb', gender: 'Female' },
  bf_lily:     { name: 'Lily',      lang: 'en-gb', gender: 'Female' },
  bm_george:   { name: 'George',    lang: 'en-gb', gender: 'Male'   },
  bm_lewis:    { name: 'Lewis',     lang: 'en-gb', gender: 'Male'   },
  bm_daniel:   { name: 'Daniel',    lang: 'en-gb', gender: 'Male'   },
  bm_fable:    { name: 'Fable',     lang: 'en-gb', gender: 'Male'   },
};

export const KOKORO_VOICES: Voice[] = Object.entries(VOICE_META).map(([id, meta]) => ({
  id,
  name: `${meta.name} (${meta.lang}, ${meta.gender})`,
}));

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// Default to q8 for the smallest download (~86MB). The actual dtype is taken
// from the selected TTSModel entry so users can opt into fp16 (163MB) from the
// model grid.
const KOKORO_DEFAULT_DTYPE = 'q8';
const KOKORO_SAMPLE_RATE = 24000;

// Minimal KokoroTTS type — the kokoro-js package's .d.ts covers the main
// surface but not the dynamic-import path we use. Narrowing to the methods
// we actually call keeps ESLint happy without adding a second type package.
interface KokoroProgress {
  status: string;
  loaded?: number;
  total?: number;
}
interface KokoroTTSLike {
  generate(text: string, options: { voice: string; speed: number }): Promise<{
    audio: Float32Array;
    sampling_rate?: number;
  }>;
  /**
   * Streaming variant. kokoro-js yields `{text, phonemes, audio}` per
   * sentence. We use it for per-word timing extraction when the caller
   * needs high-fidelity highlighting (the document reader).
   */
  stream(text: string, options: { voice: string; speed: number }): AsyncIterable<{
    text: string;
    phonemes: string;
    audio: { audio: Float32Array; sampling_rate?: number };
  }>;
}
interface KokoroModule {
  KokoroTTS: {
    from_pretrained(
      modelId: string,
      options: {
        dtype: string;
        device?: 'wasm' | 'webgpu' | 'cpu' | null;
        progress_callback?: (data: KokoroProgress) => void;
      },
    ): Promise<KokoroTTSLike>;
  };
  /**
   * `env.wasmPaths` is a live accessor onto the onnxruntime-web instance that
   * Kokoro sessions are actually created with — not a plain data property.
   */
  env: { wasmPaths?: string };
}

/**
 * Which ONNX file and execution provider Kokoro should use on this device.
 *
 * transformers.js resolves a dtype to a file by suffix (verified in the
 * bundled @huggingface/transformers 3.8.1 that kokoro-js ships):
 *
 *   q8    → model_quantized.onnx  int8 weights, **fp32 compute** → no f16
 *   int8  → model_int8.onnx       (not published for Kokoro-82M)
 *   fp16  → model_fp16.onnx       fp16 weights + compute       → needs shader-f16
 *   q4f16 → model_q4f16.onnx      4-bit + f16 compute         → needs shader-f16
 *   fp32  → model.onnx            338MB, no f16
 *
 * The important one is the default: the q8 Kokoro card downloads
 * `model_quantized.onnx`, which is int8-weighted but computes in fp32. It has
 * no f16 anywhere, so it runs on WebGPU just fine. An earlier version of this
 * engine assumed the q8 file was `model_q8f16.onnx` and pinned the WASM
 * execution provider whenever the adapter lacked `shader-f16` — sending a
 * perfectly GPU-capable model to the CPU, where a 44-character sentence took
 * ~74s and longer input hit the 180s watchdog. Only the explicit fp16 and
 * q4f16 graphs genuinely need the f16 feature, and on a device without it
 * they are downgraded to the q8 file rather than dropped to the CPU.
 */
export interface KokoroRuntimeChoice {
  /** dtype string handed to kokoro-js. */
  dtype: string;
  /** Execution-provider override; null lets ORT prefer WebGPU. */
  device: 'wasm' | null;
  /** True when an f16 graph was swapped for its fp32-compute equivalent. */
  downgradedForF16: boolean;
}

/** dtypes whose graphs contain f16 math and so need the `shader-f16` feature. */
const KOKORO_F16_DTYPES = new Set(['fp16', 'q4f16']);

export function chooseKokoroRuntime(
  requestedDtype: string | undefined,
  hasF16: boolean,
): KokoroRuntimeChoice {
  const requested = requestedDtype ?? KOKORO_DEFAULT_DTYPE;
  if (hasF16 || !KOKORO_F16_DTYPES.has(requested)) {
    return { dtype: requested, device: null, downgradedForF16: false };
  }
  return { dtype: KOKORO_DEFAULT_DTYPE, device: null, downgradedForF16: true };
}

export class KokoroCustomEngine implements CustomEngine {
  private tts: KokoroTTSLike | null = null;
  private loading = false;

  static async create(model: TTSModel, progressCallback?: (loaded: number, total: number) => void): Promise<KokoroCustomEngine> {
    const engine = new KokoroCustomEngine();
    await engine.load(model, progressCallback);
    return engine;
  }

  async load(_model: TTSModel, progressCallback?: (loaded: number, total: number) => void): Promise<{ sampleRate: number }> {
    if (this.loading) throw new Error('Already loading');
    this.loading = true;
    try {
      // Dynamic import: kokoro-js is large and the .web.js bundle inlines
      // onnxruntime-web + eSpeak WASM. We lazy-load it on first use.
      const mod = (await import('kokoro-js')) as unknown as KokoroModule;
      const KokoroTTS = mod.KokoroTTS;

      // Point Kokoro's own onnxruntime-web at the locally-copied WASM.
      //
      // kokoro-js bundles its own copy of @huggingface/transformers (3.8.1),
      // which resolves to its own onnxruntime-web instance, so the
      // `env.backends.onnx.wasm.wasmPaths` that src/engine.ts sets for the
      // app's top-level transformers does NOT reach the environment that
      // Kokoro sessions are created in. Unconfigured, transformers falls back
      // to the jsdelivr CDN — which the app's CSP (script-src 'self') blocks —
      // so every Kokoro load failed with "no available backend found", on a
      // cold cache and on a warm one. mod.env.wasmPaths is a live accessor
      // onto that nested ORT env; setting it is the supported way to hand
      // Kokoro the same WASM build the rest of the app already ships under
      // /ort-wasm/ (populated by the copy-ort-wasm Vite plugin).
      if (mod.env) {
        mod.env.wasmPaths = `${import.meta.env.BASE_URL}ort-wasm/`;
      }

      // The first call also downloads voices; track via progress callback.
      // KokoroTTS.from_pretrained takes {dtype, device, progress_callback} —
      // it picks the matching onnx file from the repo (e.g. dtype 'fp16'
      // resolves to `onnx/model_fp16.onnx`). We pass the user-selected dtype
      // from the TTSModel entry so the fp16 Kokoro card actually downloads
      // the fp16 file (~163MB) instead of silently falling back to q8.
      //
      // On adapters without `shader-f16` those f16 graphs cannot run at all,
      // so the dtype is swapped for its fp32-compute equivalent — which keeps
      // the model on the GPU rather than dropping it onto the CPU. See
      // chooseKokoroRuntime for the suffix mapping and the measurements.
      const hasF16 = await webgpuAdapterHasFeature('shader-f16');
      const runtime = chooseKokoroRuntime(_model.dtype, hasF16);
      this.tts = await KokoroTTS.from_pretrained(_model.modelId, {
        dtype: runtime.dtype,
        device: runtime.device,
        progress_callback: (data) => {
          if (data?.status === 'progress' && progressCallback) {
            progressCallback(data.loaded ?? 0, data.total ?? 1);
          } else if (data?.status === 'done' && progressCallback) {
            progressCallback(1, 1);
          }
        },
      });
      return { sampleRate: KOKORO_SAMPLE_RATE };
    } finally {
      this.loading = false;
    }
  }

  async generate(
    _model: TTSModel,
    voiceId: string | undefined,
    text: string,
    options?: {
      speed?: number;
      /** Receives per-sentence progress while the stream is running. */
      onSegmentProgress?: (progress: { segmentsDone: number; audioSecondsSoFar: number }) => void;
    },
  ): Promise<{ audio: Float32Array; samplingRate: number; wordTimings?: number[] }> {
    if (!this.tts) throw new Error('Kokoro model not loaded');
    const voice = voiceId ?? 'af_heart';
    const speed = options?.speed ?? 1.0;

    // Use the streaming API so we can compute per-word start times from
    // kokoro-js's phoneme durations. Each yielded segment carries the
    // sentence's phonemes and audio; we stitch audio into one Float32Array
    // and map each whitespace-token in the original text to its start time.
    const wordTimings: number[] = [];
    const chunks: Float32Array[] = [];
    let audioOffsetSamples = 0;

    // Tokenize the full text the same way the sentence splitter does, then
    // walk phoneme-by-phoneme assigning tokens as phonemes accumulate.
    const tokens = text.match(/\S+/g) ?? [text];
    let tokenIdx = 0;

    for await (const segment of this.tts.stream(text, { voice, speed })) {
      const segAudio = segment.audio.audio;
      chunks.push(segAudio);
      // Accumulate the running audio length and report segment progress
      // BEFORE the word-timing work below — segments that don't map to any
      // remaining token (short inputs, zero-phoneme segments) must still
      // report progress. kokoro-js streams sentence-by-sentence without a
      // known total, so we report the running count; the UI renders this
      // as "N sentences" (determinate only once a total is known).
      audioOffsetSamples += segAudio.length;
      options?.onSegmentProgress?.({
        segmentsDone: chunks.length,
        audioSecondsSoFar: audioOffsetSamples / KOKORO_SAMPLE_RATE,
      });

      // Approximate: each phoneme = ~1 token boundary; we map phoneme positions
      // onto tokens proportionally. This isn't perfect (a token may have
      // multiple phonemes, or none for punctuation) but it's far better than
      // the chunk-level ratio we used before.
      const phonemes = segment.phonemes.replace(/\s+/g, '');
      const phonemeCount = phonemes.length;
      if (phonemeCount === 0 || tokenIdx >= tokens.length) continue;

      // Distribute the chunk's duration across its phonemes, then assign
      // tokens to the phoneme boundaries that fall within the chunk.
      const chunkDurationSec = segAudio.length / KOKORO_SAMPLE_RATE;
      const secPerPhoneme = chunkDurationSec / phonemeCount;
      for (let p = 0; p < phonemeCount && tokenIdx < tokens.length; p++) {
        // We push one timing per TOKEN (not per phoneme) — group consecutive
        // phonemes until tokenIdx advances. This is heuristic but close enough
        // for highlighting; the boundary case where a token straddles two
        // segments is fine because timing is monotonic across the audio.
        const t = (audioOffsetSamples / KOKORO_SAMPLE_RATE) + p * secPerPhoneme;
        wordTimings.push(t);
        tokenIdx++;
      }
    }

    // Stitch the per-sentence audio into one array.
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const audio = new Float32Array(totalLength);
    let pos = 0;
    for (const c of chunks) {
      audio.set(c, pos);
      pos += c.length;
    }

    return {
      audio,
      samplingRate: KOKORO_SAMPLE_RATE,
      wordTimings,
    };
  }

  dispose(): void {
    if (this.tts) {
      // kokoro-js doesn't expose a public dispose, but we can null our ref
      // and let the GC clean up the WASM-bound objects.
      this.tts = null;
    }
  }
}
