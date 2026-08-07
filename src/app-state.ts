import type { ExtractedDocument } from './document-reader';
import type { DocumentReaderSession } from './reader';
import { MODELS, type TTSEngine, type TTSModel, type GenerationJob } from './engine';

/** Mutable UI + engine session state shared across main and UI modules. */
export interface AppState {
  engine: TTSEngine | null;
  selectedModel: TTSModel;
  selectedVoiceId: string | undefined;
  customEmbeddingUrl: string;
  currentSpeed: number;
  currentLanguageFilter: string;
  webgpuAvailable: boolean;
  currentJobs: GenerationJob[];
  extractedDocument: ExtractedDocument | null;
  readerSession: DocumentReaderSession | null;
}

export function createAppState(): AppState {
  return {
    engine: null,
    selectedModel: MODELS[0],
    selectedVoiceId: MODELS[0].defaultVoiceId ?? MODELS[0].voices?.[0]?.id,
    customEmbeddingUrl: '',
    currentSpeed: 1.0,
    currentLanguageFilter: 'all',
    webgpuAvailable: false,
    currentJobs: [],
    extractedDocument: null,
    readerSession: null,
  };
}
