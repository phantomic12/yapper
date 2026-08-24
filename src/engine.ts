import { pipeline, env } from '@huggingface/transformers';
import { EventEmitter } from './events';
import { detectCapability } from './capability';
import { startGenerationFeedback, stopGenerationFeedback } from './dom-utils';
import { KITTEN_VOICES } from './engines/kitten';
import { KOKORO_VOICES } from './engines/kokoro';
import { REQUEST_TIMEOUTS, TimeoutError, formatGenerateTimeout } from './engines/timeouts';

// ─── Model definitions ───────────────────────────────────────────

/** Human-readable language code → ISO 639-1 code. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ru: 'Russian',
  ko: 'Korean',
  hi: 'Hindi',
  ar: 'Arabic',
};

/**
 * Languages actually present in the MODELS registry, with `en` pinned first
 * (most users want English) and any other language codes that ship models
 * sorted alphabetically after. Single source of truth for the UI language
 * filter in src/main.ts and the regression test in src/links.test.ts.
 */
export function getSupportedLanguages(): string[] {
  const seen = new Set<string>();
  for (const m of MODELS) {
    if (m.language && m.language !== 'multi') seen.add(m.language);
  }
  // Enforce order: en first, then alphabetical.
  const others = [...seen].filter(l => l !== 'en').sort();
  return seen.has('en') ? ['en', ...others] : others;
}

export interface Voice {
  id: string;
  name: string;
  description?: string;
  /** Speaker embedding URL/path (SpeechT5) or voice ID string (Kokoro, etc.) */
  speakerEmbeddings?: string;
}

export interface TTSModel {
  id: string;
  name: string;
  modelId: string;
  description: string;
  category: 'fast' | 'balanced' | 'multilingual' | 'premium';
  /**
   * v3 data type passed to the pipeline. SpeechT5 MUST use 'fp32' — the
   * quantized variant produces garbled audio (see huggingface/transformers.js#406).
   * MMS-TTS uses 'q8' by default for smaller downloads with acceptable quality.
   */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  /** Sampling rate of the model's output audio (Hz). */
  sampleRate?: number;
  /** Available voices for this model. Empty/omitted = single fixed voice. */
  voices?: Voice[];
  /** Default voice id when none selected. */
  defaultVoiceId?: string;
  /**
   * If true, this model is implemented outside of transformers.js (custom ONNX
   * integration). The engine routes jobs for these models to a custom
   * integration registered via `registerCustomEngine`.
   */
  custom?: boolean;
  /** ISO 639-1 language code (e.g. 'en', 'es', 'zh') or 'multi' for multilingual models. */
  language?: string;
  /** Approximate download size in MB — shown on the model card. */
  sizeMB?: number;
  /**
   * Path within the HF repo to the model file. Required for custom
   * models (Kokoro picks which ONNX variant to use; Kitten picks
   * between nano/mini/micro). Defaults to the repo's standard file.
   */
  modelFile?: string;
  /**
   * True when inference for this model runs on the MAIN thread via
   * Transformers.js (SpeechT5, MMS-TTS). Long generations freeze the UI
   * while they synthesize — the UI shows a warning when such a model is
   * selected, and the queue shows a liveness indicator while generating.
   * Custom worker-backed models (Kokoro, Kitten) leave this unset.
   */
  runsOnMainThread?: boolean;
}

