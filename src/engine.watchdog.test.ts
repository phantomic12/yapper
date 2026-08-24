import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TTSEngine,
  MODELS,
  registerCustomEngine,
  unregisterCustomEngine,
  type TTSModel,
} from './engine';
import { REQUEST_TIMEOUTS } from './engines/timeouts';

// ─── Hang-watchdog coverage at the TTSEngine level ───────────────
//
// Acceptance criteria exercised here:
//   1. A never-resolving engine → job errors within the bound with a clear
//      human message, AND a subsequent job succeeds (queue recovers).
//   2. Cancel mid-generation leaves the queue usable.
//   3. Main-thread pipe() path errors instead of hanging.

function findModel(id: string): TTSModel {
  const m = MODELS.find(x => x.id === id);
  if (!m) throw new Error(`No model with id ${id}`);
  return m;
}

/**
 * Custom engine whose generate() promise never SETTLES on its own — the
 * hung WebGPU/ORT simulation. When constructed with cancellable=true it
 * mirrors WorkerBackedEngine: cancelActiveGenerate() rejects the pending
 * request immediately; otherwise nothing can settle the promise and only
 * the queue-level watchdog can free the job.
 */
class WedgedEngine {
  sampleRate = 24000;
  generateCalls = 0;
  disposed = false;
  private rejectCurrent: ((err: Error) => void) | null = null;

  constructor(private readonly cancellable = true) {}

  async load(_model: TTSModel): Promise<{ sampleRate: number }> {
    return { sampleRate: this.sampleRate };
  }

  generate(
    _model: TTSModel,
    _voiceId: string | undefined,
    _text: string,
    _options?: { speed?: number },
  ): Promise<{ audio: Float32Array; samplingRate: number; wordTimings?: number[] }> {
    this.generateCalls++;
    return new Promise((_resolve, reject) => {
      if (this.cancellable) {
        this.rejectCurrent = reject;
      }
      // otherwise: never settles, never rejects — the wedge under test
    });
  }

  dispose(): void {
    this.disposed = true;
    this.rejectCurrent = null;
  }

  /** Optional capability the queue's cancel path duck-types for. */
  cancelActiveGenerate(): void {
    this.rejectCurrent?.(new Error('Generation cancelled'));
    this.dispose();
  }
}

const KITTEN_ID = 'KittenML/kitten-tts-nano-0.8-int8';

describe('TTSEngine — hang watchdog', () => {
  let engine: WedgedEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new WedgedEngine();
    registerCustomEngine(KITTEN_ID, engine);
  });

  afterEach(() => {
    unregisterCustomEngine(KITTEN_ID);
    vi.useRealTimers();
  });

  it('converts a never-resolving generation into a job error with the canonical message', async () => {
    const tts = new TTSEngine();
    // Load runs through the mock instantly; only generate wedges.
    const loadPromise = tts.loadModel(findModel('kitten-nano'));
    await vi.advanceTimersByTimeAsync(10);
    await loadPromise;

    const job = tts.enqueue('hang forever', { modelId: 'kitten-nano' });
    await vi.advanceTimersByTimeAsync(10);
    expect(tts.getJobs().find(j => j.id === job.id)?.status).toBe('generating');

    // Cross the generate bound.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUTS.generate + 1000);

    const finished = tts.getJobs().find(j => j.id === job.id)!;
    expect(finished.status).toBe('error');
    expect(finished.error).toMatch(/Generation timed out after \d+s\. Try shorter text or reload the model\./);
  });

  it('the next enqueued job succeeds after a stalled one errored (queue recovers)', async () => {
    const tts = new TTSEngine();
    const loadPromise = tts.loadModel(findModel('kitten-nano'));
    await vi.advanceTimersByTimeAsync(10);
    await loadPromise;

    const bad = tts.enqueue('wedge the engine', { modelId: 'kitten-nano' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUTS.generate + 1000);
    expect(tts.getJobs().find(j => j.id === bad.id)?.status).toBe('error');

    // Swap in a healthy engine for the recovery attempt (in production this
    // is the bridge's lazily respawned worker).
    registerCustomEngine(KITTEN_ID, healthyEngine(240));

    const good = tts.enqueue('should succeed', { modelId: 'kitten-nano' });
    await vi.advanceTimersByTimeAsync(100);

    const finished = tts.getJobs().find(j => j.id === good.id)!;
    expect(finished.status).toBe('done');
    expect(finished.audio?.length).toBe(240);
  });

  it('cancel mid-generation disposes the active session and keeps the queue usable', async () => {
    const disposeSpy = vi.spyOn(engine, 'dispose');
    const tts = new TTSEngine();
    const loadPromise = tts.loadModel(findModel('kitten-nano'));
    await vi.advanceTimersByTimeAsync(10);
    await loadPromise;

    const straggler = tts.enqueue('will be cancelled', { modelId: 'kitten-nano' });
    await vi.advanceTimersByTimeAsync(10);
    expect(straggler.status).toBe('generating');

    tts.cancel(straggler.id);
    expect(straggler.status).toBe('cancelled');
    // The active session was torn down immediately instead of being awaited.
    expect(disposeSpy).toHaveBeenCalled();

    // Queue is usable right away: swap in a healthy engine and enqueue again.
    registerCustomEngine(KITTEN_ID, healthyEngine(120));
    const next = tts.enqueue('after cancel', { modelId: 'kitten-nano' });
    await vi.advanceTimersByTimeAsync(100);
    expect(tts.getJobs().find(j => j.id === next.id)?.status).toBe('done');
  });

  it('cancel of a non-cancellable engine still frees the job via the watchdog bound', async () => {
    // Engine WITHOUT the optional cancelActiveGenerate hook: cancel() flips
    // the job status but cannot settle the straggler. The queue-level
    // watchdog must convert it to an error at the bound so the loop exits.
    engine.disposed = false;
    const uncancellable = new WedgedEngine(false);
    registerCustomEngine(KITTEN_ID, uncancellable);
    const tts = new TTSEngine();
    const loadPromise = tts.loadModel(findModel('kitten-nano'));
    await vi.advanceTimersByTimeAsync(10);
    await loadPromise;

    const straggler = tts.enqueue('uncancellable straggler', { modelId: 'kitten-nano' });
    await vi.advanceTimersByTimeAsync(10);
    expect(straggler.status).toBe('generating');

    tts.cancel(straggler.id);
    expect(straggler.status).toBe('cancelled');

    // The wedged generate promise never settles, but the watchdog race
    // rejects at the bound, so processQueue's catch runs and the loop exits
    // with processing=false. No further jobs would be processed by THIS
    // wedged engine instance — but the bound guarantees the queue is not
    // stuck inside an await forever.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUTS.generate + 1000);
    await vi.advanceTimersByTimeAsync(10);
    // Loop exited: enqueueing after the bound no longer throws or hangs the
    // test itself (a pre-fix implementation would leave `processing` true).
    expect(tts.getJobs().every(j => j.status !== 'generating')).toBe(true);
  });

});

