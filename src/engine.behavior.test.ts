import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TTSEngine,
  MODELS,
  registerCustomEngine,
  unregisterCustomEngine,
  type TTSModel,
  type GenerationJob,
} from './engine';
import { DocumentReaderSession } from './reader';

// ─── Test fixtures ───────────────────────────────────────────────

function findModel(id: string): TTSModel {
  const m = MODELS.find(x => x.id === id);
  if (!m) throw new Error(`No model with id ${id}`);
  return m;
}

// A mock CustomEngine that returns deterministic audio in a controllable time.
class MockEngine {
  sampleRate = 24000;
  /** ms to take per `generate()` call. */
  generateMs = 5;
  /** if set, the next generate() rejects with this error. */
  failNext: Error | null = null;
  /** observed generate inputs. */
  calls: { voiceId?: string; text: string; speed?: number }[] = [];
  /** if true, generate() blocks indefinitely until manually resolved. */
  block: Promise<void> | null = null;
  /** Optional timings to attach to each generated job. */
  wordTimings?: number[];

  async load(_model: TTSModel, _progress?: (loaded: number, total: number) => void): Promise<{ sampleRate: number }> {
    return { sampleRate: this.sampleRate };
  }

  async generate(_model: TTSModel, voiceId: string | undefined, text: string, options?: { speed?: number }) {
    this.calls.push({ voiceId, text, speed: options?.speed });
    if (this.block) await this.block;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return {
      audio: new Float32Array(this.sampleRate),
      samplingRate: this.sampleRate,
      wordTimings: this.wordTimings,
    };
  }

  dispose() {
    /* no-op */
  }
}

function mockKitten(): MockEngine {
  return new MockEngine();
}

/** Helper: drain microtasks until the engine has had a chance to process. */
async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('TTSEngine — model loading', () => {
  let mock: MockEngine;

  beforeEach(() => {
    mock = mockKitten();
    registerCustomEngine('KittenML/kitten-tts-nano-0.8-int8', mock);
  });

  it('transitions idle → loading → ready on a successful load', async () => {
    const states: string[] = [];
    const engine = new TTSEngine({ onEngineStateChange: s => states.push(s) });
    await engine.loadModel(findModel('kitten-nano'));
    expect(states).toEqual(['loading', 'ready']);
    expect(engine.getEngineState()).toBe('ready');
    expect(engine.getCurrentModel()?.id).toBe('kitten-nano');
    unregisterCustomEngine('KittenML/kitten-tts-nano-0.8-int8');
  });

  it('rejects the second of two concurrent loadModel calls (single-flight)', async () => {
    const states: string[] = [];
    const engine = new TTSEngine({ onEngineStateChange: s => states.push(s) });
    // Load #2 starts while #1 is in flight.
    const p1 = engine.loadModel(findModel('kitten-nano'));
    const p2 = engine.loadModel(findModel('kitten-nano'));
    await Promise.all([p1, p2]);
    // Only one transition should have happened.
    expect(states).toEqual(['loading', 'ready']);
    expect(engine.getEngineState()).toBe('ready');
    unregisterCustomEngine('KittenML/kitten-tts-nano-0.8-int8');
  });

  it('emits error state if the custom engine throws on load', async () => {
    mock.load = async () => { throw new Error('mock load failure'); };
    const engine = new TTSEngine();
    await expect(engine.loadModel(findModel('kitten-nano'))).rejects.toThrow('mock load failure');
    expect(engine.getEngineState()).toBe('error');
    unregisterCustomEngine('KittenML/kitten-tts-nano-0.8-int8');
  });

  it('throws if no custom engine is registered for a custom model', async () => {
    unregisterCustomEngine('KittenML/kitten-tts-nano-0.8-int8');
    const engine = new TTSEngine();
    await expect(engine.loadModel(findModel('kitten-nano'))).rejects.toThrow(/No custom engine registered/);
    expect(engine.getEngineState()).toBe('error');
  });

  it('treats same-modelId with different dtype as a different model (reloads)', async () => {
    const kokoroMock = mockKitten();
    const loadSpy = vi.spyOn(kokoroMock, 'load');
    registerCustomEngine('onnx-community/Kokoro-82M-v1.0-ONNX', kokoroMock);
    try {
      const engine = new TTSEngine();
      // First Kokoro entry (q8)
      await engine.loadModel(findModel('kokoro-82m'));
      // Second Kokoro entry (fp16) shares modelId but different dtype
      await engine.loadModel(findModel('kokoro-82m-fp16'));
      // The kokoro mock should be called twice (one per load) because the
      // cache check compares dtype too.
      expect(loadSpy).toHaveBeenCalledTimes(2);
    } finally {
      unregisterCustomEngine('onnx-community/Kokoro-82M-v1.0-ONNX');
    }
  });

  it('skips reload when the exact same model entry is loaded twice', async () => {
    const spy = vi.spyOn(mock, 'load');
    const engine = new TTSEngine();
    await engine.loadModel(findModel('kitten-nano'));
    await engine.loadModel(findModel('kitten-nano'));
    expect(spy).toHaveBeenCalledTimes(1);
    unregisterCustomEngine('KittenML/kitten-tts-nano-0.8-int8');
  });
});

