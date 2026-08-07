import type { TTSModel } from '../engine';
import { KittenCustomEngine } from './kitten';
import { KokoroCustomEngine } from './kokoro';
import { selectWorkerEngineKind, type WorkerRequest, type WorkerResponse } from './worker-bridge';

type Engine = KittenCustomEngine | KokoroCustomEngine;
let engine: Engine | null = null;

/** Serialize handler work so overlapping postMessages don't interleave mid-load. */
let chain: Promise<void> = Promise.resolve();

const scope = globalThis as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

function transferableAudio(audio: Float32Array): { audio: Float32Array; transfer: Transferable[] } {
  // Ensure we transfer an owned buffer (not a view into a larger SAB).
  const copy = audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength
    ? audio
    : audio.slice();
  return { audio: copy, transfer: [copy.buffer] };
}

scope.onmessage = (event) => {
  const request = event.data;
  chain = chain.then(async () => {
    try {
      if (request.type === 'load') {
        engine?.dispose();
        engine = selectWorkerEngineKind(request.model.modelId) === 'kokoro'
          ? new KokoroCustomEngine()
          : new KittenCustomEngine();
        const result = await engine.load(request.model, (loaded, total) => {
          scope.postMessage({ id: request.id, type: 'progress', loaded, total });
        });
        scope.postMessage({ id: request.id, type: 'loaded', sampleRate: result.sampleRate });
      } else if (request.type === 'generate') {
        if (!engine) throw new Error('Inference engine not loaded');
        const result = await engine.generate(
          request.model,
          request.voiceId,
          request.text,
          { speed: request.speed },
        );
        const { audio, transfer } = transferableAudio(result.audio);
        scope.postMessage(
          {
            id: request.id,
            type: 'generated',
            audio,
            samplingRate: result.samplingRate,
            wordTimings: result.wordTimings,
          },
          transfer,
        );
      } else {
        engine?.dispose();
        engine = null;
        scope.postMessage({ id: request.id, type: 'disposed' });
      }
    } catch (error) {
      scope.postMessage({
        id: request.id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
};

export {}; // Keep this file a module for Vite's worker entry.
