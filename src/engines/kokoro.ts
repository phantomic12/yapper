import type { CustomEngine, TTSModel, Voice } from '../engine';
import { webgpuAdapterHasFeature } from '../capability';

// Kokoro-82M — implemented directly on @huggingface/transformers (4.3.0).
//
// HISTORY: this engine used to call kokoro-js. That package pins its own
// nested @huggingface/transformers 3.8.1 + onnxruntime-web 1.22.0-dev, and
// that stack is broken in this app: every inference hung (main thread and
// worker alike; even device:'webgpu' and numThreads:1), which surfaced to
// users as the "Kokoro worker slowdown" — 180s watchdog timeouts on inputs
// that Kitten synthesized in about a second. Every isolated piece of the
// pipeline (ORT session create, tokenizer, phonemizer, voice fetch) was
// verified healthy; only kokoro-js's nested-stack forward pass hung. The
// fix is to run the SAME tiny pipeline on the app's own transformers
// install, whose ORT build is proven working in both threads (Kitten uses
// it today). The pipeline mirrors kokoro-js's KokoroTTS exactly:
//
//   phonemize(sentence)  → normalize phones → tokenize →
//   style = voice.bin row (token count) → {input_ids, style, speed} →
//   StyleTextToSpeech2 → waveform @ 24kHz
//
// Model:  onnx-community/Kokoro-82M-v1.0-ONNX (HF)
// Voices: 28 built-in (af_*, am_*, bf_*, bm_*), 510×256 float32 style bank
// Sample rate: 24000 Hz

// Re-declare just the voice list we care about so the UI shows names
// without loading the model first.
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
// from the selected TTSModel entry so users can opt into fp16 (156MB) from
// the model grid.
const KOKORO_DEFAULT_DTYPE = 'q8';
const KOKORO_SAMPLE_RATE = 24000;

// ─── Minimal shapes for the transformers pieces we use ──────────
// Narrowed structurally (like the rest of this codebase) so we don't depend
// on generics internals of the transformers typings.

interface KokoroProgress {
  status: string;
  loaded?: number;
  total?: number;
}

interface InputIdsHolder {
  input_ids: { dims: number[] };
}

interface KokoroTokenizerLike {
  (text: string, options: { truncation: boolean }): InputIdsHolder;
}

interface KokoroModelLike {
  (inputs: {
    input_ids: unknown;
    style: unknown;
    speed: unknown;
  }): Promise<{ waveform: { data: Float32Array } }>;
  dispose?: () => void;
}

/**
 * Which ONNX file and execution device Kokoro should use on this device.
 *
 * transformers.js resolves a dtype to a file by suffix (verified in both the
 * 3.8.1 build kokoro-js shipped and the 4.3.0 build this engine now uses):
 *
 *   q8    → model_quantized.onnx  int8 weights, **fp32 compute** → no f16
 *   int8  → model_int8.onnx       (not published for Kokoro-82M)
 *   fp16  → model_fp16.onnx       fp16 weights + compute       → needs shader-f16
 *   q4f16 → model_q4f16.onnx      4-bit + f16 compute         → needs shader-f16
 *   fp32  → model.onnx            338MB, no f16
 *
 * Device semantics: in both builds, `device: null` resolves to the WASM
 * execution provider (defaultDevices = ['wasm']) — it does NOT "let ORT
 * prefer WebGPU". When the adapter has `shader-f16` we request WebGPU
 * explicitly (load() retries on WASM if session creation fails); an adapter
 * without `shader-f16` pins WASM, because ORT compiles graph kernels with
 * WGSL f16 storage and every f16 kernel would fail validation there. The
 * genuinely-f16 dtypes are downgraded to the int8 build in that case.
 */
export interface KokoroRuntimeChoice {
  /** dtype string handed to transformers.js. */
  dtype: string;
  /** 'webgpu' forces the GPU path (with a WASM retry in `load()`); null = WASM. */
  device: 'webgpu' | null;
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
  if (hasF16) {
    return { dtype: requested, device: 'webgpu', downgradedForF16: false };
  }
  if (!KOKORO_F16_DTYPES.has(requested)) {
    return { dtype: requested, device: null, downgradedForF16: false };
  }
  return { dtype: KOKORO_DEFAULT_DTYPE, device: null, downgradedForF16: true };
}

// ─── Phonemization ───────────────────────────────────────────────
// Same eSpeak NG WASM wrapper Kitten uses (phonemizer 1.2.1, verified working
// in the inference worker). Dynamic import keeps the ~1.3MB emscripten module
// out of whatever chunk imports this file first (engine.ts pulls KOKORO_VOICES
// for the model registry on the main thread).

type PhonemizeFn = (text: string, lang: string) => Promise<string[]>;

let phonemizeFn: PhonemizeFn | null = null;