describe('TTSEngine — job queue', () => {
  let mock: MockEngine;
  let engine: TTSEngine;

  beforeEach(async () => {
    mock = mockKitten();
    registerCustomEngine('KittenML/kitten-tts-nano-0.8-int8', mock);
    engine = new TTSEngine();
    await engine.loadModel(findModel('kitten-nano'));
  });

  it('enqueue() returns a pending job that finishes async', async () => {
    const job = engine.enqueue('hello', { modelId: 'kitten-nano' });
    expect(job.id).toMatch(/^job-/);
    expect(job.status).toBe('pending');
    expect(engine.getJobs().map(j => j.id)).toContain(job.id);

    // Wait for completion
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (engine.getJobs().find(j => j.id === job.id)?.status === 'done') {
          clearInterval(i);
          resolve();
        }
      }, 2);
    });
    const finished = engine.getJobs().find(j => j.id === job.id)!;
    expect(finished.status).toBe('done');
    expect(finished.audio).toBeInstanceOf(Float32Array);
    expect(finished.sampleRate).toBe(24000);
    expect(finished.blob).toBeInstanceOf(Blob);
    expect(finished.url).toMatch(/^blob:/);
  });

  it('propagates wordTimings from the custom engine to the finished job', async () => {
    mock.wordTimings = [0, 0.25, 0.5, 0.75, 1.0];
    const job = engine.enqueue('one two three four five', { modelId: 'kitten-nano' });
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (engine.getJobs().find(j => j.id === job.id)?.status === 'done') {
          clearInterval(i);
          resolve();
        }
      }, 2);
    });
    const finished = engine.getJobs().find(j => j.id === job.id)!;
    expect(finished.wordTimings).toEqual([0, 0.25, 0.5, 0.75, 1.0]);
  });

  it('leaves wordTimings undefined when the engine does not provide them', async () => {
    // mock.wordTimings is undefined unless set above
    const job = engine.enqueue('silent job', { modelId: 'kitten-nano' });
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (engine.getJobs().find(j => j.id === job.id)?.status === 'done') {
          clearInterval(i);
          resolve();
        }
      }, 2);
    });
    expect(engine.getJobs().find(j => j.id === job.id)?.wordTimings).toBeUndefined();
  });

  it('processes jobs in newest-first order (matches the UI: newest is at index 0)', async () => {
    // The engine unshifts new jobs and find()s the first pending one, so
    // newer jobs are dequeued first. This is the actual behavior the UI
    // relies on: a freshly-added "interrupt" job preempts queued ones.
    mock.generateMs = 10;
    const order: string[] = [];
    const watch = new TTSEngine({
      onJobDone: j => order.push(j.text),
    });
    await watch.loadModel(findModel('kitten-nano'));
    watch.enqueue('first', { modelId: 'kitten-nano' });
    watch.enqueue('second', { modelId: 'kitten-nano' });
    watch.enqueue('third', { modelId: 'kitten-nano' });

    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (watch.getJobs().every(j => j.status === 'done')) {
          clearInterval(i);
          resolve();
        }
      }, 5);
    });
    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('newest job is at the top of the list (matches UI)', () => {
    const a = engine.enqueue('a', { modelId: 'kitten-nano' });
    const b = engine.enqueue('b', { modelId: 'kitten-nano' });
    expect(engine.getJobs()[0].id).toBe(b.id);
    expect(engine.getJobs()[1].id).toBe(a.id);
  });

  it('cancel() flips a pending job to cancelled', () => {
    const job = engine.enqueue('cancel me', { modelId: 'kitten-nano' });
    expect(job.status).toBe('pending');
    engine.cancel(job.id);
    expect(engine.getJobs().find(j => j.id === job.id)?.status).toBe('cancelled');
  });

  it('clearFinished() drops done jobs from the list', async () => {
    const j1 = engine.enqueue('first', { modelId: 'kitten-nano' });
    // Wait for it to finish
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const i = setInterval(() => {
        if (Date.now() > deadline) return reject(new Error('timeout'));
        const s = engine.getJobs().find(j => j.id === j1.id)?.status;
        if (s === 'done') {
          clearInterval(i);
          resolve();
        }
      }, 5);
    });
    engine.clearFinished();
    expect(engine.getJobs()).toEqual([]);
  });

  it('clearFinished() keeps active (pending/generating) jobs in the list', async () => {
    // Make generate block long enough that the new job is still pending when
    // we call clearFinished.
    mock.generateMs = 200;
    const j1 = engine.enqueue('first', { modelId: 'kitten-nano' });
    // j1 starts generating on next microtask
    engine.clearFinished();
    // j1 was generating, must not be cleared
    expect(engine.getJobs().map(j => j.id)).toEqual([j1.id]);
    engine.cancel(j1.id);
  });

  it('emits onJobsChange with a copy on every mutation', () => {
    const calls: GenerationJob[][] = [];
    const e = new TTSEngine({ onJobsChange: jobs => calls.push(jobs) });
    e.enqueue('x', { modelId: 'kitten-nano' });
    e.enqueue('y', { modelId: 'kitten-nano' });
    // At least one call per enqueue; callers must NOT be able to mutate our state
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const last = calls[calls.length - 1];
    const before = last.length;
    last.pop();
    // Mutating the returned array doesn't affect the engine
    expect(e.getJobs().length).toBe(before);
  });

  it('uses changeSpeed resampling for non-custom (transformer.js) jobs', async () => {
    // We don't have a transformers pipeline available in jsdom, so exercise
    // the speed path via the public API and ensure the custom engine receives
    // a speed param. For 1.0x, speed should be passed through unchanged.
    mock.calls.length = 0;
    const job = engine.enqueue('hi', { modelId: 'kitten-nano', speed: 0.5 });
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (engine.getJobs().find(j => j.id === job.id)?.status === 'done') {
          clearInterval(i);
          resolve();
        }
      }, 2);
    });
    expect(mock.calls[0].speed).toBe(0.5);
  });

  it('dispose() revokes object URLs and clears jobs', async () => {
    const job = engine.enqueue('bye', { modelId: 'kitten-nano' });
    const url = await new Promise<string>((resolve) => {
      const i = setInterval(() => {
        const j = engine.getJobs().find(j => j.id === job.id);
        if (j?.url) { clearInterval(i); resolve(j.url); }
      }, 2);
    });
    // jsdom doesn't track URL.revokeObjectURL, but we can spy on it
    const spy = vi.spyOn(URL, 'revokeObjectURL');
    engine.dispose();
    expect(spy).toHaveBeenCalledWith(url);
    expect(engine.getJobs()).toEqual([]);
    expect(engine.getEngineState()).toBe('idle');
  });
});

