import { unzipSync, strFromU8 } from 'fflate';
import type { CustomEngine, TTSModel, Voice } from '../engine';

// Kitten TTS Nano via direct onnxruntime-web + manual phonemization.
// This is a separate integration from kokoro-js (which has its own eSpeak WASM
// inlined). The `phonemizer` package is loaded from jsdelivr at runtime.
//
// Model:  KittenML/kitten-tts-nano-0.8-int8 (HF, ~24MB quantized ONNX)
// Voices: 8 built-in (in voices.npz, each shape (400, 256) float32)
// Tokenizer: char→id vocab (phoneme-based), 4.5KB
// Sample rate: 24000 Hz
//
// Note: the npz voices are shape (400, 256) — a bank of 400 style vectors.
// Following the published reference impl, we use the first row (single 256-dim
// vector) for the `style` input. Better TTS would index into the bank by frame,
// but that requires more API surface than this v1 supports.

const MODEL_URL = 'https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/resolve/main/kitten_tts_nano_v0_8.onnx';
const VOICES_URL = 'https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/resolve/main/voices.npz';
// Tokenizer (phoneme vocab) is mirrored from the original demo's bundled
// file (balas-world/kitten-tts-web-demo). Served from /lib/ at runtime —
// no external repo dependency, fully self-contained.
const TOKENIZER_URL = `${import.meta.env.BASE_URL}lib/kitten-tokenizer.json`;
// Phonemizer: eSpeak NG WASM wrapped by xenova/phonemizer.js. Loaded from CDN
// at runtime (jsdelivr's field in their package.json points to this file).
const PHONEMIZER_URL = 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js';
const SAMPLE_RATE = 24000;

interface VoiceEntry {
  id: string;
  name: string;
  gender: 'Male' | 'Female';
}

const VOICE_META: VoiceEntry[] = [
  { id: 'expr-voice-2-m', name: 'Voice 2 (Male)',   gender: 'Male'   },
  { id: 'expr-voice-2-f', name: 'Voice 2 (Female)', gender: 'Female' },
  { id: 'expr-voice-3-m', name: 'Voice 3 (Male)',   gender: 'Male'   },
  { id: 'expr-voice-3-f', name: 'Voice 3 (Female)', gender: 'Female' },
  { id: 'expr-voice-4-m', name: 'Voice 4 (Male)',   gender: 'Male'   },
  { id: 'expr-voice-4-f', name: 'Voice 4 (Female)', gender: 'Female' },
  { id: 'expr-voice-5-m', name: 'Voice 5 (Male)',   gender: 'Male'   },
  { id: 'expr-voice-5-f', name: 'Voice 5 (Female)', gender: 'Female' },
];

export const KITTEN_VOICES: Voice[] = VOICE_META.map(v => ({
  id: v.id,
  name: v.name,
  description: `${v.gender} voice (Kitten TTS Nano v0.8)`,
}));

// ─── Minimal .npy / .npz parser ─────────────────────────────────
// Format reference: https://numpy.org/doc/stable/reference/generated/numpy.lib.format.html
// We only need float32 2D arrays (the shape of voice embeddings).

interface NpyArray {
  shape: number[];
  data: Float32Array;
}

