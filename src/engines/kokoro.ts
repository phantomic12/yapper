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
// q8 keeps the model ~86MB. fp32 is 325MB and overkill for browser TTS.
const KOKORO_DTYPE = 'q8';
const KOKORO_SAMPLE_RATE = 24000;

export class KokoroCustomEngine implements CustomEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tts: any = null;
  private loading = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const mod = await import('kokoro-js');
      const KokoroTTS = (mod as any).KokoroTTS;

      // The first call also downloads voices; track via progress callback.
      this.tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: KOKORO_DTYPE,
        progress_callback: (data: any) => {
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

  async generate(_model: TTSModel, voiceId: string | undefined, text: string): Promise<{ audio: Float32Array; samplingRate: number }> {
    if (!this.tts) throw new Error('Kokoro model not loaded');
    const voice = voiceId ?? 'af_heart';
    // The kokoro-js API returns a `RawAudio` (audio Float32Array + sampling_rate).
    const result = await this.tts.generate(text, { voice, speed: 1.0 });
    return {
      audio: result.audio as Float32Array,
      samplingRate: (result as any).sampling_rate ?? KOKORO_SAMPLE_RATE,
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
