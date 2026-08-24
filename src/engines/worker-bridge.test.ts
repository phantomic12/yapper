import { describe, expect, it, vi } from 'vitest';
import {
  createDisposeRequest,
  createGenerateRequest,
  createLoadRequest,
  selectWorkerEngineKind,
  WorkerBackedEngine,
} from './worker-bridge';
import { REQUEST_TIMEOUTS, TimeoutError } from './timeouts';
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

// ─── Hang watchdog ───────────────────────────────────────────────
//
// The acceptance criterion is that a worker which NEVER replies must still
// convert into a visible error within the configured bound, and the NEXT
// request must succeed on a freshly-respawned worker.

/** Short timeout table so tests exercise real timers in milliseconds. */
const testTimeouts = {
  load: 60,
  generate: 60,
  dispose: 10,
};

function makeNeverReplyingWorker() {
  let handler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
  return {
    postMessage(_message: unknown) {
      /* swallow every request — simulates a hung WebGPU/ORT call */
      void handler;
    },
    addEventListener(_type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
      handler = listener;
    },
    removeEventListener() {
      handler = null;
    },
    terminate: vi.fn(),
  };
}

/** Worker that answers `load` promptly but hangs every `generate`. */
function makeLoadOnlyWorker() {
  let handler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
  return {
    postMessage(message: { id: number; type: string }) {
      queueMicrotask(() => {
        if (message.type === 'load') {
          handler?.({ data: { id: message.id, type: 'loaded', sampleRate: 24000 } } as MessageEvent);
        }
        // 'generate' requests are swallowed — the hung-call simulation.
      });
    },
    addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
      if (type === 'message') handler = listener;
    },
    removeEventListener() {},
    terminate: vi.fn(),
  };
}

describe('WorkerBackedEngine — hang watchdog', () => {
  it('rejects a never-replying load with a typed TimeoutError and terminates the worker', async () => {
    vi.useFakeTimers();
    try {
      const worker = makeNeverReplyingWorker();
      const engine = new WorkerBackedEngine(() => worker, testTimeouts);
      const loadPromise = engine.load(model);

      const expectation = expect(loadPromise).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(testTimeouts.load + 10);
      await expectation;

      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries elapsedMs and engine kind on the TimeoutError', async () => {
    vi.useFakeTimers();
    try {
      // Worker answers loads (so lazy respawn completes) but hangs generates —
      // isolates the generate watchdog.
      const engine = new WorkerBackedEngine(() => makeLoadOnlyWorker(), testTimeouts);
      const promise = engine.generate(model, 'v', 'hi');
      const expectation = expect(promise).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(testTimeouts.generate + 10);
      const err: TimeoutError = await promise.catch(e => e);
      expect(err.name).toBe('TimeoutError');
      expect(err.requestType).toBe('generate');
      expect(err.engineKind).toBe('kitten'); // stamped by the respawned load
      expect(err.elapsedMs).toBeGreaterThanOrEqual(testTimeouts.generate - 1);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a subsequent generate succeeds after a stalled generate killed the first worker (lazy respawn)', async () => {
    // First worker never replies; the factory hands out a healthy one for
    // the respawn. This is the exact acceptance-criterion shape.
    vi.useFakeTimers();
    try {
      let messageHandler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
      const dead = makeNeverReplyingWorker();
      const healthy = {
        postMessage(message: { id: number; type: string }) {
          queueMicrotask(() => {
            if (message.type === 'load') {
              messageHandler?.({ data: { id: message.id, type: 'loaded', sampleRate: 24000 } } as MessageEvent);
            } else if (message.type === 'generate') {
              messageHandler?.({
                data: {
                  id: message.id,
                  type: 'generated',
                  audio: new Float32Array([0.1, 0.2]),
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

      const workers = [dead, healthy];
      const engine = new WorkerBackedEngine(() => workers.shift() ?? healthy, testTimeouts);

      // First generation wedges and hits the watchdog.
      const stalled = engine.generate(model, 'v', 'stalled text');
      const stallExpectation = expect(stalled).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(testTimeouts.generate + 10);
      await stallExpectation;
      expect(dead.terminate).toHaveBeenCalledTimes(1);

      // The next generate transparently respawns + reloads the fresh worker.
      const recovered = engine.generate(model, 'v', 'next job');
      await vi.advanceTimersByTimeAsync(50);
      const result = await recovered;
      expect(result.audio.length).toBe(2);
      expect(result.samplingRate).toBe(24000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelActiveGenerate rejects the pending request immediately and disposes the session', async () => {
    // No fake timers needed: the worker hangs generates, so the watchdog
    // never fires — cancel() must settle the request on its own.
    let messageHandler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
    const terminate = vi.fn();
    const fakeWorker = {
      postMessage(message: { id: number; type: string }) {
        queueMicrotask(() => {
          if (message.type === 'load') {
            messageHandler?.({ data: { id: message.id, type: 'loaded', sampleRate: 24000 } } as MessageEvent);
          }
          // generates are swallowed
        });
      },
      addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
        if (type === 'message') messageHandler = listener;
      },
      removeEventListener() {},
      terminate,
    };
    const engine = new WorkerBackedEngine(() => fakeWorker, testTimeouts);
    // Load first (worker replies) so the generate below is the request that
    // hangs — matching the real cancel-mid-generation sequence.
    await engine.load(model);
    const pending = engine.generate(model, 'v', 'straggler');
    // Let the serialized request chain actually post the generate and
    // register its pending slot (run() executes on a microtask).
    await new Promise(r => setTimeout(r, 0));

    // Attach the rejection assertion before cancelling to avoid an unhandled
    // rejection; cancelActiveGenerate() itself is synchronous.
    const expectation = expect(pending).rejects.toThrow(/cancelled/i);
    engine.cancelActiveGenerate(); // no waiting — returns synchronously
    await expectation;

    // Session torn down so different-model work can start right away; the
    // next generate lazily respawns via the factory.
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('disarms the watchdog when the worker replies before the bound (no spurious kill)', async () => {
    let messageHandler: ((event: MessageEvent | ErrorEvent) => void) | null = null;
    const terminate = vi.fn();
    const fakeWorker = {
      postMessage(message: { id: number; type: string }) {
        queueMicrotask(() => {
          if (message.type === 'load') {
            messageHandler?.({ data: { id: message.id, type: 'loaded', sampleRate: 16000 } } as MessageEvent);
          }
        });
      },
      addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
        if (type === 'message') messageHandler = listener;
      },
      removeEventListener() {},
      terminate,
    };
    const engine = new WorkerBackedEngine(() => fakeWorker, testTimeouts);
    await engine.load(model);
    // Well past the load bound now — a leaked timer would have terminated.
    await new Promise(r => setTimeout(r, 80));
    expect(terminate).not.toHaveBeenCalled();
  });

  it('exposes the default per-type bounds from REQUEST_TIMEOUTS', () => {
    expect(REQUEST_TIMEOUTS.load).toBe(300_000);
    expect(REQUEST_TIMEOUTS.generate).toBe(180_000);
    expect(REQUEST_TIMEOUTS.dispose).toBe(10_000);
  });
});