function parseNpy(buffer: ArrayBuffer): NpyArray {
  const view = new DataView(buffer);
  // Magic: \x93NUMPY (6 bytes: 93 4E 55 4D 50 59)
  if (view.getUint8(0) !== 0x93 || view.getUint8(1) !== 0x4E ||
      view.getUint8(2) !== 0x55 || view.getUint8(3) !== 0x4D ||
      view.getUint8(4) !== 0x50 || view.getUint8(5) !== 0x59) {
    throw new Error('Not a .npy file (bad magic)');
  }
  // Version: major at byte 6
  const major = view.getUint8(6);
  if (major !== 1 && major !== 2 && major !== 3) {
    throw new Error(`Unsupported .npy version: ${major}`);
  }
  // Header length: 2 bytes at offset 8-9 (v1) or 4 bytes at offset 12-15 (v2/v3)
  const headerOffset = major === 1 ? 10 : 14;
  const headerLen = major === 1
    ? view.getUint16(8, true)
    : view.getUint32(12, true);
  const headerBytes = new Uint8Array(buffer, headerOffset, headerLen);
  const header = strFromU8(headerBytes);

  // Parse dict for {'descr': '<f4', 'fortran_order': False, 'shape': (400, 256), }
  const descrMatch = header.match(/'descr'\s*:\s*'([^']+)'/);
  const shapeMatch = header.match(/\(\s*((?:\d+,\s*)*\d+)?\s*\)/);
  if (!descrMatch || descrMatch[1] !== '<f4') {
    throw new Error(`Only float32 (<f4) .npy supported, got: ${descrMatch?.[1]}`);
  }
  const shapeStr = shapeMatch?.[1] ?? '';
  const shape = shapeStr.trim() === '' ? [1] : shapeStr.split(',').map(s => parseInt(s.trim(), 10));
  const dataOffset = headerOffset + headerLen;
  // For non-fortran, data is row-major
  const data = new Float32Array(buffer, dataOffset);
  return { shape, data };
}

function parseNpz(buffer: ArrayBuffer): Record<string, Float32Array> {
  // Use fflate's unzipSync for the .npz (which is a zip of .npy files)
  const files = unzipSync(new Uint8Array(buffer));
  const result: Record<string, Float32Array> = {};
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith('.npy')) continue;
    const key = name.replace(/\.npy$/, '');
    // Copy into a standalone ArrayBuffer (floating a slice may give misaligned data)
    const ab = new ArrayBuffer(content.byteLength);
    new Uint8Array(ab).set(content);
    const { shape, data } = parseNpy(ab);
    if (shape.length === 2) {
      // Flatten to a single Float32Array (row-major). For Kitten, each voice is
      // (400, 256); we only use the first 256-dim row at generation time.
      result[key] = data;
    } else {
      result[key] = data;
    }
  }
  return result;
}

// ─── Tokenizer ───────────────────────────────────────────────────

interface TokenizerData {
  vocab: Record<string, number>;
  vocabArray: string[];
}

async function loadTokenizer(): Promise<TokenizerData> {
  const res = await fetch(TOKENIZER_URL);
  if (!res.ok) throw new Error(`Failed to fetch tokenizer: ${res.status}`);
  const json = await res.json();
  const vocab: Record<string, number> = json.model.vocab;
  const vocabArray: string[] = [];
  for (const [char, id] of Object.entries(vocab)) {
    vocabArray[id] = char;
  }
  return { vocab, vocabArray };
}

// ─── Phonemizer (lazy + CDN-loaded) ──────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let phonemizerModule: any = null;

async function getPhonemize(): Promise<(text: string, lang: string) => Promise<string>> {
  if (!phonemizerModule) {
    // Dynamic import from CDN. The /* @vite-ignore */ comment stops Vite from
    // trying to resolve this URL at build time. The eSpeak WASM is bundled
    // inside the phonemizer.js file (it sets up its own worker internally).
    phonemizerModule = await import(/* @vite-ignore */ PHONEMIZER_URL);
  }
  return phonemizerModule.phonemize;
}

// ─── Engine ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ortModule: any = null;

async function getOrt() {
  if (!ortModule) {
    ortModule = await import('onnxruntime-web');
    // Web Worker proxy is intentionally NOT enabled. With Vite's bundling,
    // the proxy worker can't find the WASM (Vite emits the WASM with a content
    // hash; `wasmPaths` doesn't help because the worker fetches from the same
    // path as the main script, which is content-hashed). Result was
    // "no available backend found". Inference runs on the main thread —
    // generation blocks the page for the duration, but the queue still
    // accepts new jobs (each is just blocked behind the current one).
    // TODO: implement proper off-thread inference via a Vite `?worker` import.
  }
  return ortModule;
}