async function getPhonemize(): Promise<PhonemizeFn> {
  if (!phonemizeFn) {
    const mod = (await import('phonemizer')) as { phonemize: PhonemizeFn };
    phonemizeFn = mod.phonemize;
  }
  return phonemizeFn;
}

/**
 * Sentence segmentation, approximating kokoro-js's TextSplitterStream: a
 * sentence ends at a run of terminal punctuation (.!?…) optionally followed
 * by closing brackets/quotes, when that run is followed by whitespace or the
 * end of the text — or at a newline. Commas/colons do NOT split (kokoro-js
 * also leaves them mid-sentence), and "3.14"-style decimals survive because
 * a period must be followed by whitespace to count.
 *
 * Deliberately NOT abbreviation-aware ("Dr. Smith" splits) — kokoro-js
 * carries a full abbreviation/URL/quote heuristic that is not worth
 * re-implementing here; the cost is an occasional extra pause, never a
 * wrong or missing sentence.
 */
const SENTENCE_END_RE = /([.!?…]+["'”’)\]]*(?=\s|$)|\n+)/g;

/**
 * Split text into sentence-ish segments for streaming generation.
 *
 * Exported for its unit tests: this is the function that decides what counts
 * as a sentence, which is what drives per-segment progress and word timings
 * in the job card. A regression here does not crash — it quietly merges or
 * shatters sentences — so it is worth pinning directly rather than only
 * through the engine.
 */
export function splitSentences(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END_RE)) {
    const end = match.index! + match[0].length;
    const piece = text.slice(start, end).trim();
    if (piece) segments.push(piece);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) segments.push(rest);
  return segments;
}

/** Kokoro was trained on espeak-ng phones with these post-fixes (kokoro-js). */
function normalizePhones(phones: string, isUSVoice: boolean): string {
  let p = phones
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹoʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“”(){}[\] ]|$)/g, 'z');
  if (isUSVoice) {
    // "ninety" → "ninti" quirk the US-English models were trained with.
    p = p.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  }
  return p.trim();
}

// ─── Voice style bank ────────────────────────────────────────────
// Each voice ships as a .bin of 510 × 256 float32 style vectors, indexed by
// token count. Fetched on first use and cached (browser HTTP cache makes
// repeat loads cheap).

const VOICES_URL_BASE = `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main/voices/`;
const voiceCache = new Map<string, Promise<Float32Array>>();

function loadVoiceData(voiceId: string): Promise<Float32Array> {
  let cached = voiceCache.get(voiceId);
  if (!cached) {
    cached = (async () => {
      const res = await fetch(`${VOICES_URL_BASE}${voiceId}.bin`);
      if (!res.ok) {
        throw new Error(`Kokoro voice fetch returned HTTP ${res.status} for ${voiceId}.bin`);
      }
      const buf = await res.arrayBuffer();
      return new Float32Array(buf);
    })();
    voiceCache.set(voiceId, cached);
  }
  return cached;
}

export class KokoroCustomEngine implements CustomEngine {
  private model: KokoroModelLike | null = null;
  private tokenizer: KokoroTokenizerLike | null = null;
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
      const { env: hfEnv } = await import('@huggingface/transformers');
      // Engine.ts sets wasmPaths for the main thread; the inference worker's
      // module graph does not include engine.ts, so set it here too.
      hfEnv.backends.onnx!.wasm!.wasmPaths = `${import.meta.env.BASE_URL}ort-wasm/`;

