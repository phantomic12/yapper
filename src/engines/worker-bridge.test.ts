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

  it('routes generate-progress segment messages to the onSegmentProgress callback without settling the request', async () => {
    let messageHandler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
    const fakeWorker = {
      postMessage(message: { id: number; type: string }) {
        queueMicrotask(() => {
          if (message.type === 'load') {
            messageHandler?.({ data: { id: message.id, type: 'loaded', sampleRate: 24000 } } as MessageEvent);
            return;
          }
          if (message.type !== 'generate') return;
          // Two segment updates arrive BEFORE the terminal 'generated'.
          messageHandler?.({
            data: {
              id: message.id,
              type: 'generate-progress',
              segmentsDone: 1,
              audioSecondsSoFar: 2.4,
            },
          } as unknown as MessageEvent);
          messageHandler?.({
            data: {
              id: message.id,
              type: 'generate-progress',
              segmentsDone: 2,
              audioSecondsSoFar: 5.1,
            },
          } as unknown as MessageEvent);
          messageHandler?.({
            data: {
              id: message.id,
              type: 'generated',
              audio: new Float32Array([0.1]),
              samplingRate: 24000,
            },
          } as MessageEvent);
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
    const segments: { segmentsDone: number; audioSecondsSoFar?: number }[] = [];
    const out = await engine.generate(model, 'v', 'two sentences', {
      onSegmentProgress: s => segments.push(s),
    });
    // Both segment callbacks fired with the payloads from the worker.
    expect(segments).toEqual([
      { segmentsDone: 1, segmentsTotal: undefined, audioSecondsSoFar: 2.4 },
      { segmentsDone: 2, segmentsTotal: undefined, audioSecondsSoFar: 5.1 },
    ]);
    // The generate promise still resolved with the final audio.
    expect(out.audio.length).toBe(1);
    expect(out.audio[0]).toBeCloseTo(0.1, 5);
    expect(out.samplingRate).toBe(24000);
  });

  it('forwards a known segmentsTotal from generate-progress messages', async () => {
    let messageHandler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
    const fakeWorker = {
      postMessage(message: { id: number; type: string }) {
        queueMicrotask(() => {
          if (message.type === 'load') {
            messageHandler?.({ data: { id: message.id, type: 'loaded', sampleRate: 16000 } } as MessageEvent);
            return;
          }
          if (message.type !== 'generate') return;
          messageHandler?.({
            data: {
              id: message.id,
              type: 'generate-progress',
              segmentsDone: 3,
              segmentsTotal: 7,
              audioSecondsSoFar: 9.9,
            },
          } as unknown as MessageEvent);
          messageHandler?.({
            data: { id: message.id, type: 'generated', audio: new Float32Array(0), samplingRate: 16000 },
          } as MessageEvent);
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
    const segments: { segmentsDone?: number; segmentsTotal?: number }[] = [];
    await engine.generate(model, 'v', 'x', { onSegmentProgress: s => segments.push(s) });
    expect(segments[0]).toMatchObject({ segmentsDone: 3, segmentsTotal: 7 });
  });

  it('constructs the worker via the canonical Vite-friendly URL', () => {
    // The default factory must use `new URL('./inference-worker.ts',
    // import.meta.url)` — Vite rewrites that at build time to point at
    // the emitted worker bundle. If anyone switches this to a CDN URL,
    // an absolute path, or a data: URL, the worker fails to load
    // (no COOP/COEP headers on the demo CDN) and the production app
    // breaks silently. Read the source and assert the literal form.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, 'worker-bridge.ts'),
      'utf8',
    );
    expect(src).toMatch(
      /new Worker\(\s*new URL\(\s*['"]\.\/inference-worker\.ts['"]\s*,\s*import\.meta\.url\s*\)/,
    );
    // Worker must be a module worker — ORT is ESM-only.
    expect(src).toMatch(/type:\s*'module'/);
  });
});
