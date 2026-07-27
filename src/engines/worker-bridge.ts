import type { CustomEngine, TTSModel } from '../engine';

export type WorkerRequest =
  | { type: 'load'; model: TTSModel }
  | { type: 'generate'; model: TTSModel; voiceId?: string; text: string; speed?: number }
  | { type: 'dispose' };

export type WorkerResponse =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'loaded'; sampleRate: number }
  | { type: 'generated'; audio: Float32Array; samplingRate: number; wordTimings?: number[] }
  | { type: 'disposed' }
  | { type: 'error'; message: string };

export function createLoadRequest(model: TTSModel): WorkerRequest {
  return { type: 'load', model };
}

export function createGenerateRequest(model: TTSModel, voiceId: string | undefined, text: string, speed?: number): WorkerRequest {
  return { type: 'generate', model, voiceId, text, speed };
}

export function createDisposeRequest(): WorkerRequest {
  return { type: 'dispose' };
}

type WorkerLike = {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent | ErrorEvent) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent | ErrorEvent) => void): void;
  terminate(): void;
};

export class WorkerBackedEngine implements CustomEngine {
  private worker: WorkerLike | null = null;
  private pending: ((response: WorkerResponse) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
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

  async generate(model: TTSModel, voiceId: string | undefined, text: string, options?: { speed?: number }): Promise<{ audio: Float32Array; samplingRate: number; wordTimings?: number[] }> {
    const response = await this.request(createGenerateRequest(model, voiceId, text, options?.speed));
    if (response.type !== 'generated') throw new Error(`Unexpected worker response: ${response.type}`);
    return response;
  }

  dispose(): void {
    if (!this.worker) return;
    this.worker.postMessage(createDisposeRequest());
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.terminate();
    this.worker = null;
    this.rejectPending(new Error('Worker disposed'));
  }

  private request(message: WorkerRequest, progressCallback?: (loaded: number, total: number) => void): Promise<WorkerResponse> {
    if (!this.worker) return Promise.reject(new Error('Inference worker is not available'));
    if (this.pending) return Promise.reject(new Error('Inference worker request already pending'));
    return new Promise((resolve, reject) => {
      this.pending = (response) => {
        if (response.type === 'progress') progressCallback?.(response.loaded, response.total);
        else { this.pending = null; this.pendingReject = null; response.type === 'error' ? reject(new Error(response.message)) : resolve(response); }
      };
      this.pendingReject = reject;
      const transfer = message.type === 'generate' ? [] : undefined;
      this.worker!.postMessage(message, transfer);
    });
  }

  private readonly onMessage = (event: MessageEvent | ErrorEvent) => {
    if ('data' in event) this.pending?.(event.data as WorkerResponse);
  };
  private readonly onError = (event: MessageEvent | ErrorEvent) => {
    this.rejectPending(new Error('message' in event ? event.message : String(event.data)));
  };
  private rejectPending(error: Error) { const reject = this.pendingReject; this.pending = null; this.pendingReject = null; reject?.(error); }
}
