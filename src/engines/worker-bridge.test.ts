import { describe, expect, it, vi } from 'vitest';
import {
  createDisposeRequest,
  createGenerateRequest,
  createLoadRequest,
  selectWorkerEngineKind,
  WorkerBackedEngine,
} from './worker-bridge';
import type { TTSModel } from '../engine';
import { KOKORO_MODEL_ID } from './kokoro';

const model = {
  id: 'x',
  modelId: 'KittenML/kitten-tts-nano-0.8-int8',
  name: 'Model',
  description: '',
  category: 'fast',
  custom: true,
} as TTSModel;

const kokoroModel = {
  ...model,
  id: 'kokoro-82m',
  modelId: KOKORO_MODEL_ID,
} as TTSModel;

describe('worker protocol helpers', () => {
  it('encodes load, generate, and dispose requests with unique ids', () => {
    const load = createLoadRequest(model);
    const gen = createGenerateRequest(model, 'voice', 'hello', 1.25);
    const disp = createDisposeRequest();
    expect(load).toMatchObject({ type: 'load', model });
    expect(gen).toMatchObject({ type: 'generate', model, voiceId: 'voice', text: 'hello', speed: 1.25 });
    expect(disp).toMatchObject({ type: 'dispose' });
    expect(typeof load.id).toBe('number');
    expect(typeof gen.id).toBe('number');
    expect(typeof disp.id).toBe('number');
    expect(new Set([load.id, gen.id, disp.id]).size).toBe(3);
  });

  it('selects kokoro vs kitten engines by model id', () => {
    expect(selectWorkerEngineKind(KOKORO_MODEL_ID)).toBe('kokoro');
    expect(selectWorkerEngineKind('onnx-community/Kokoro-82M-v1.0-ONNX')).toBe('kokoro');
    expect(selectWorkerEngineKind('KittenML/kitten-tts-nano-0.8-int8')).toBe('kitten');
  });
});

describe('WorkerBackedEngine', () => {
  it('correlates responses by request id and surfaces progress', async () => {
    const posts: unknown[] = [];
    let messageHandler: ((event: MessageEvent | ErrorEvent) => void) | null = null;

    const fakeWorker = {
      postMessage(message: { id: number; type: string }) {
        posts.push(message);
        queueMicrotask(() => {
          if (message.type === 'load') {
            messageHandler?.({ data: { id: message.id, type: 'progress', loaded: 1, total: 2 } } as MessageEvent);
            messageHandler?.({ data: { id: message.id, type: 'loaded', sampleRate: 24000 } } as MessageEvent);
          }
        });
      },
      addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
        if (type === 'message') messageHandler = listener;
      },
      removeEventListener() {},
      terminate: vi.fn(),
    };

    const engine = new WorkerBackedEngine(() => fakeWorker);
    const progress: Array<[number, number]> = [];
    const result = await engine.load(kokoroModel, (l, t) => progress.push([l, t]));
    expect(result.sampleRate).toBe(24000);
    expect(progress).toEqual([[1, 2]]);
    expect(posts[0]).toMatchObject({ type: 'load', model: kokoroModel });
  });

  it('rejects in-flight work on dispose', async () => {
    let messageHandler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
    const fakeWorker = {
      postMessage() {
        /* never responds */
      },
      addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
        if (type === 'message') messageHandler = listener;
      },
      removeEventListener() {},
      terminate: vi.fn(),
    };
    void messageHandler;
    const engine = new WorkerBackedEngine(() => fakeWorker);
    // Start load without awaiting completion path via dispose
    const loadPromise = engine.load(model);
    engine.dispose();
    await expect(loadPromise).rejects.toThrow(/disposed|not available/i);
    expect(fakeWorker.terminate).toHaveBeenCalled();
  });

  it('returns generated audio from correlated response', async () => {
    let messageHandler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
    const fakeWorker = {
      postMessage(message: { id: number; type: string }) {
        queueMicrotask(() => {
          if (message.type === 'load') {
            messageHandler?.({ data: { id: message.id, type: 'loaded', sampleRate: 24000 } } as MessageEvent);
          } else if (message.type === 'generate') {
            messageHandler?.({
              data: {
                id: message.id,
                type: 'generated',
                audio: new Float32Array([0, 0.5, -0.5]),
                samplingRate: 24000,
              },
            } as MessageEvent);
          }
        });
      },
      addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
        if (type === 'message') messageHandler = listener;
      },
      removeEventListener() {},
      terminate: vi.fn(),
    };
    const engine = new WorkerBackedEngine(() => fakeWorker);
    await engine.load(model);
    const out = await engine.generate(model, 'v', 'hi', { speed: 1 });
    expect(out.samplingRate).toBe(24000);
    expect(Array.from(out.audio)).toEqual([0, 0.5, -0.5]);
  });
});
