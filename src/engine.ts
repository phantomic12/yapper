import { pipeline } from '@huggingface/transformers';

// ─── Model definitions ───────────────────────────────────────────

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
}

export const MODELS: TTSModel[] = [
  {
    id: 'kokoro-82m',
    name: 'Kokoro-82M (q8)',
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    modelFile: 'onnx/model_q8f16.onnx',
    description: 'High-quality 82M TTS. 28 built-in voices. q8f16 quantized (~86MB).',
    category: 'premium',
    sampleRate: 24000,
    custom: true,
    language: 'en',
    sizeMB: 86,
    voices: [
      { id: 'af_heart',   name: 'Heart (en-us, Female)' },
      { id: 'af_bella',   name: 'Bella (en-us, Female)' },
      { id: 'am_michael', name: 'Michael (en-us, Male)' },
      { id: 'am_adam',    name: 'Adam (en-us, Male)' },
      { id: 'bf_emma',    name: 'Emma (en-gb, Female)' },
      { id: 'bm_george',  name: 'George (en-gb, Male)' },
    ],
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
    custom: true,
    language: 'en',
    sizeMB: 163,
    voices: [
      { id: 'af_heart',   name: 'Heart (en-us, Female)' },
      { id: 'af_bella',   name: 'Bella (en-us, Female)' },
      { id: 'am_michael', name: 'Michael (en-us, Male)' },
      { id: 'am_adam',    name: 'Adam (en-us, Male)' },
      { id: 'bf_emma',    name: 'Emma (en-gb, Female)' },
      { id: 'bm_george',  name: 'George (en-gb, Male)' },
    ],
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
    description: 'Larger Kitten model, better quality. 8 voices.',
    category: 'balanced',
    sampleRate: 24000,
    custom: true,
    language: 'en',
    sizeMB: 78,
    voices: [
      { id: 'expr-voice-2-m', name: 'Voice 2 (Male)' },
      { id: 'expr-voice-2-f', name: 'Voice 2 (Female)' },
      { id: 'expr-voice-3-m', name: 'Voice 3 (Male)' },
      { id: 'expr-voice-3-f', name: 'Voice 3 (Female)' },
      { id: 'expr-voice-4-m', name: 'Voice 4 (Male)' },
      { id: 'expr-voice-4-f', name: 'Voice 4 (Female)' },
      { id: 'expr-voice-5-m', name: 'Voice 5 (Male)' },
      { id: 'expr-voice-5-f', name: 'Voice 5 (Female)' },
    ],
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
    voices: [
      { id: 'expr-voice-2-m', name: 'Voice 2 (Male)' },
      { id: 'expr-voice-2-f', name: 'Voice 2 (Female)' },
      { id: 'expr-voice-3-m', name: 'Voice 3 (Male)' },
      { id: 'expr-voice-3-f', name: 'Voice 3 (Female)' },
      { id: 'expr-voice-4-m', name: 'Voice 4 (Male)' },
      { id: 'expr-voice-4-f', name: 'Voice 4 (Female)' },
      { id: 'expr-voice-5-m', name: 'Voice 5 (Male)' },
      { id: 'expr-voice-5-f', name: 'Voice 5 (Female)' },
    ],
    defaultVoiceId: 'expr-voice-2-m',
  },
  // ── MMS-TTS — one model per language, q8 quantized ────────────────
  { id: 'mms-tts-eng', name: 'MMS-TTS (English)',     modelId: 'Xenova/mms-tts-eng', description: 'Meta MMS for English.',     category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'en', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-spa', name: 'MMS-TTS (Spanish)',     modelId: 'Xenova/mms-tts-spa', description: 'Meta MMS for Spanish.',     category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'es', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-fra', name: 'MMS-TTS (French)',      modelId: 'Xenova/mms-tts-fra', description: 'Meta MMS for French.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'fr', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-deu', name: 'MMS-TTS (German)',      modelId: 'Xenova/mms-tts-deu', description: 'Meta MMS for German.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'de', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-ita', name: 'MMS-TTS (Italian)',     modelId: 'Xenova/mms-tts-ita', description: 'Meta MMS for Italian.',     category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'it', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-por', name: 'MMS-TTS (Portuguese)',  modelId: 'Xenova/mms-tts-por', description: 'Meta MMS for Portuguese.',  category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'pt', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-rus', name: 'MMS-TTS (Russian)',     modelId: 'Xenova/mms-tts-rus', description: 'Meta MMS for Russian.',     category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'ru', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-jpn', name: 'MMS-TTS (Japanese)',    modelId: 'Xenova/mms-tts-jpn', description: 'Meta MMS for Japanese.',    category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'ja', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-zho', name: 'MMS-TTS (Chinese)',     modelId: 'Xenova/mms-tts-zho', description: 'Meta MMS for Chinese.',     category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'zh', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-kor', name: 'MMS-TTS (Korean)',      modelId: 'Xenova/mms-tts-kor', description: 'Meta MMS for Korean.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'ko', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-hin', name: 'MMS-TTS (Hindi)',       modelId: 'Xenova/mms-tts-hin', description: 'Meta MMS for Hindi.',       category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'hi', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-ara', name: 'MMS-TTS (Arabic)',      modelId: 'Xenova/mms-tts-ara', description: 'Meta MMS for Arabic.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'ar', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-nld', name: 'MMS-TTS (Dutch)',       modelId: 'Xenova/mms-tts-nld', description: 'Meta MMS for Dutch.',       category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'nl', sizeMB: 50, voices: [], defaultVoiceId: '' },
  { id: 'mms-tts-pol', name: 'MMS-TTS (Polish)',      modelId: 'Xenova/mms-tts-pol', description: 'Meta MMS for Polish.',      category: 'multilingual', sampleRate: 16000, dtype: 'q8', language: 'pl', sizeMB: 50, voices: [], defaultVoiceId: '' },
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
}

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

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
export interface CustomEngine {
  load(model: TTSModel, progressCallback?: (loaded: number, total: number) => void): Promise<{ sampleRate: number }>;
  generate(model: TTSModel, voiceId: string | undefined, text: string, options?: { speed?: number }): Promise<{ audio: Float32Array; samplingRate: number }>;
  dispose(): void;
}

