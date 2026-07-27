import type { TTSModel } from '../engine';
import { KittenCustomEngine } from './kitten';
import { KokoroCustomEngine } from './kokoro';
import type { WorkerRequest, WorkerResponse } from './worker-bridge';

type Engine = KittenCustomEngine | KokoroCustomEngine;
let engine: Engine | null = null;

const scope = globalThis as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

scope.onmessage = async (event) => {
  try {
    const request = event.data;
    if (request.type === 'load') {
      engine?.dispose();
      engine = request.model.modelId.toLowerCase().includes('kokoro')
        ? new KokoroCustomEngine()
        : new KittenCustomEngine();
      const result = await engine.load(request.model, (loaded, total) => {
        scope.postMessage({ type: 'progress', loaded, total });
      });
      scope.postMessage({ type: 'loaded', sampleRate: result.sampleRate });
    } else if (request.type === 'generate') {
      if (!engine) throw new Error('Inference engine not loaded');
      const result = await engine.generate(request.model, request.voiceId, request.text, { speed: request.speed });
      scope.postMessage({ type: 'generated', ...result }, [result.audio.buffer]);
    } else {
      engine?.dispose();
      engine = null;
      scope.postMessage({ type: 'disposed' });
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

export {}; // Keep this file a module for Vite's worker entry.
