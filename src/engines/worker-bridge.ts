import type { CustomEngine, TTSModel } from '../engine';
import { KOKORO_MODEL_ID } from './kokoro';

export type WorkerRequest =
  | { id: number; type: 'load'; model: TTSModel }
  | { id: number; type: 'generate'; model: TTSModel; voiceId?: string; text: string; speed?: number }
  | { id: number; type: 'dispose' };

export type WorkerResponse =
  | { id: number; type: 'progress'; loaded: number; total: number }
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
};

export class WorkerBackedEngine implements CustomEngine {
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  /** Serialize outgoing requests so the worker never sees overlapping generate/load. */
  private chain: Promise<void> = Promise.resolve();
  private readonly workerFactory: () => WorkerLike;

  constructor(workerFactory: () => WorkerLike = () => new Worker(
    new URL('./inference-worker.ts', import.meta.url),
    { type: 'module' },
  )) {
    this.workerFactory = workerFactory;
  }

  async load(model: TTSModel, progressCallback?: (loaded: number, total: number) => void): Promise<{ sampleRate: number }> {
    if (this.worker) this.dispose();
    const worker = this.workerFactory();
    this.worker = worker;
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    const response = await this.request(createLoadRequest(model), progressCallback);
    if (response.type !== 'loaded') throw new Error(`Unexpected worker response: ${response.type}`);
    return { sampleRate: response.sampleRate };
  }

  async generate(
    model: TTSModel,
    voiceId: string | undefined,
    text: string,
    options?: { speed?: number },
  ): Promise<{ audio: Float32Array; samplingRate: number; wordTimings?: number[] }> {
    const response = await this.request(createGenerateRequest(model, voiceId, text, options?.speed));
    if (response.type !== 'generated') throw new Error(`Unexpected worker response: ${response.type}`);
    // Normalize in case the worker transferred a plain ArrayBuffer view oddly.
    const audio = response.audio instanceof Float32Array
      ? response.audio
      : new Float32Array(response.audio as unknown as ArrayBuffer);
    return { audio, samplingRate: response.samplingRate, wordTimings: response.wordTimings };
  }

  dispose(): void {
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

  private request(
    message: WorkerRequest,
    progressCallback?: (loaded: number, total: number) => void,
  ): Promise<WorkerResponse> {
    if (!this.worker) return Promise.reject(new Error('Inference worker is not available'));

    const run = (): Promise<WorkerResponse> => new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Inference worker is not available'));
        return;
      }
      this.pending.set(message.id, { resolve, reject, progress: progressCallback });
      this.worker.postMessage(message);
    });

    // Chain so concurrent generate() calls from the queue don't overlap on one worker.
    const result = this.chain.then(run, run);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
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