export const MODELS: TTSModel[] = [
  {
    id: 'kokoro-82m',
    name: 'Kokoro-82M (q8f16)',
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    modelFile: 'onnx/model_q8f16.onnx',
    description: 'High-quality 82M TTS. 28 built-in voices. q8f16 quantized (~86MB).',
    category: 'premium',
    sampleRate: 24000,
    dtype: 'q8',
    custom: true,
    language: 'en',
    sizeMB: 86,
    voices: KOKORO_VOICES,
    defaultVoiceId: 'af_heart',
  },
  {
    id: 'kokoro-82m-fp16',
    name: 'Kokoro-82M (fp16)',
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    modelFile: 'onnx/model_fp16.onnx',
    description: 'Kokoro-82M fp16 (~163MB). Higher quality than q8, larger download.',
    category: 'premium',
    sampleRate: 24000,
    dtype: 'fp16',
    custom: true,
    language: 'en',
    sizeMB: 163,
    voices: KOKORO_VOICES,
    defaultVoiceId: 'af_heart',
  },
  {
    id: 'speecht5',
    name: 'SpeechT5',
    modelId: 'Xenova/speecht5_tts',
    description: 'Microsoft transformer-based TTS. Multiple voices via speaker embeddings.',
    category: 'balanced',
    sampleRate: 16000,
    dtype: 'fp32',
    language: 'en',
    sizeMB: 330,
    runsOnMainThread: true,
    voices: [
      {
        id: 'cmarctic',
        name: 'CMU Arctic (default)',
        description: 'Neutral US English, male. Public xvector from transformers.js docs.',
        speakerEmbeddings: 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin',
      },
      {
        id: 'custom',
        name: 'Custom (paste URL)',
        description: 'Provide your own 512-dim xvector .bin file URL.',
        speakerEmbeddings: '',
      },
    ],
    defaultVoiceId: 'cmarctic',
  },
  {
    id: 'kitten-mini',
    name: 'Kitten TTS Mini (~78MB)',
    modelId: 'KittenML/kitten-tts-mini-0.8',
    modelFile: 'kitten_tts_mini_v0_8.onnx',
    description: 'Larger Kitten model, better quality. Same 8 voice IDs as Kitten Nano but with Mini-trained embeddings.',
    category: 'balanced',
    sampleRate: 24000,
    custom: true,
    language: 'en',
    sizeMB: 78,
    // Voice IDs are the same as kitten-nano, but the float32 embeddings
    // differ (verified: same .npz shape & key set, distinct SHA-256 per
    // voice entry). Pulling from the shared KITTEN_VOICES constant keeps
    // the registry in sync with the actual voice bank shipped in
    // voices.npz, instead of duplicating an 8-entry array that can drift.
    voices: KITTEN_VOICES,
    defaultVoiceId: 'expr-voice-2-m',
  },
  {
    id: 'kitten-nano',
    name: 'Kitten TTS Nano (~24MB)',
    modelId: 'KittenML/kitten-tts-nano-0.8-int8',
    description: 'Tiny fast TTS. 8 voices via phoneme embeddings. ONNX runtime direct.',
    category: 'fast',
    sampleRate: 24000,
    custom: true,
    language: 'en',
    sizeMB: 24,
    // Same voice bank as kitten-mini, different embeddings. See the
    // comment on the kitten-mini entry above.
    voices: KITTEN_VOICES,
    defaultVoiceId: 'expr-voice-2-m',
  },
  // ── MMS-TTS — one model per language, q8 quantized. We only list
  //    languages for which Xenova actually published an ONNX repo
  //    (the `transformers.js` ecosystem depends on these mirrors;
  //    raw `facebook/mms-tts-*` models are PyTorch-only).
  //
  //    Languages we deliberately omit:
  //      • ita, jpn, zho — Xenova namespace returns 401, and
  //        `facebook/mms-tts-{ita,jpn,zho}` are gated at the HF API
  //        level (Meta has since restricted access to these cards).
  //      • nld, pol — `facebook/mms-tts-{nld,pol}` are public
  //        (gated=False, private=False) but ship only PyTorch weights;
  //        no ONNX export exists upstream.
  //
  //    Re-adding any of these needs either an upstream ONNX export
  //    or hosting a self-converted mirror in a sibling HF repo (e.g.
  //    `phantomic12/mms-tts-XXX-onnx`). The HF link-health regression
  //    test (`src/links.test.ts`) skips auth-failed URLs, so an
  //    anonymous probe failure (401/403) won't break CI; a clean 200
  //    is required to be added here.
  { id: 'mms-tts-eng', name: 'MMS-TTS (English)',     modelId: 'Xenova/mms-tts-eng', description: 'Meta MMS for English.',     category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'en', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-spa', name: 'MMS-TTS (Spanish)',     modelId: 'Xenova/mms-tts-spa', description: 'Meta MMS for Spanish.',     category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'es', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-fra', name: 'MMS-TTS (French)',      modelId: 'Xenova/mms-tts-fra', description: 'Meta MMS for French.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'fr', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-deu', name: 'MMS-TTS (German)',      modelId: 'Xenova/mms-tts-deu', description: 'Meta MMS for German.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'de', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-por', name: 'MMS-TTS (Portuguese)',  modelId: 'Xenova/mms-tts-por', description: 'Meta MMS for Portuguese.',  category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'pt', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-rus', name: 'MMS-TTS (Russian)',     modelId: 'Xenova/mms-tts-rus', description: 'Meta MMS for Russian.',     category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'ru', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-kor', name: 'MMS-TTS (Korean)',      modelId: 'Xenova/mms-tts-kor', description: 'Meta MMS for Korean.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'ko', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-hin', name: 'MMS-TTS (Hindi)',       modelId: 'Xenova/mms-tts-hin', description: 'Meta MMS for Hindi.',       category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'hi', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-ara', name: 'MMS-TTS (Arabic)',      modelId: 'Xenova/mms-tts-ara', description: 'Meta MMS for Arabic.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'ar', sizeMB: 50, runsOnMainThread: true, voices: [], defaultVoiceId: '' },
];