export class KittenCustomEngine implements CustomEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private voices: Record<string, Float32Array> = {};
  private tokenizer: TokenizerData | null = null;
  private sampleRate = SAMPLE_RATE;

  async load(_model: TTSModel, progressCallback?: (loaded: number, total: number) => void): Promise<{ sampleRate: number }> {
    const ort = await getOrt();

    // Load all assets in parallel
    const [modelBuf, voicesBuf, tokenizer] = await Promise.all([
      fetch(MODEL_URL).then(async r => {
        if (!r.ok) throw new Error(`Model fetch failed: ${r.status}`);
        const total = Number(r.headers.get('content-length') ?? 0);
        const reader = r.body!.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (progressCallback && total) progressCallback(received, total);
        }
        const out = new Uint8Array(received);
        let pos = 0;
        for (const c of chunks) { out.set(c, pos); pos += c.length; }
        return out.buffer;
      }),
      fetch(VOICES_URL).then(r => {
        if (!r.ok) throw new Error(`Voices fetch failed: ${r.status}`);
        return r.arrayBuffer();
      }),
      loadTokenizer(),
    ]);

    // Parse voices
    this.voices = parseNpz(voicesBuf);
    this.tokenizer = tokenizer;

    // Create ONNX session
    this.session = await ort.InferenceSession.create(modelBuf, {
      executionProviders: ['wasm'],
      // Graph optimization can change numerics for some models; 'basic' is safer
      graphOptimizationLevel: 'basic',
    });

    return { sampleRate: this.sampleRate };
  }

  async generate(_model: TTSModel, voiceId: string | undefined, text: string, options?: { speed?: number }): Promise<{ audio: Float32Array; samplingRate: number }> {
    if (!this.session || !this.tokenizer) {
      throw new Error('Kitten model not loaded');
    }
    const phonemize = await getPhonemize();
    const voice = voiceId ?? 'expr-voice-2-m';
    const speed = options?.speed ?? 1.0;
    const voiceArr = this.voices[voice];
    if (!voiceArr) throw new Error(`Unknown voice: ${voice}`);
    // The voice array is shape (400, 256) in row-major. We use the first
    // 256-dim frame as the style vector (matches the reference demo).
    const voiceVec = voiceArr.slice(0, 256);

    // Phonemize → wrap with $ boundaries → tokenize
    const phonemes = await phonemize(text, 'en-us');
    const tokensWithBoundaries = `$${phonemes}$`;
    const inputIds = tokensWithBoundaries.split('').map((ch: string) => {
      const id = this.tokenizer!.vocab[ch];
      if (id === undefined) {
        console.warn(`[kitten] unknown phoneme char: "${ch}", using 0`);
        return 0;
      }
      return id;
    });
    const inputIdsBig = BigInt64Array.from(inputIds.map((id: number) => BigInt(id)));

    const ort = await getOrt();
    const inputs = {
      input_ids: new ort.Tensor('int64', inputIdsBig, [1, inputIdsBig.length]),
      style: new ort.Tensor('float32', voiceVec, [1, 256]),
      speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
    };

    const result = await this.session.run(inputs);
    const waveform = result.waveform?.data ?? result.audio?.data;
    if (!waveform) throw new Error('Kitten inference: no waveform in output');

    // Clean up NaNs (WebGPU/quantized occasionally produces them)
    const cleaned = new Float32Array(waveform.length);
    let maxAmp = 0;
    for (let i = 0; i < waveform.length; i++) {
      const v = isNaN(waveform[i]) ? 0 : waveform[i];
      cleaned[i] = v;
      const a = Math.abs(v);
      if (a > maxAmp) maxAmp = a;
    }
    // Normalize if too quiet
    if (maxAmp > 0 && maxAmp < 0.1) {
      const scale = 0.5 / maxAmp;
      for (let i = 0; i < cleaned.length; i++) cleaned[i] *= scale;
    }

    return { audio: cleaned, samplingRate: this.sampleRate };
  }

  dispose(): void {
    if (this.session) {
      try { this.session.release(); } catch {}
      this.session = null;
    }
    this.voices = {};
    this.tokenizer = null;
  }
}