      const hasF16 = await webgpuAdapterHasFeature('shader-f16');
      const runtime = chooseKokoroRuntime(_model.dtype, hasF16);
      // from_pretrained creates the ORT session, so this is where a WebGPU
      // failure surfaces (adapter claimed shader-f16 but session init
      // failed, driver reset, …). Rather than failing the whole load we
      // retry once on the WASM provider — slower inference, but it works.
      try {
        await this.loadModel(_model.modelId, runtime, progressCallback);
      } catch (err) {
        if (runtime.device !== 'webgpu') throw err;
        console.warn('[kokoro] WebGPU session creation failed, retrying on WASM:',
          err instanceof Error ? err.message : err);
        await this.loadModel(_model.modelId, { ...runtime, device: null }, progressCallback);
      }
      return { sampleRate: KOKORO_SAMPLE_RATE };
    } finally {
      this.loading = false;
    }
  }

  /** One load attempt: model + tokenizer against a runtime choice. */
  private async loadModel(
    modelId: string,
    runtime: KokoroRuntimeChoice,
    progressCallback?: (loaded: number, total: number) => void,
  ): Promise<void> {
    const { StyleTextToSpeech2Model, AutoTokenizer } = await import('@huggingface/transformers');
    const progress = (data: KokoroProgress) => {
      if (data?.status === 'progress' && progressCallback) {
        progressCallback(data.loaded ?? 0, data.total ?? 1);
      } else if (data?.status === 'done' && progressCallback) {
        progressCallback(1, 1);
      }
    };
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(modelId, {
        // KokoroRuntimeChoice.dtype is a plain string; narrow to the union
        // transformers' typings want (runtime values are always in it).
        dtype: runtime.dtype as 'q8' | 'fp16' | 'q4f16' | 'fp32',
        device: runtime.device ?? undefined,
        progress_callback: progress,
      }) as Promise<KokoroModelLike>,
      AutoTokenizer.from_pretrained(modelId, {
        progress_callback: progress,
      }) as Promise<KokoroTokenizerLike>,
    ]);
    this.model = model;
    this.tokenizer = tokenizer;
  }

  async generate(
    _model: TTSModel,
    voiceId: string | undefined,
    text: string,
    options?: {
      speed?: number;
      /** Receives per-sentence progress while generation runs. */
      onSegmentProgress?: (progress: { segmentsDone: number; audioSecondsSoFar: number }) => void;
    },
  ): Promise<{ audio: Float32Array; samplingRate: number; wordTimings?: number[] }> {
    if (!this.model || !this.tokenizer) throw new Error('Kokoro model not loaded');
    const voice = voiceId ?? 'af_heart';
    const voiceMeta = VOICE_META[voice];
    if (!voiceMeta) throw new Error(`Unknown voice: ${voice}`);
    const speed = options?.speed ?? 1.0;

    const { Tensor } = await import('@huggingface/transformers');
    const phonemize = await getPhonemize();
    const voiceData = await loadVoiceData(voice);

    // Sentence-by-sentence, exactly like kokoro-js's stream(): phonemize →
    // tokenize → pick the style row for the token count → forward pass.
    const wordTimings: number[] = [];
    const chunks: Float32Array[] = [];
    let audioOffsetSamples = 0;

    // Tokenize the full text the same way the sentence splitter does, then
    // walk phoneme-by-phoneme assigning tokens as phonemes accumulate.
    const tokens = text.match(/\S+/g) ?? [text];
    let tokenIdx = 0;

    const segments = splitSentences(text);
    for (const segment of segments) {
      const isUSVoice = voiceMeta.lang === 'en-us';
      const phones = normalizePhones(
        (await phonemize(segment, 'en-us')).join(' '),
        isUSVoice,
      );
      // NOTE: a zero-phoneme segment is still run through the model
      // (BOS/EOS only) so it still yields audio and fires segment progress —
      // parity with the old kokoro-js streaming behavior.

      const { input_ids } = this.tokenizer(phones, { truncation: true });
      // The style bank is row-indexed by token count, offset by the BOS/EOS
      // pair (kokoro-js: 256 * clamp(dims.at(-1) - 2, 0, 509)).
      const seqLen = input_ids.dims[input_ids.dims.length - 1];
      const row = Math.min(Math.max(seqLen - 2, 0), 509);
      const style = voiceData.slice(row * 256, (row + 1) * 256);

      const { waveform } = await this.model({
        input_ids,
        style: new Tensor('float32', style, [1, 256]),
        speed: new Tensor('float32', new Float32Array([speed]), [1]),
      });
      const segAudio = waveform.data;
      chunks.push(segAudio);

      // Accumulate the running audio length and report segment progress
      // BEFORE the word-timing work below — segments that don't map to any
      // remaining token (short inputs, zero-phoneme segments) must still
      // report progress. Report the running count; the UI renders this as
      // "N sentences" (determinate only once a total is known).
      audioOffsetSamples += segAudio.length;
      options?.onSegmentProgress?.({
        segmentsDone: chunks.length,
        audioSecondsSoFar: audioOffsetSamples / KOKORO_SAMPLE_RATE,
      });

      // Approximate: each phoneme = ~1 token boundary; we map phoneme
      // positions onto tokens proportionally. Not perfect (a token may have
      // multiple phonemes, or none for punctuation) but far better than the
      // chunk-level ratio fallback.
      const phonemeCount = phones.length;
      if (phonemeCount === 0 || tokenIdx >= tokens.length) continue;
      const chunkDurationSec = segAudio.length / KOKORO_SAMPLE_RATE;
      const secPerPhoneme = chunkDurationSec / phonemeCount;
      for (let p = 0; p < phonemeCount && tokenIdx < tokens.length; p++) {
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
    if (this.model) {
      // transformers.js 4.x exposes dispose() on PreTrainedModel to release
      // the underlying ORT session; guard anyway in case it disappears.
      try {
        this.model.dispose?.();
      } catch {
        // Best-effort: the session may already be torn down.
      }
      this.model = null;
    }
    this.tokenizer = null;
  }
}