// ─── Job queue ───────────────────────────────────────────────────

export type JobStatus = 'pending' | 'generating' | 'done' | 'error' | 'cancelled';

export interface GenerationJob {
  id: string;
  text: string;
  voiceId?: string;
  voiceName?: string;
  /** Override the voice's static speakerEmbeddings URL (e.g. user-pasted custom URL). */
  customSpeakerEmbeddings?: string;
  modelId: string;
  modelName: string;
  /** Playback speed multiplier. 1.0 = normal, 0.5 = half speed, 2.0 = double. */
  speed: number;
  status: JobStatus;
  audio?: Float32Array;
  sampleRate?: number;
  blob?: Blob;
  url?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  /** If set, this job belongs to a document-reading session. */
  readerSessionId?: string;
  /** Order within that reading session. */
  readerIndex?: number;
  /**
   * Per-word start times in seconds, relative to the start of this job's
   * audio. Same length as the number of words in `text` after splitting
   * on whitespace. Populated by engines that expose phoneme durations
   * (e.g. kokoro-js via `stream()`); engines that don't (kitten, MMS)
   * leave this undefined and the reader falls back to chunk-level
   * position-ratio highlighting.
   */
  wordTimings?: number[];
}

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Coarse generation phase for a job, published on every `jobProgress`
 * event so the UI can show more than a bare timer.
 */
export type JobPhase = 'queued' | 'phonemizing' | 'synthesizing' | 'stitching';

/** Payload of the `jobProgress` event (see TTSEngine.processQueue). */
export interface JobProgress {
  jobId: string;
  status: 'generating';
  phase: JobPhase;
  /** Wall-clock ms since the job started generating. */
  elapsedMs: number;
  /** Segments (e.g. Kokoro sentences) completed, when the engine knows. */
  segmentsDone?: number;
  /** Total expected segments, when the engine knows it up front. */
  segmentsTotal?: number;
  /**
   * Audio produced so far, in seconds. Engines that stream can report this
   * incrementally; others leave it undefined until done.
   */
  audioSecondsSoFar?: number;
}

/**
 * Typed event surface. Consumers should prefer the `on()`/`off()` methods
 * on TTSEngine over mutating a callback bag directly. The legacy
 * `EngineEvents` callback map is still accepted by the constructor for
 * backward compatibility but new code should use `on()`.
 *
 * Declared as a type alias with a string index signature so it satisfies
 * `EventEmitter`'s generic constraint.
 */
export type EngineEventMap = {
  jobsChange: (jobs: GenerationJob[]) => void;
  engineStateChange: (state: EngineState) => void;
  loadProgress: (loaded: number, total: number, modelName: string) => void;
  engineError: (message: string) => void;
  jobUpdate: (job: GenerationJob) => void;
  jobDone: (job: GenerationJob) => void;
  /**
   * Emitted ~every 500ms while a job is generating (plus on each segment
   * completion) so live UI can re-render without waiting for state changes.
   * See `JobProgress` for payload shape. Fired from processQueue's
   * heartbeat interval; cleared on done/error/cancel.
   */
  jobProgress: (progress: JobProgress) => void;
} & Record<string, (...args: unknown[]) => void>;

/** @deprecated Use `on('jobsChange', fn)` etc. instead. */
export interface EngineEvents {
  onJobsChange?: (jobs: GenerationJob[]) => void;
  onEngineStateChange?: (state: EngineState) => void;
  onLoadProgress?: (loaded: number, total: number, modelName: string) => void;
  onEngineError?: (message: string) => void;
  /** Fired every time a job is mutated (status, progress, completion). */
  onJobUpdate?: (job: GenerationJob) => void;
  /** Fired once when a job reaches 'done'. */
  onJobDone?: (job: GenerationJob) => void;
}

// ─── Custom-engine registry (Phase C hook) ───────────────────────
// Models with `custom: true` are handled by a custom integration
// (e.g. Kitten TTS using onnxruntime-web directly). The custom engine
// receives the raw job and returns a Float32Array + sample rate.

/**
 * Called by engines that generate in segments (e.g. kokoro-js's
 * `stream()` yields one sentence at a time) so progress can cross the
 * worker boundary while generation is still running.
 */
export type SegmentProgressCallback = (progress: {
  /** Segments completed so far (1-based once the first lands). */
  segmentsDone: number;
  /**
   * Total expected segments when known up front; undefined for engines
   * that discover segments lazily (kokoro-js streams sentence-by-sentence
   * without a total).
   */
  segmentsTotal?: number;
  /** Audio produced so far, in seconds. */
  audioSecondsSoFar?: number;
}) => void;

