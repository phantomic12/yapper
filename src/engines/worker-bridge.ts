import type { CustomEngine, SegmentProgressCallback, TTSModel } from '../engine';
import { KOKORO_MODEL_ID } from './kokoro';
import { REQUEST_TIMEOUTS, TimeoutError, type WatchableRequestType } from './timeouts';

export type WorkerRequest =
  | { id: number; type: 'load'; model: TTSModel }
  | { id: number; type: 'generate'; model: TTSModel; voiceId?: string; text: string; speed?: number }
  | { id: number; type: 'dispose' };

export type WorkerResponse =
  | { id: number; type: 'progress'; loaded: number; total: number }
  | {
      /** Mid-generation segment progress (e.g. Kokoro sentences). */
      id: number;
      type: 'generate-progress';
      segmentsDone: number;
      segmentsTotal?: number;
      audioSecondsSoFar?: number;
    }
  | { id: number; type: 'loaded'; sampleRate: number }
  | { id: number; type: 'generated'; audio: Float32Array; samplingRate: number; wordTimings?: number[] }
  | { id: number; type: 'disposed' }
  | { id: number; type: 'error'; message: string };

let nextRequestId = 1;

export function createLoadRequest(model: TTSModel): WorkerRequest {
  return { id: nextRequestId++, type: 'load', model };
}

export function createGenerateRequest(
  model: TTSModel,
  voiceId: string | undefined,
  text: string,
  speed?: number,
): WorkerRequest {
  return { id: nextRequestId++, type: 'generate', model, voiceId, text, speed };
}

export function createDisposeRequest(): WorkerRequest {
  return { id: nextRequestId++, type: 'dispose' };
}

/** Pick which custom engine the inference worker should instantiate. */
export function selectWorkerEngineKind(modelId: string): 'kokoro' | 'kitten' {
  if (modelId === KOKORO_MODEL_ID || modelId.toLowerCase().includes('kokoro')) {
    return 'kokoro';
  }
  return 'kitten';
}

type WorkerLike = {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent | ErrorEvent) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent | ErrorEvent) => void): void;
  terminate(): void;
};

type Pending = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  progress?: (loaded: number, total: number) => void;
  /** Mid-generation segment progress (see `generate`). */
  segmentProgress?: SegmentProgressCallback;
};

/**
 * Which engine kind this bridge drives. Derived from the first load() it sees;
 * only used to stamp TimeoutError.engineKind for diagnostics.
 */
type EngineKind = 'kokoro' | 'kitten' | 'unknown';

// ─── Hang watchdog ───────────────────────────────────────────────
//
// request() used to post and wait forever. That was the app's true
// infinite-stuck path: a hung WebGPU / ORT call fires NO worker 'error'
// event, so nothing ever rejected the pending promise and the job sat in
// 'generating' until the tab was closed. Every request now carries a
// per-type wall-clock bound (see src/engines/timeouts.ts):
//
//   load     300s  — big fp32 models on slow links still fit comfortably
//   generate 180s  — generations are seconds-scale; 3 min is generous
//   dispose  10s   — dispose is synchronous here (postMessage + terminate),
//                    so its effective bound is ~0s; the entry documents the
//                    ceiling should dispose ever gain an awaited handshake
//
// On expiry the pending request rejects with a typed TimeoutError and —
// critically — the wedged worker is terminated immediately and a fresh one
// is created LAZILY by the next load()/generate() via this.workerFactory.
// A hung WebGPU session cannot be un-wedged in place (the driver call never
// returns), so tearing down the thread is the only reliable recovery; lazy
// respawn keeps the cost off the timeout path itself.

export class WorkerBackedEngine implements CustomEngine {
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  /** Serialize outgoing requests so the worker never sees overlapping generate/load. */
  private chain: Promise<void> = Promise.resolve();
  private readonly workerFactory: () => WorkerLike;
  private readonly timeouts: typeof REQUEST_TIMEOUTS;
  private engineKind: EngineKind = 'unknown';
  /**
   * Model of the last successful load. After a watchdog kill (or a
   * cancel-mid-generate teardown) the replacement worker starts with an empty
   * session, so `generate()` silently re-runs this load on the fresh worker
   * before generating — the caller sees one working generate, not a follow-up
   * "engine not loaded" failure.
   */
  private loadedModel: TTSModel | null = null;