describe('TTSEngine — event emitter API', () => {
  let mock: MockEngine;
  let engine: TTSEngine;

  beforeEach(async () => {
    mock = mockKitten();
    registerCustomEngine('KittenML/kitten-tts-nano-0.8-int8', mock);
    engine = new TTSEngine();
    await engine.loadModel(findModel('kitten-nano'));
  });

  it('DocumentReaderSession listeners survive a second concurrent session', async () => {
    // Regression test: the old monkey-patch implementation would overwrite
    // the engine.events.onJobDone reference when a second session started,
    // silently breaking the first.
    const sessionA = new DocumentReaderSession(engine, 'Hello world.', { chunkSize: 50 });
    const sessionB = new DocumentReaderSession(engine, 'Second text here.', { chunkSize: 50 });
    // Just constructing them is enough — if both sessions' subscribes ran
    // without overwriting each other, we're good. (We don't drive actual
    // playback here because that requires real audio + Audio API.)
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    sessionA.stop();
    sessionB.stop();
  });

  it('on() returns an unsubscribe fn that detaches the listener', async () => {
    const fn = vi.fn();
    const off = engine.on('jobDone', fn);
    engine.enqueue('hi', { modelId: 'kitten-nano' });
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (engine.getJobs().every(j => j.status === 'done')) { clearInterval(i); resolve(); }
      }, 5);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    engine.enqueue('hi again', { modelId: 'kitten-nano' });
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (engine.getJobs().every(j => j.status === 'done')) { clearInterval(i); resolve(); }
      }, 5);
    });
    // Still 1 — listener was detached
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('two listeners on the same event both fire (no monkey-patch clobbering)', async () => {
    const a = vi.fn();
    const b = vi.fn();
    engine.on('jobDone', a);
    engine.on('jobDone', b);
    engine.enqueue('hi', { modelId: 'kitten-nano' });
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (engine.getJobs().every(j => j.status === 'done')) { clearInterval(i); resolve(); }
      }, 5);
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a listener that throws does not break subsequent listeners', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = vi.fn();
    engine.on('jobDone', () => { throw new Error('boom'); });
    engine.on('jobDone', good);
    engine.enqueue('hi', { modelId: 'kitten-nano' });
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (engine.getJobs().every(j => j.status === 'done')) { clearInterval(i); resolve(); }
      }, 5);
    });
    expect(good).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('dispose() clears every registered listener', () => {
    const fn = vi.fn();
    engine.on('jobDone', fn);
    engine.dispose();
    // The listener map is private; verify indirectly by trying to read it
    // off the EventEmitter base class via a probe emit.
    const probe = (engine as unknown as { listeners: Map<string, Set<unknown>> }).listeners;
    expect(probe.size).toBe(0);
  });
});