export interface CustomEngine {
  load(model: TTSModel, progressCallback?: (loaded: number, total: number) => void): Promise<{ sampleRate: number }>;
  generate(model: TTSModel, voiceId: string | undefined, text: string, options?: { speed?: number; onSegmentProgress?: SegmentProgressCallback }): Promise<{ audio: Float32Array; samplingRate: number; wordTimings?: number[] }>;
  dispose(): void;
}

const customEngines = new Map<string, CustomEngine>();

export function registerCustomEngine(modelId: string, engine: CustomEngine): void {
  customEngines.set(modelId, engine);
}

export function unregisterCustomEngine(modelId: string): void {
  customEngines.delete(modelId);
}

// ─── Transformers.js runtime configuration ───────────────────────
// Main-thread pipelines (SpeechT5, MMS) resolve their ONNX Runtime loader
// + WASM from env.backends.onnx.wasm.wasmPaths. Without this they default
// to the jsdelivr CDN, which the app's CSP (script-src 'self') blocks —
// so every main-thread load failed with "no available backend found" on
// cold browsers. `copy-ort-wasm` (vite.config.ts) ships the exact ORT
// build transformers.js pins under /ort-wasm/ at build time.
env.backends.onnx!.wasm!.wasmPaths = `${import.meta.env.BASE_URL}ort-wasm/`;

// ─── GPU detection ───────────────────────────────────────────────
/**
 * Boolean convenience wrapper over `detectCapability()`. The banner and
 * docs use the richer three-class classification (see src/capability.ts);
 * most call sites only need "is WebGPU usable at all".
 */
export async function detectWebGPU(): Promise<boolean> {
  return (await detectCapability()).capability === 'full';
}