  constructor(
    workerFactory: () => WorkerLike = () => new Worker(
      new URL('./inference-worker.ts', import.meta.url),
      { type: 'module' },
    ),
    timeouts: typeof REQUEST_TIMEOUTS = REQUEST_TIMEOUTS,
  ) {
    this.workerFactory = workerFactory;
    this.timeouts = timeouts;
  }

  async load(model: TTSModel, progressCallback?: (loaded: number, total: number) => void): Promise<{ sampleRate: number }> {
    const sampleRate = await this.loadOnFreshWorker(model, progressCallback);
    // Remember what's resident in the worker so post-stall respawns can
    // restore it without a user-visible reload step.
    this.loadedModel = model;
    return { sampleRate };
  }

  /**
   * Spawn a brand-new worker and load `model` into it, discarding any prior
   * worker. Used by both the public load() path and the lazy respawn inside
   * generate() after a watchdog kill / cancel teardown.
   */
  private async loadOnFreshWorker(
    model: TTSModel,
    progressCallback?: (loaded: number, total: number) => void,
  ): Promise<number> {
    if (this.worker) this.dispose();
    const worker = this.workerFactory();
    this.worker = worker;
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    this.engineKind = selectWorkerEngineKind(model.modelId);
    const response = await this.request(createLoadRequest(model), progressCallback);
    if (response.type !== 'loaded') throw new Error(`Unexpected worker response: ${response.type}`);
    return response.sampleRate;
  }

  async generate(
    model: TTSModel,
    voiceId: string | undefined,
    text: string,
    options?: { speed?: number; onSegmentProgress?: SegmentProgressCallback },
  ): Promise<{ audio: Float32Array; samplingRate: number; wordTimings?: number[] }> {
    if (!this.worker) {
      // Lazy respawn after a watchdog termination or cancel teardown: build a
      // fresh worker and restore the model it should be running. The model is
      // already in browser cache at this point, so this is seconds, not the
      // original multi-minute download. The next request then proceeds on a
      // clean GPU/ORT context instead of failing with "worker not available".
      await this.loadOnFreshWorker(this.loadedModel ?? model);
      this.loadedModel = this.loadedModel ?? model;
    }
    const response = await this.request(
      createGenerateRequest(model, voiceId, text, options?.speed),
      undefined,
      options?.onSegmentProgress,
    );
    if (response.type !== 'generated') throw new Error(`Unexpected worker response: ${response.type}`);
    // Normalize in case the worker transferred a plain ArrayBuffer view oddly.
    const audio = response.audio instanceof Float32Array
      ? response.audio
      : new Float32Array(response.audio as unknown as ArrayBuffer);
    return { audio, samplingRate: response.samplingRate, wordTimings: response.wordTimings };
  }

  dispose(): void {
    // Dispose is deliberately synchronous: postMessage + terminate cannot
    // hang, so no watchdog arm is needed here despite the 'dispose' entry in
    // the timeout table (see REQUEST_TIMEOUTS.dispose).
    if (!this.worker) {
      this.rejectAll(new Error('Worker disposed'));
      return;
    }
    try {
      this.worker.postMessage(createDisposeRequest());
    } catch {
      // Worker may already be gone.
    }
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.terminate();
    this.worker = null;
    this.rejectAll(new Error('Worker disposed'));
  }

  /**
   * Cancel an in-flight generate immediately instead of waiting for it.
   *
   * The queue's cancel() flips job status but historically kept awaiting the
   * straggler — with a hung engine that meant "cancel" changed nothing and
   * the queue stayed blocked on the dead request. This rejects the pending
   * request NOW, disposes the whole worker session (a half-finished ORT
   * session isn't safe to reuse), and lets the next load/generate lazily
   * spawn a fresh worker so different-model work can proceed right away.
   */
  cancelActiveGenerate(): void {
    for (const slot of [...this.pending.values()]) {
      // Reject everything outstanding. The serialized request chain means at
      // most one generate can be in flight; rejecting all is safe and simple.
      slot.reject(new Error('Generation cancelled'));
    }
    this.pending.clear();
    if (this.worker) {
      this.dispose();
    }
  }

