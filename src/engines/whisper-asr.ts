// ─── Whisper Tiny ASR (on-device, WASM) ──────────────────────────
// The model half of dictation. Loads Whisper Tiny through
// Transformers.js and transcribes 16 kHz mono float32 audio.
//
// Deliberately WASM, not WebGPU: the quantised q8 build is what keeps the
// download at 41 MB, and quantised decoders are the least reliable thing
// on the WebGPU backend. A tiny model on WASM transcribes a few seconds
// of speech in a second or two, which is fast enough for dictation — the
// bottleneck here is the user finishing a sentence, not the inference.
//
// The model is loaded once per session and disposed on unload. Nothing
// leaves the browser: the audio is a Float32Array that never touches the
// network, only the model weights are fetched.

import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers';
import type { AsrModelSpec } from '../asr';

export interface AsrProgress {
  status: string;
  /** 0..1 while downloading; -1 for events that have no progress to report. */
  progress: number;
}

interface Loaded {
  id: string;
  pipe: AutomaticSpeechRecognitionPipeline;
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
let loadingId = '';

/** True once a model is resident and ready to transcribe. */
export function isAsrLoaded(): boolean {
  return loaded !== null;
}

/** Which repo is currently loaded, if any. */
export function loadedAsrModelId(): string | null {
  return loaded?.id ?? null;
}

/** Progress callback for Transformers.js download events. */
function progressHandler(onProgress?: (progress: AsrProgress) => void) {
  return (event: { status?: string; progress?: number; file?: string }) => {
    if (!onProgress) return;
    const status = event.status ?? 'loading';
    const progress =
      typeof event.progress === 'number' && Number.isFinite(event.progress)
        ? event.progress / 100
        : -1;
    onProgress({ status, progress });
  };
}

/**
 * Load (or reuse) a model. Calling this while a different model is
 * loading waits for that one and then loads the requested one, so a
 * language switch mid-download cannot interleave two pipelines.
 */
export async function loadAsrModel(
  spec: AsrModelSpec,
  onProgress?: (progress: AsrProgress) => void,
): Promise<void> {
  if (loaded?.id === spec.id) return;
  if (loading) {
    await loading.catch(() => undefined);
    if (loaded?.id === spec.id) return;
  }
  loadingId = spec.id;
  loading = (async () => {
    const pipe = await pipeline('automatic-speech-recognition', spec.id, {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      device: 'wasm',
      progress_callback: progressHandler(onProgress),
    });
    return { id: spec.id, pipe };
  })();

  try {
    loaded = await loading;
  } finally {
    loading = null;
    loadingId = '';
  }
}

/**
 * Transcribe 16 kHz mono audio. Returns clean text — non-speech labels
 * stripped and whitespace collapsed — or an empty string when the model
 * found nothing worth keeping.
 *
 * Callers are responsible for splitting anything longer than 30 seconds;
 * see `splitForWhisper` in `asr.ts`.
 */
export async function transcribeAudio(
  samples: Float32Array,
  options: { language?: string } = {},
): Promise<string> {
  if (!loaded) throw new Error('ASR model is not loaded');
  if (!samples.length) return '';

  const multilingual = loaded.id.endsWith('/whisper-tiny');
  const result = await loaded.pipe(samples, {
    // `.en` checkpoints throw if given `task` or `language` — they are
    // locked to English transcription. Only multilingual ones take a hint.
    ...(multilingual ? { language: options.language ?? 'en', task: 'transcribe' } : {}),
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  });

  const text = Array.isArray(result)
    ? result.map((part) => part.text ?? '').join(' ')
    : (result as { text?: string }).text ?? '';

  // Import here rather than at module load so this file stays a thin
  // model wrapper; the cleanup rules live with their tests.
  const { normalizeTranscript } = await import('../asr');
  return normalizeTranscript(text);
}

/** Release the pipeline. The next transcribe needs a fresh `loadAsrModel`. */
export function disposeAsr(): void {
  if (loaded?.pipe && typeof loaded.pipe.dispose === 'function') {
    try {
      loaded.pipe.dispose();
    } catch {
      // Disposal is best-effort; a dead GPU context must not throw on unload.
    }
  }
  loaded = null;
  loading = null;
  loadingId = '';
}

/** Exposed for the model panel: what is in flight right now. */
export function pendingAsrModelId(): string {
  return loadingId;
}