// ─── TTS Engine ──────────────────────────────────────────────────
export class TTSEngine extends EventEmitter<EngineEventMap> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipe: any = null;
  private currentModel: TTSModel | null = null;
  private currentSampleRate: number = 16000;
  private engineState: EngineState = 'idle';
  private jobs: GenerationJob[] = [];
  private processing = false;
  private nextJobId = 1;
  /**
   * Heartbeat interval handle for the currently generating job. Ticks
   * every ~500ms emitting `jobProgress` so live UI (ticking timer) can
   * re-render without waiting for a state change. Cleared on done,
   * error, and cancel.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** In-flight load loop promise. Concurrent loadModel() callers all await
   *  this single chain; the loop always ends on the latest requested model. */
  private loadingPromise: Promise<void> | null = null;
  /** Most recently requested model (latest-wins while a load loop runs). */
  private pendingLoadModel: TTSModel | null = null;

  // ─── Load watchdog (no silent state >5s) ──────────────────────
  // HF downloads can stall on flaky networks or blocked huggingface.co.
  // If no progress event arrives within this window, surface an error
  // state with a Retry affordance instead of hanging silently forever.
  private static readonly LOAD_STALL_TIMEOUT_MS = 5000;
  private loadStallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLoadActivityAt = 0;

  private startLoadStallWatchdog(onStalled: () => void): void {
    this.stopLoadStallWatchdog();
    this.lastLoadActivityAt = Date.now();
    const tick = () => {
      if (Date.now() - this.lastLoadActivityAt >= TTSEngine.LOAD_STALL_TIMEOUT_MS) {
        onStalled();
        return; // fired once; cleared by the caller's finally
      }
      this.loadStallTimer = setTimeout(tick, TTSEngine.LOAD_STALL_TIMEOUT_MS / 5);
    };
    this.loadStallTimer = setTimeout(tick, TTSEngine.LOAD_STALL_TIMEOUT_MS);
  }

  private touchLoadActivity(): void {
    this.lastLoadActivityAt = Date.now();
  }

  private stopLoadStallWatchdog(): void {
    if (this.loadStallTimer !== null) {
      clearTimeout(this.loadStallTimer);
      this.loadStallTimer = null;
    }
  }

  constructor(events: EngineEvents = {}) {
    super();
    // Bridge the deprecated callback-bag API to the new emitter so existing
    // callers keep working without modification.
    if (events.onJobsChange) this.on('jobsChange', events.onJobsChange);
    if (events.onEngineStateChange) this.on('engineStateChange', events.onEngineStateChange);
    if (events.onLoadProgress) this.on('loadProgress', events.onLoadProgress);
    if (events.onEngineError) this.on('engineError', events.onEngineError);
    if (events.onJobUpdate) this.on('jobUpdate', events.onJobUpdate);
    if (events.onJobDone) this.on('jobDone', events.onJobDone);
  }

  // ─── State ──────────────────────────────────────────────────────
  private setEngineState(state: EngineState) {
    this.engineState = state;
    this.emit('engineStateChange', state);
  }

  getEngineState(): EngineState {
    return this.engineState;
  }

  getCurrentModel(): TTSModel | null {
    return this.currentModel;
  }

  getJobs(): GenerationJob[] {
    return this.jobs;
  }

  private notifyJobs() {
    // Return a copy so consumers can't mutate internal state
    this.emit('jobsChange', this.jobs.slice());
  }

  private notifyJobUpdate(job: GenerationJob) {
    this.emit('jobUpdate', job);
    if (job.status === 'done') {
      this.emit('jobDone', job);
    }
  }

  // ─── Generation heartbeat ──────────────────────────────────────
  /** Interval for the `jobProgress` heartbeat. 500ms ≈ smooth timer at
   *  a tenth-of-a-second display resolution without flooding listeners. */
  static readonly HEARTBEAT_INTERVAL_MS = 500;

  /**
   * Start emitting `jobProgress` every ~500ms for the given job so the UI
   * re-renders (ticking timer) even when nothing else changes. Exactly one
   * heartbeat exists at a time — starting a new one clears any previous.
   */
  private startHeartbeat(jobId: string, startedAt: number, phase: JobPhase = 'synthesizing'): void {
    this.stopHeartbeat();
    const emitProgress = (): void => {
      this.emit('jobProgress', { jobId, status: 'generating', phase, elapsedMs: Date.now() - startedAt });
    };
    // Fire once immediately so the first frame of "Generating…" carries a
    // real elapsed time instead of waiting a full interval.
    emitProgress();
    this.heartbeatTimer = setInterval(emitProgress, TTSEngine.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Emit a one-off `jobProgress` carrying segment counts. Fired from the
   * segment callback (worker path) so "sentence 2/5" style progress reaches
   * the UI the moment a segment lands, not just on heartbeat ticks.
   */
  private emitSegmentProgress(
    jobId: string,
    startedAt: number,
    progress: { segmentsDone: number; segmentsTotal?: number; audioSecondsSoFar?: number },
  ): void {
    this.emit('jobProgress', {
      jobId,
      status: 'generating',
      phase: 'synthesizing',
      elapsedMs: Date.now() - startedAt,
      segmentsDone: progress.segmentsDone,
      segmentsTotal: progress.segmentsTotal,
      audioSecondsSoFar: progress.audioSecondsSoFar,
    });
  }

  /** Stop the heartbeat. Idempotent; called on done/error/cancel/dispose. */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Model loading ─────────────────────────────────────────────
  async loadModel(model: TTSModel): Promise<void> {
    // Treat a model as already loaded only when *all* identity fields match.
    // Two Kokoro entries share modelId but differ in modelFile / dtype, so
    // a plain modelId check would silently skip the second variant's load.
    const sameModel = this.currentModel
      && this.currentModel.modelId === model.modelId
      && (this.currentModel.modelFile ?? '') === (model.modelFile ?? '')
      && (this.currentModel.dtype ?? 'q8') === (model.dtype ?? 'q8');
    if (sameModel && (this.pipe || customEngines.has(model.modelId)) && !this.loadingPromise) {
      this.setEngineState('ready');
      return;
    }

    // Latest-wins: always record the desired model. A single load loop drains
    // pendingLoadModel until it stabilizes, so rapid clicks end on the last one.
    this.pendingLoadModel = model;
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this.runLoadLoop();
    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async runLoadLoop(): Promise<void> {
    while (true) {
      const model = this.pendingLoadModel;
      if (!model) break;
      this.pendingLoadModel = null;

      // Cancel pending jobs that cannot run under the model we're about to load.
      for (const job of this.jobs) {
        if (job.status === 'pending' && job.modelId !== model.id) {
          job.status = 'cancelled';
          job.error = 'Model changed before generation started';
          job.completedAt = Date.now();
        }
      }
      this.notifyJobs();

      if (this.pipe && typeof this.pipe.dispose === 'function') {
        this.pipe.dispose();
        this.pipe = null;
      }
      if (this.currentModel) {
        const oldCustom = customEngines.get(this.currentModel.modelId);
        if (oldCustom) oldCustom.dispose();
      }

      this.setEngineState('loading');
      this.emit('loadProgress', 0, 1, model.name);
      // No silent state >5s: if no download progress arrives within the
      // window (flaky network, blocked huggingface.co), surface an error
      // with a Retry affordance instead of hanging silently.
      this.startLoadStallWatchdog(() => {
        // Surface BOTH the message (drives the Retry banner) and the state
        // transition (re-enables the load button, hides the progress bar).
        this.emit(
          'engineError',
          `Loading ${model.name} stalled — no download progress for `
          + `${Math.round(TTSEngine.LOAD_STALL_TIMEOUT_MS / 1000)}s. `
          + 'Check your network connection (is huggingface.co reachable?) and retry.',
        );
        this.setEngineState('error');
      });

      try {
        await this.doLoad(model);
      } catch (err) {
        // If a newer model was requested, keep looping instead of surfacing a
        // stale failure as terminal — doLoad already emitted engineError.
        if (!this.pendingLoadModel) throw err;
        continue;
      } finally {
        this.stopLoadStallWatchdog();
      }

      // Concurrent loadModel(same) only sets pendingLoadModel — don't reload
      // an identity we just finished successfully.
      this.clearPendingIfSameAsCurrent();
    }
  }

  /** True when two registry entries refer to the same on-disk/backend artifact. */
  private isSameModelIdentity(a: TTSModel, b: TTSModel): boolean {
    return a.modelId === b.modelId
      && (a.modelFile ?? '') === (b.modelFile ?? '')
      && (a.dtype ?? 'q8') === (b.dtype ?? 'q8');
  }

  private clearPendingIfSameAsCurrent(): void {
    const pending = this.pendingLoadModel;
    const loaded = this.currentModel;
    if (
      pending
      && loaded
      && this.isSameModelIdentity(pending, loaded)
      && this.engineState === 'ready'
    ) {
      this.pendingLoadModel = null;
    }
  }

  private async doLoad(model: TTSModel): Promise<void> {
    try {
      if (model.custom) {
        const custom = customEngines.get(model.modelId);
        if (!custom) {
          throw new Error(`No custom engine registered for model ${model.modelId}`);
        }
        const { sampleRate } = await custom.load(model, (loaded, total) => {
          this.touchLoadActivity();
          this.emit('loadProgress', loaded, total, model.name);
        });
        this.currentSampleRate = sampleRate;
      } else {
        // Wait for in-flight job on a different model to finish first
        // (we just disposed the old pipe; jobs in flight will error out gracefully
        //  because they use the old pipe reference — handled in processQueue)
        // Transformers.js doesn't export a proper ProgressInfo type, so we
        // narrow the callback param with a structural type that matches the
        // subset of fields the engine actually reads.
        interface LoadProgress {
          status: string;
          loaded?: number;
          total?: number;
        }
        const newPipe = await pipeline('text-to-speech', model.modelId, {
          dtype: model.dtype ?? 'q8',
          progress_callback: (progress: LoadProgress) => {
            if (progress.status === 'progress') {
              this.touchLoadActivity();
              this.emit('loadProgress',
                progress.loaded ?? 0,
                progress.total ?? 1,
                model.name,
              );
            } else if (progress.status === 'done') {
              this.touchLoadActivity();
              this.emit('loadProgress', 1, 1, model.name);
            }
          },
        });
        this.pipe = newPipe;
        this.currentSampleRate = model.sampleRate ?? 16000;
      }

      this.currentModel = model;
      this.setEngineState('ready');

      // Process any pending jobs that match the newly loaded model
      this.processQueue();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('engineError', `Load failed: ${msg}`);
      this.setEngineState('error');
      throw err;
    }
  }

  // ─── Job queue ─────────────────────────────────────────────────
  enqueue(text: string, options: { modelId: string; voiceId?: string; customSpeakerEmbeddings?: string; speed?: number; readerSessionId?: string; readerIndex?: number }): GenerationJob {
    const model = MODELS.find(m => m.id === options.modelId) ?? this.currentModel;
    if (!model) {
      throw new Error(`Unknown model: ${options.modelId}`);
    }
    const voice = options.voiceId
      ? model.voices?.find(v => v.id === options.voiceId)
      : model.voices?.find(v => v.id === model.defaultVoiceId);
    const job: GenerationJob = {
      id: `job-${this.nextJobId++}`,
      text,
      voiceId: voice?.id,
      voiceName: voice?.name,
      modelId: model.id,
      modelName: model.name,
      customSpeakerEmbeddings: options.customSpeakerEmbeddings,
      speed: options.speed ?? 1.0,
      status: 'pending',
      createdAt: Date.now(),
      readerSessionId: options.readerSessionId,
      readerIndex: options.readerIndex,
    };
    this.jobs.unshift(job); // newest at top
    this.notifyJobs();
    // Try to process immediately
    queueMicrotask(() => this.processQueue());
    return job;
  }

  cancel(jobId: string): void {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job) return;
    if (job.status === 'pending' || job.status === 'generating') {
      const wasGenerating = job.status === 'generating';
      job.status = 'cancelled';
      job.completedAt = Date.now();
      // If the actively-generating job was cancelled, stop its progress
      // heartbeat immediately rather than waiting for the in-flight
      // generate() to settle (which can take seconds or hang forever).
      if (wasGenerating) this.stopHeartbeat();
      // If the cancelled job is the one currently generating, tear down its
      // inference session NOW instead of waiting for the straggler: a hung or
      // merely slow generation would otherwise keep the queue blocked (and,
      // with a wedged WebGPU call, blocked forever) even though the user has
      // already given up on it. The custom engine rejects its pending request
      // and disposes itself; the next generate lazily reloads a fresh session.
      // Non-custom engines run on the main thread and cannot be aborted, but
      // they're bounded by the generate watchdog in processQueue, so at worst
      // they convert to a TimeoutError instead of stalling the queue forever.
      if (this.processing && this.currentModel && job.modelId === this.currentModel.id) {
        const active = customEngines.get(this.currentModel.modelId);
        const cancellable = active as unknown as { cancelActiveGenerate?: () => void } | undefined;
        if (typeof cancellable?.cancelActiveGenerate === 'function') {
          cancellable.cancelActiveGenerate();
        }
      }
      this.notifyJobUpdate(job);
      this.notifyJobs();
    }
  }

  clearFinished(): void {
    // Revoke blob URLs of finished jobs so we don't leak memory. The user
    // keeps the active ones (pending/generating) so playback continues.
    for (const job of this.jobs) {
      if (job.url && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
        URL.revokeObjectURL(job.url);
        job.url = undefined;
        job.blob = undefined;
        job.audio = undefined;
      }
    }
    this.jobs = this.jobs.filter(j => j.status === 'pending' || j.status === 'generating');
    this.notifyJobs();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    if (this.engineState !== 'ready') return;

    while (true) {
      const next = this.jobs.find(j => j.status === 'pending');
      if (!next) break;
      if (this.currentModel?.id !== next.modelId) break; // need to load the right model first
      if (!this.pipe && !this.currentModel.custom) break;

      this.processing = true;
      next.status = 'generating';
      next.startedAt = Date.now();
      this.notifyJobUpdate(next);
      this.notifyJobs();
      // Liveness: show the pulsing indicator immediately so even a
      // main-thread model that freezes the page during synthesis never
      // leaves a silent queue (acceptance: no silent state >5s).
      const activeJobs = this.jobs.filter(
        j => j.status === 'pending' || j.status === 'generating',
      ).length;
      startGenerationFeedback(activeJobs, 1);
      // Live per-job progress: tick every ~500ms so the card timer moves.
      // Cleared on done / error / cancel below — no interval outlives its job.
      this.startHeartbeat(next.id, next.startedAt);

      try {
        const model = this.currentModel!;
        const voice = next.voiceId
          ? model.voices?.find(v => v.id === next.voiceId)
          : undefined;

        let audio: Float32Array;
        let samplingRate: number;

        // Watchdog for the generation below. Custom (worker) engines already
        // enforce their own per-request bound internally, so the race here is
        // a no-op for them; main-thread pipe() calls have no internal bound,
        // and this is the only thing standing between a wedged transformers.js
        // call and a forever-'generating' job. On expiry the straggler promise
        // is abandoned (not cancellable), but the queue moves on — the next
        // job runs against whatever session survives; if the engine itself is
        // wedged, its own worker-level watchdog has killed + respawned it.
        const genStartedAt = Date.now();
        const withWatchdog = <T,>(p: Promise<T>): Promise<T> => Promise.race([
          p,
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              const elapsedMs = Date.now() - genStartedAt;
              reject(new TimeoutError(
                formatGenerateTimeout(elapsedMs),
                { elapsedMs, engineKind: model.custom ? 'custom' : 'transformers.js', requestType: 'generate' },
              ));
            }, REQUEST_TIMEOUTS.generate);
          }),
        ]);

        if (model.custom) {
          const custom = customEngines.get(model.modelId);
          if (!custom) throw new Error(`Custom engine for ${model.modelId} not registered`);
          const result = await withWatchdog(custom.generate(model, next.voiceId, next.text, {
            speed: next.speed,
            onSegmentProgress: (segProgress) => {
              // Segment granularity (e.g. Kokoro sentences). Emitted as a
              // one-off `jobProgress`; the heartbeat keeps ticking alongside.
              this.emitSegmentProgress(next.id, next.startedAt!, segProgress);
            },
          }));
          audio = result.audio;
          samplingRate = result.samplingRate;
          // Engines that expose per-word start times (e.g. kokoro-js via
          // `stream()`) populate this so the document reader can highlight
          // accurately across chunk boundaries.
          if (result.wordTimings) {
            next.wordTimings = result.wordTimings;
          }
        } else {
          const callOptions: Record<string, unknown> = {};
          // Priority: job-level custom URL > voice's static URL > model's default voice URL
          const embeddingUrl = next.customSpeakerEmbeddings
            ?? voice?.speakerEmbeddings
            ?? model.voices?.find(v => v.id === model.defaultVoiceId)?.speakerEmbeddings
            ?? model.voices?.[0]?.speakerEmbeddings;
          if (embeddingUrl) {
            callOptions.speaker_embeddings = embeddingUrl;
          }
          const pipeCall = this.pipe(next.text, callOptions) as Promise<{
            audio: Float32Array;
            sampling_rate?: number;
          }>;
          const result = await withWatchdog(pipeCall);
          audio = result.audio;
          samplingRate = result.sampling_rate ?? this.currentSampleRate;
        }

        // Resample only for engines without a native speed param
        // (SpeechT5, MMS-TTS). Custom engines (Kokoro, Kitten) apply
        // speed during inference — resampling again would double-speed.
        if (!model.custom && next.speed !== 1.0) {
          audio = changeSpeed(audio, next.speed);
        }

        // Check if cancelled while running. cancel() may have mutated the
        // status during the await above; TS can't see that across methods.
        const liveStatus = next.status as JobStatus;
        if (liveStatus === 'cancelled') {
          this.stopHeartbeat();
          this.processing = false;
          this.notifyJobs();
          continue;
        }

        next.audio = audio;
        next.sampleRate = samplingRate;
        next.blob = float32ToWav(audio, samplingRate);
        next.url = URL.createObjectURL(next.blob);
        next.status = 'done';
        next.completedAt = Date.now();
        next.durationMs = next.completedAt - (next.startedAt ?? next.completedAt);
      } catch (err) {
        if ((next.status as JobStatus) !== 'cancelled') {
          // Timeouts get the canonical human-facing wording (with recovery
          // hints); everything else surfaces its raw message.
          const msg = err instanceof TimeoutError && err.requestType === 'generate'
            ? formatGenerateTimeout(err.elapsedMs)
            : err instanceof Error ? err.message : String(err);
          next.status = 'error';
          next.error = msg;
          next.completedAt = Date.now();
        }
      }

      // The job has settled (done or error); stop ticking. A cancelled job
      // already stopped its own heartbeat above.
      this.stopHeartbeat();
      this.processing = false;
      // Liveness: hide the indicator once no job is generating anymore.
      const stillActive = this.jobs.some(
        j => j.status === 'pending' || j.status === 'generating',
      );
      if (!stillActive) stopGenerationFeedback();
      this.notifyJobUpdate(next);
      this.notifyJobs();
    }
  }

  dispose() {
    // A generation in flight must not leave its heartbeat interval running
    // after teardown.
    this.stopHeartbeat();
    if (this.pipe && typeof this.pipe.dispose === 'function') {
      this.pipe.dispose();
    }
    this.pipe = null;
    this.currentModel = null;
    // Revoke all object URLs
    for (const job of this.jobs) {
      if (job.url) URL.revokeObjectURL(job.url);
    }
    this.jobs = [];
    // Detach every listener so an engine destroyed mid-session doesn't keep
    // its consumers alive (and vice versa).
    this.removeAllListeners();
    this.setEngineState('idle');
  }
}

