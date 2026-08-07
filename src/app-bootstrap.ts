import {
  TTSEngine,
  registerCustomEngine,
  type GenerationJob,
  type EngineState,
} from './engine';
import { WorkerBackedEngine } from './engines/worker-bridge';

// ─── Note on Web Worker proxy ────────────────────────────────────
// We previously enabled `env.backends.onnx.wasm.proxy = true` here AND
// in src/engines/kitten.ts to run inference in a Web Worker so the page
// stays responsive during generation. This caused "no available backend
// found" on Kitten because Vite emits the ORT WASM with a content hash
// in its filename, and the proxy worker can't resolve that path via
// `wasmPaths` alone (the worker fetches from the script's own directory).
//
// For now, inference runs on the main thread — generation will block
// the page, but the queue still accepts new jobs (each blocks behind
// the active one). The proper fix is a Vite `?worker` import that owns
// the ONNX runtime + WASM lifecycle, which we'll add as a follow-up.

/**
 * Register Kokoro + both Kitten modelIds as WorkerBackedEngine instances.
 * Must run once before any TTSEngine.loadModel() call.
 */
export function registerEngines(): void {
  // Both Kokoro and Kitten are integrated as CustomEngine instances. We
  // instantiate them up front (cheap — no network) and register with the
  // engine registry so the engine's loadModel() can find them when the user
  // picks those models.
  //
  // KittenCustomEngine and KokoroCustomEngine do no I/O in their constructor;
  // they only fetch model files in their .load() method, which is called
  // later when the user clicks "Download & Load Model".
  //
  // Each model is wrapped in a WorkerBackedEngine so that TTS inference runs
  // off the main thread. The wrapper preserves the CustomEngine interface so
  // the rest of the engine registry doesn't need to know workers exist.
  // The Kokoro repo (`onnx-community/Kokoro-82M-v1.0-ONNX`) is shared by
  // both the q8f16 and fp16 variants; the Kitten repos differ between
  // nano and mini. We register under the modelId the engine will look up.
  for (const modelId of [
    'onnx-community/Kokoro-82M-v1.0-ONNX',
    'KittenML/kitten-tts-nano-0.8-int8',
    'KittenML/kitten-tts-mini-0.8',
  ]) {
    registerCustomEngine(modelId, new WorkerBackedEngine());
  }
}

export interface EngineUiCallbacks {
  onJobsChange: (jobs: GenerationJob[]) => void;
  onEngineStateChange: (state: EngineState) => void;
  onLoadProgress: (loaded: number, total: number, modelName: string) => void;
  onEngineError: (msg: string) => void;
}

/** Construct the app TTSEngine with the given UI callbacks. */
export function createAppEngine(callbacks: EngineUiCallbacks): TTSEngine {
  return new TTSEngine(callbacks);
}
