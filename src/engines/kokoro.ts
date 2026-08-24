import type { CustomEngine, TTSModel, Voice } from '../engine';

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
        progress_callback?: (data: KokoroProgress) => void;
      },
    ): Promise<KokoroTTSLike>;
  };
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

      // The first call also downloads voices; track via progress callback.
      // KokoroTTS.from_pretrained takes {dtype, device, progress_callback} —
      // it picks the matching onnx file from the repo (e.g. dtype 'fp16'
      // resolves to `onnx/model_fp16.onnx`). We pass the user-selected dtype
      // from the TTSModel entry so the fp16 Kokoro card actually downloads
      // the fp16 file (~163MB) instead of silently falling back to q8.
      const dtype = _model.dtype ?? KOKORO_DEFAULT_DTYPE;
      this.tts = await KokoroTTS.from_pretrained(_model.modelId, {
        dtype,
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