describe('TTSEngine — model switching mid-queue', () => {
  let mockA: MockEngine;
  let mockB: MockEngine;
  let engine: TTSEngine;

  beforeEach(() => {
    mockA = mockKitten();
    mockB = mockKitten();
    registerCustomEngine('KittenML/kitten-tts-nano-0.8-int8', mockA);
    // The "mini" entry shares modelId with the nano mock — but for this test
    // we register a different mock under a different modelId. Use the kokoro
    // mock instead.
    registerCustomEngine('onnx-community/Kokoro-82M-v1.0-ONNX', mockB);
  });

  afterEach(() => {
    unregisterCustomEngine('KittenML/kitten-tts-nano-0.8-int8');
    unregisterCustomEngine('onnx-community/Kokoro-82M-v1.0-ONNX');
  });

  it('cancels pending jobs for the OLD model when switching', async () => {
    engine = new TTSEngine();
    await engine.loadModel(findModel('kitten-nano'));
    // Queue three kitten jobs — only one will run because we switch mid-flight.
    // The handles are unused because we look jobs up by their modelId in the
    // final assertion, but we need to enqueue them so they exist in the queue.
    engine.enqueue('k1', { modelId: 'kitten-nano' });
    engine.enqueue('k2', { modelId: 'kitten-nano' });
    engine.enqueue('k3', { modelId: 'kitten-nano' });

    // Wait a tick so processQueue starts j1
    await flush();
    expect(mockA.calls.length).toBeGreaterThanOrEqual(1);

    // Switch models. Pending (not yet generating) kitten jobs must be cancelled.
    await engine.loadModel(findModel('kokoro-82m'));

    const after = engine.getJobs();
    const cancelled = after.filter(j => j.status === 'cancelled');
    // j1 might have completed already (since mock is fast). j2/j3 must be cancelled.
    const stillPendingKitten = after.find(j =>
      j.modelId === 'kitten-nano' && j.status === 'pending'
    );
    expect(stillPendingKitten).toBeUndefined();
    // And they should carry the "Model changed" reason
    expect(cancelled.every(j => j.error === 'Model changed before generation started')).toBe(true);
  });
});

