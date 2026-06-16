import { pipeline } from '@huggingface/transformers';

// ─── Model definitions ───────────────────────────────────────────
export interface TTSModel {
  id: string;
  name: string;
  modelId: string;
  description: string;
  category: 'fast' | 'balanced' | 'multilingual';
  /**
   * If set, URL (or relative path) to a 512-dim Float32Array of speaker embeddings
   * Required by SpeechT5. MMS-TTS models work without this.
   */
  speakerEmbeddings?: string;
  /**
   * Sampling rate of the model's output audio (Hz). MMS-TTS = 16000, SpeechT5 = 16000.
   */
  sampleRate?: number;
  /**
   * v3 data type passed to the pipeline. SpeechT5 MUST use 'fp32' — the
   * quantized variant produces garbled audio (see huggingface/transformers.js#406).
   * MMS-TTS uses 'q8' by default for smaller downloads with acceptable quality.
   */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
}

export const MODELS: TTSModel[] = [
  {
    id: 'mms-tts-eng',
    name: 'MMS-TTS (English)',
    modelId: 'Xenova/mms-tts-eng',
    description: 'Meta MMS. 1,100+ languages supported.',
    category: 'multilingual',
    sampleRate: 16000,
    dtype: 'q8',
  },
  {
    id: 'speecht5',
    name: 'SpeechT5',
    modelId: 'Xenova/speecht5_tts',
    description: 'Microsoft transformer-based TTS. Good quality, English.',
    category: 'balanced',
    sampleRate: 16000,
    // SpeechT5 has no built-in default speaker — must pass speaker embeddings.
    // Using the public CMU-Arctic xvector sample from the Transformers.js docs dataset.
    speakerEmbeddings: 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin',
    // SpeechT5 must use fp32 — the quantized variant produces garbled audio
    // (huggingface/transformers.js#406).
    dtype: 'fp32',
  },
  {
    id: 'mms-tts-spa',
    name: 'MMS-TTS (Spanish)',
    modelId: 'Xenova/mms-tts-spa',
    description: 'Meta MMS for Spanish.',
    category: 'multilingual',
    sampleRate: 16000,
    dtype: 'q8',
  },
  {
    id: 'mms-tts-fra',
    name: 'MMS-TTS (French)',
    modelId: 'Xenova/mms-tts-fra',
    description: 'Meta MMS for French.',
    category: 'multilingual',
    sampleRate: 16000,
    dtype: 'q8',
  },
  {
    id: 'mms-tts-deu',
    name: 'MMS-TTS (German)',
    modelId: 'Xenova/mms-tts-deu',
    description: 'Meta MMS for German.',
    category: 'multilingual',
    sampleRate: 16000,
    dtype: 'q8',
  },
  {
    id: 'mms-tts-jpn',
    name: 'MMS-TTS (Japanese)',
    modelId: 'Xenova/mms-tts-jpn',
    description: 'Meta MMS for Japanese.',
    category: 'multilingual',
    sampleRate: 16000,
    dtype: 'q8',
  },
  {
    id: 'mms-tts-zho',
    name: 'MMS-TTS (Chinese)',
    modelId: 'Xenova/mms-tts-zho',
    description: 'Meta MMS for Chinese.',
    category: 'multilingual',
    sampleRate: 16000,
    dtype: 'q8',
  },
];

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

// ─── Engine state ────────────────────────────────────────────────
export type EngineState = 'idle' | 'loading' | 'ready' | 'generating' | 'error';

export interface EngineEvents {
  onStateChange?: (state: EngineState) => void;
  onProgress?: (loaded: number, total: number, model: string) => void;
  onError?: (error: string) => void;
}

// ─── TTS Engine ──────────────────────────────────────────────────
export class TTSEngine {
  // The pipeline return type is a massive union; we use 'any' internally to avoid type gymnastics
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipe: any = null;
  private currentModelId: string | null = null;
  private currentSampleRate: number = 16000;
  private state: EngineState = 'idle';
  private events: EngineEvents;
  private useWebGPU: boolean;

  constructor(events: EngineEvents = {}, useWebGPU = true) {
    this.events = events;
    this.useWebGPU = useWebGPU;
  }

  private setState(state: EngineState) {
    this.state = state;
    this.events.onStateChange?.(state);
  }

  getState(): EngineState {
    return this.state;
  }

  async loadModel(model: TTSModel): Promise<void> {
    if (this.currentModelId === model.modelId && this.pipe) {
      this.setState('ready');
      return;
    }

    this.setState('loading');
    this.events.onProgress?.(0, 1, model.name);

    try {
      // v3 API uses `dtype` (e.g. 'fp32', 'q8', 'q4'). Default to 'q8' for compact
      // downloads; SpeechT5 overrides to 'fp32' because the quantized variant
      // produces garbled output (huggingface/transformers.js#406).
      const newPipe = await pipeline('text-to-speech', model.modelId, {
        dtype: model.dtype ?? 'q8',
        progress_callback: (progress: any) => {
          if (progress.status === 'progress') {
            this.events.onProgress?.(
              progress.loaded ?? 0,
              progress.total ?? 1,
              model.name
            );
          } else if (progress.status === 'done') {
            this.events.onProgress?.(1, 1, model.name);
          }
        },
      });

      // Dispose previous pipeline if switching models
      if (this.pipe && typeof this.pipe.dispose === 'function') {
        this.pipe.dispose();
      }

      this.pipe = newPipe;
      this.currentModelId = model.modelId;
      this.currentSampleRate = model.sampleRate ?? 16000;
      this.setState('ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events.onError?.(msg);
      this.setState('error');
      throw err;
    }
  }

  async generate(text: string, options: { speakerEmbeddings?: string } = {}): Promise<{ audio: Float32Array; samplingRate: number }> {
    if (!this.pipe) {
      throw new Error('No model loaded');
    }

    this.setState('generating');

    try {
      const callOptions: any = {};
      if (options.speakerEmbeddings) {
        callOptions.speaker_embeddings = options.speakerEmbeddings;
      }
      const result = await this.pipe(text, callOptions);
      this.setState('ready');
      // Some pipelines return RawAudio { audio, sampling_rate }; some return just { audio }
      const samplingRate = result.sampling_rate ?? this.currentSampleRate;
      return { audio: result.audio, samplingRate };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events.onError?.(msg);
      this.setState('error');
      throw err;
    }
  }

  dispose() {
    if (this.pipe && typeof this.pipe.dispose === 'function') {
      this.pipe.dispose();
    }
    this.pipe = null;
    this.currentModelId = null;
    this.setState('idle');
  }
}