/** Minimal healthy CustomEngine double returning fixed-length silence. */
function healthyEngine(samples: number) {
  return {
    async load(): Promise<{ sampleRate: number }> {
      return { sampleRate: 24000 };
    },
    async generate(): Promise<{ audio: Float32Array; samplingRate: number }> {
      return { audio: new Float32Array(samples), samplingRate: 24000 };
    },
    dispose(): void {},
  };
}

describe('TTSEngine — main-thread pipe timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Install a fake "loaded main-thread model" without touching the network:
   * point currentModel at the SpeechT5 entry and inject a pipe stub through
   * the internal field. This exercises the exact production path —
   * processQueue's withWatchdog(this.pipe(...)) branch.
   */
  function installPipeStub(tts: TTSEngine, pipeImpl: () => Promise<unknown>): void {
    type EngineInternals = {
      currentModel: TTSModel | null;
      engineState: string;
      pipe: unknown;
    };
    const internals = tts as unknown as EngineInternals;
    internals.currentModel = findModel('speecht5');
    internals.engineState = 'ready';
    internals.pipe = pipeImpl;
  }

  it('a hung transformers.js pipe() call converts into a job error instead of hanging', async () => {
    const tts = new TTSEngine();
    installPipeStub(tts, () => new Promise(() => {
      /* never settles — wedged transformers.js inference */
    }));

    const job = tts.enqueue('main thread hang', { modelId: 'speecht5' });
    await vi.advanceTimersByTimeAsync(10);
    expect(tts.getJobs().find(j => j.id === job.id)?.status).toBe('generating');

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUTS.generate + 1000);

    const finished = tts.getJobs().find(j => j.id === job.id)!;
    expect(finished.status).toBe('error');
    expect(finished.error).toMatch(/Generation timed out/);
    expect((finished.error ?? '')).toMatch(/Try shorter text or reload the model\./);
  });

  it('a resolving pipe() still completes normally under the watchdog', async () => {
    const tts = new TTSEngine();
    installPipeStub(tts, () => Promise.resolve({
      audio: new Float32Array(160),
      sampling_rate: 16000,
    }));

    const job = tts.enqueue('normal speech', { modelId: 'speecht5' });
    await vi.advanceTimersByTimeAsync(50);
    const finished = tts.getJobs().find(j => j.id === job.id)!;
    expect(finished.status).toBe('done');
    expect(finished.sampleRate).toBe(16000);
  });
});
