import type { ExtractedDocument } from './document-reader';
import type { DocumentReaderSession } from './reader';
import { MODELS, type TTSEngine, type TTSModel, type GenerationJob } from './engine';
import type { CapabilityClass, AccelerationInfo } from './capability';
import type { OcrMode } from './document-types';

/** Mutable UI + engine session state shared across main and UI modules. */
export interface AppState {
  engine: TTSEngine | null;
  selectedModel: TTSModel;
  selectedVoiceId: string | undefined;
  customEmbeddingUrl: string;
  currentSpeed: number;
  currentLanguageFilter: string;
  /**
   * Three-class WebGPU capability of this browser. 'partial' means
   * navigator.gpu exists but is unusable (Firefox Nightly, stalled or
   * rejected adapter requests) — the banner words each class differently
   * (see src/capability.ts + docs/capability-banner.md).
   */
  capability: CapabilityClass;
  /**
   * Where inference will actually run. Distinct from `capability` on
   * purpose: an adapter can be acquired and still be useless for these
   * models (no `shader-f16`), so the banner can claim GPU-accelerated
   * while the engines are on the CPU. The model panel needs this to warn
   * about a slow model honestly instead of leaving a 180s watchdog to
   * explain itself.
   */
  acceleration: AccelerationInfo;
  currentJobs: GenerationJob[];
  extractedDocument: ExtractedDocument | null;
  readerSession: DocumentReaderSession | null;
  /** OCR backend for scanned PDFs: 'tesseract' (default) or 'llm' (Florence-2). */
  ocrMode: OcrMode;
}

export function createAppState(): AppState {
  return {
    engine: null,
    selectedModel: MODELS[0],
    selectedVoiceId: MODELS[0].defaultVoiceId ?? MODELS[0].voices?.[0]?.id,
    customEmbeddingUrl: '',
    currentSpeed: 1.0,
    currentLanguageFilter: 'all',
    capability: 'none',
    acceleration: {
      capability: 'none',
      acceleration: 'cpu',
      reason: 'no-webgpu',
      degradedGpu: false,
    },
    currentJobs: [],
    extractedDocument: null,
    readerSession: null,
    ocrMode: 'tesseract',
  };
}
