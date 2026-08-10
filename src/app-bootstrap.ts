import {
  TTSEngine,
  registerCustomEngine,
  type GenerationJob,
  type EngineState,
} from './engine';
import { WorkerBackedEngine } from './engines/worker-bridge';

// ─── Off-thread inference ─────────────────────────────────────
// Kokoro + Kitten run inside a Web Worker via `WorkerBackedEngine` (see
// `src/engines/worker-bridge.ts` → `src/engines/inference-worker.ts`)
// so inference doesn't block the page while a job is in progress. The
// page stays interactive; the queue serializes requests on each worker.
//
// A earlier version tried `env.backends.onnx.wasm.proxy = true` and
// hit "no available backend found" — Vite emits the ORT WASM with a
// content hash and the proxy worker couldn't resolve the path. We do
// not toggle `wasm.proxy`; rely on `WorkerBackedEngine` instead. The
// `copy-ort-wasm` Vite plugin (vite.config.ts) keeps stable copies of
// every ORT WASM flavor under `public/ort-wasm/` so any custom
// locateFile / wasmPaths call still resolves.

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