const customEngines = new Map<string, CustomEngine>();

export function registerCustomEngine(modelId: string, engine: CustomEngine): void {
  customEngines.set(modelId, engine);
}

export function unregisterCustomEngine(modelId: string): void {
  customEngines.delete(modelId);
}

// ─── GPU detection ───────────────────────────────────────────────
export async function detectWebGPU(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await (navigator as any).gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

// ─── TTS Engine ──────────────────────────────────────────────────
export class TTSEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipe: any = null;
  private currentModel: TTSModel | null = null;
  private currentSampleRate: number = 16000;
  private engineState: EngineState = 'idle';
  private jobs: GenerationJob[] = [];
  private processing = false;
  private events: EngineEvents;
  private nextJobId = 1;

  constructor(events: EngineEvents = {}) {
    this.events = events;
  }

  // ─── State ──────────────────────────────────────────────────────
  private setEngineState(state: EngineState) {
    this.engineState = state;
    this.events.onEngineStateChange?.(state);
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
    this.events.onJobsChange?.(this.jobs.slice());
  }

  private notifyJobUpdate(job: GenerationJob) {
    this.events.onJobUpdate?.(job);
    if (job.status === 'done') {
      this.events.onJobDone?.(job);
    }
  }

  // ─── Model loading ─────────────────────────────────────────────
  async loadModel(model: TTSModel): Promise<void> {
    if (this.currentModel?.modelId === model.modelId && (this.pipe || customEngines.has(model.modelId))) {
      this.setEngineState('ready');
      return;
    }

    // If we're mid-generation on a different model, let it finish but cancel
    // any pending jobs for the OLD model — they can never run with the new one.
    for (const job of this.jobs) {
      if (job.status === 'pending' && job.modelId !== model.modelId) {
        job.status = 'cancelled';
        job.error = 'Model changed before generation started';
        job.completedAt = Date.now();
      }
    }
    this.notifyJobs();

    // Dispose old pipe (if switching models)
    if (this.pipe && typeof this.pipe.dispose === 'function') {
      this.pipe.dispose();
      this.pipe = null;
    }
    if (this.currentModel) {
      const oldCustom = customEngines.get(this.currentModel.modelId);
      if (oldCustom) oldCustom.dispose();
    }

    this.setEngineState('loading');
    this.events.onLoadProgress?.(0, 1, model.name);

    try {
      if (model.custom) {
        const custom = customEngines.get(model.modelId);
        if (!custom) {
          throw new Error(`No custom engine registered for model ${model.modelId}`);
        }
        const { sampleRate } = await custom.load(model, (loaded, total) => {
          this.events.onLoadProgress?.(loaded, total, model.name);
        });
        this.currentSampleRate = sampleRate;
      } else {
        // Wait for in-flight job on a different model to finish first
        // (we just disposed the old pipe; jobs in flight will error out gracefully
        //  because they use the old pipe reference — handled in processQueue)
        const newPipe = await pipeline('text-to-speech', model.modelId, {
          dtype: model.dtype ?? 'q8',
          progress_callback: (progress: any) => {
            if (progress.status === 'progress') {
              this.events.onLoadProgress?.(
                progress.loaded ?? 0,
                progress.total ?? 1,
                model.name
              );
            } else if (progress.status === 'done') {
              this.events.onLoadProgress?.(1, 1, model.name);
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
      this.events.onEngineError?.(`Load failed: ${msg}`);
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
      job.status = 'cancelled';
      job.completedAt = Date.now();
      // If this was the active job, the processQueue loop will see it on next tick
      this.notifyJobUpdate(job);
      this.notifyJobs();
    }
  }

  clearFinished(): void {
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

      try {
        const model = this.currentModel!;
        const voice = next.voiceId
          ? model.voices?.find(v => v.id === next.voiceId)
          : undefined;

        let audio: Float32Array;
        let samplingRate: number;

        if (model.custom) {
          const custom = customEngines.get(model.modelId);
          if (!custom) throw new Error(`Custom engine for ${model.modelId} not registered`);
          const result = await custom.generate(model, next.voiceId, next.text, { speed: next.speed });
          audio = result.audio;
          samplingRate = result.samplingRate;
        } else {
          const callOptions: any = {};
          // Priority: job-level custom URL > voice's static URL > model's default voice URL
          const embeddingUrl = next.customSpeakerEmbeddings
            ?? voice?.speakerEmbeddings
            ?? model.voices?.find(v => v.id === model.defaultVoiceId)?.speakerEmbeddings
            ?? model.voices?.[0]?.speakerEmbeddings;
          if (embeddingUrl) {
            callOptions.speaker_embeddings = embeddingUrl;
          }
          const result = await this.pipe(next.text, callOptions);
          audio = result.audio;
          samplingRate = result.sampling_rate ?? this.currentSampleRate;
        }

        // Resample to apply playback speed for engines that don't have
        // a native speed param (SpeechT5, MMS-TTS). Kokoro and Kitten
        // already applied speed during inference.
        if (next.speed !== 1.0) {
          audio = changeSpeed(audio, next.speed);
        }

        // Check if cancelled while running. cancel() may have mutated the
        // status during the await above; TS can't see that across methods.
        const liveStatus = next.status as JobStatus;
        if (liveStatus === 'cancelled') {
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
          const msg = err instanceof Error ? err.message : String(err);
          next.status = 'error';
          next.error = msg;
          next.completedAt = Date.now();
        }
      }

      this.processing = false;
      this.notifyJobUpdate(next);
      this.notifyJobs();
    }
  }

  dispose() {
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
    view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
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