// ─── WAV Encoding (moved here so the engine owns it) ─────────────
export function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = samples.length * bytesPerSample;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  const offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Math.round prevents the truncation bias of `s * 0x7FFF` for values
    // very close to ±1. Without it, -0.99998 maps to -32766 instead of
    // -32767, costing ~3 dB of dynamic range on quiet peaks.
    view.setInt16(offset + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ─── Speed change via resampling ────────────────────────────────
// Used for engines that don't expose a native speed param
// (SpeechT5, MMS-TTS). Linear interpolation — good enough for TTS.
// Slight pitch shift at extreme values (0.5x or 2.0x) is acceptable
// since the model already sounded that voice — only the duration
// changes, not the speaker identity.
//
// speed = 0.5 → 2x as many samples (audio plays 2x slower at the same
//              sample rate, so the WAV plays back slower)
// speed = 1.0 → no change
// speed = 2.0 → half as many samples (audio plays 2x faster)
export function changeSpeed(audio: Float32Array, speed: number): Float32Array {
  if (speed === 1.0 || speed <= 0) return audio;
  const newLength = Math.max(1, Math.floor(audio.length / speed));
  const out = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIdx = i * speed;
    const idx0 = Math.floor(srcIdx);
    const idx1 = Math.min(idx0 + 1, audio.length - 1);
    const t = srcIdx - idx0;
    out[i] = audio[idx0] * (1 - t) + audio[idx1] * t;
  }
  return out;
}