  private request(
    message: WorkerRequest,
    progressCallback?: (loaded: number, total: number) => void,
    segmentProgressCallback?: SegmentProgressCallback,
  ): Promise<WorkerResponse> {
    if (!this.worker) return Promise.reject(new Error('Inference worker is not available'));

    const run = (): Promise<WorkerResponse> => new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Inference worker is not available'));
        return;
      }
      // Arm the per-type watchdog. Whichever settles first — a worker
      // response or the timer — disarms the other, so no leak either way.
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.onRequestTimeout(message.type, startedAt);
      }, this.timeoutFor(message.type));
      this.pending.set(message.id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        progress: progressCallback,
        segmentProgress: segmentProgressCallback,
      });
      this.worker.postMessage(message);
    });

    // Chain so concurrent generate() calls from the queue don't overlap on one worker.
    const result = this.chain.then(run, run);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private timeoutFor(type: WatchableRequestType): number {
    switch (type) {
      case 'load': return this.timeouts.load;
      case 'generate': return this.timeouts.generate;
      case 'dispose': return this.timeouts.dispose;
    }
  }

  /**
   * Watchdog expiry handler. Rejects every outstanding request of this
   * bridge with a typed TimeoutError carrying elapsedMs + engine kind, then
   * terminates the wedged worker WITHOUT respawning synchronously: the next
   * load()/generate() creates a fresh worker through workerFactory, so the
   * NEXT job starts clean instead of inheriting a poisoned GPU context.
   */
  private onRequestTimeout(requestType: WatchableRequestType | 'generate', startedAt: number): void {
    const elapsedMs = Date.now() - startedAt;
    const seconds = Math.round(elapsedMs / 1000);
    const label = requestType === 'generate' ? 'Generation' : `${requestType[0].toUpperCase()}${requestType.slice(1)}`;
    const error = new TimeoutError(
      `${label} timed out after ${seconds}s`,
      { elapsedMs, engineKind: this.engineKind, requestType },
    );
    this.rejectAll(error);
    if (this.worker) {
      // Terminate the hung thread. Listeners are removed first so the
      // terminate doesn't fire onError into already-rejected slots.
      this.worker.removeEventListener('message', this.onMessage);
      this.worker.removeEventListener('error', this.onError);
      this.worker.terminate();
      this.worker = null; // Lazily recreated by the next request via workerFactory.
    }
  }

  private readonly onMessage = (event: MessageEvent | ErrorEvent) => {
    if (!('data' in event)) return;
    const response = event.data as WorkerResponse;
    if (!response || typeof response !== 'object' || typeof response.id !== 'number') return;
    const slot = this.pending.get(response.id);
    if (!slot) return;
    if (response.type === 'progress') {
      slot.progress?.(response.loaded, response.total);
      return;
    }
    // Mid-generation segment progress: routed to the pending slot like load
    // progress, but does NOT settle the request — the final 'generated'
    // message still resolves it.
    if (response.type === 'generate-progress') {
      slot.segmentProgress?.({
        segmentsDone: response.segmentsDone,
        segmentsTotal: response.segmentsTotal,
        audioSecondsSoFar: response.audioSecondsSoFar,
      });
      return;
    }
    this.pending.delete(response.id);
    if (response.type === 'error') slot.reject(new Error(response.message));
    else slot.resolve(response);
  };

  private readonly onError = (event: MessageEvent | ErrorEvent) => {
    const message = 'message' in event ? event.message : String((event as MessageEvent).data);
    this.rejectAll(new Error(message || 'Inference worker error'));
  };

  private rejectAll(error: Error) {
    const slots = [...this.pending.values()];
    this.pending.clear();
    for (const slot of slots) slot.reject(error);
  }
}