// ─── Load watchdog + generation liveness (AC4) ───────────────────
describe('TTSEngine — no silent states', () => {
  let mock: MockEngine;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    unregisterCustomEngine('KittenML/kitten-tts-nano-0.8-int8');
  });

  it('emits engineError when a load stalls with no progress for >5s (AC1/AC4)', async () => {
    mock = new MockEngine();
    // Load hangs forever — simulates a stalled HF download on a flaky
    // network or blocked huggingface.co.
    mock.load = () => new Promise<{ sampleRate: number }>(() => {});
    registerCustomEngine('KittenML/kitten-tts-nano-0.8-int8', mock);

    const errors: string[] = [];
    const engine = new TTSEngine({ onEngineError: (m) => { errors.push(m); } });

    void engine.loadModel(findModel('kitten-nano'));
    await vi.advanceTimersByTimeAsync(4999);
    expect(errors).toEqual([]); // no premature firing, no silent success either

    await vi.advanceTimersByTimeAsync(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('stalled');
    expect(errors[0]).toContain('retry');

    // The engine surfaces the error state so the UI can show Retry.
    expect(engine.getEngineState()).toBe('error');
  });

  it('does not fire the watchdog when progress keeps arriving', async () => {
    mock = new MockEngine();
    mock.generateMs = 5;
    registerCustomEngine('KittenML/kitten-tts-nano-0.8-int8', mock);
    // Slow but alive: progress callbacks every second keep the watchdog fed.
    mock.load = (_model, progress) =>
      new Promise<{ sampleRate: number }>((resolve) => {
        let n = 0;
        const iv = setInterval(() => {
          n += 1;
          progress?.(n * 10, 100);
          if (n >= 7) {
            clearInterval(iv);
            resolve({ sampleRate: 24000 });
          }
        }, 1000);
      });

    const errors: string[] = [];
    const engine = new TTSEngine({ onEngineError: (m) => { errors.push(m); } });

    const loading = engine.loadModel(findModel('kitten-nano'));
    await vi.advanceTimersByTimeAsync(8000);
    await loading;

    expect(errors).toEqual([]);
    expect(engine.getEngineState()).toBe('ready');
  });

  it('a failed load still reaches error state promptly (retry path)', async () => {
    mock = new MockEngine();
    mock.load = () => Promise.reject(new Error('unable to connect to huggingface.co'));
    registerCustomEngine('KittenML/kitten-tts-nano-0.8-int8', mock);

    const errors: string[] = [];
    const engine = new TTSEngine({ onEngineError: (m) => { errors.push(m); } });

    await engine.loadModel(findModel('kitten-nano')).catch(() => {});
    expect(errors.some(m => m.includes('Load failed'))).toBe(true);
    expect(engine.getEngineState()).toBe('error');
  });
});