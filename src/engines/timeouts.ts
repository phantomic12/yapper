/**
 * Hang-watchdog configuration shared by the worker bridge and the main-thread
 * engine paths.
 *
 * Why this exists: a hung WebGPU / ONNX Runtime call fires NO 'error' event —
 * the surrounding promise simply never settles (an ORT-web issue class; some
 * drivers hang rather than throw on adapter loss). Without a watchdog, a job
 * sticks in 'generating' forever and the queue refuses all further work. Every
 * inference-layer request therefore gets a hard wall-clock bound; on expiry the
 * caller sees a typed `TimeoutError` and the backing worker/session is torn
 * down so the NEXT request starts fresh.
 */

/** The request kinds the worker protocol carries. */
export type WatchableRequestType = 'load' | 'generate' | 'dispose';

export interface RequestTimeouts {
  /** Model download + ONNX session creation (large fp32 models on slow links). */
  load: number;
  /** One generate() call. Generations are seconds-scale; 3 minutes is generous. */
  generate: number;
  /**
   * Grace period reserved for a dispose handshake, kept for completeness of
   * the per-type table. The bridge's dispose() is deliberately synchronous —
   * postMessage + terminate() are unconditional and cannot hang — so its
   * effective bound is ~0s, well inside this budget. The entry documents the
   * intended ceiling if dispose ever grows an awaited acknowledgement path.
   */
  dispose: number;
}

/** Default per-type bounds (ms). Overridable per-instance for tests/tuning. */
export const REQUEST_TIMEOUTS: Readonly<RequestTimeouts> = {
  load: 300_000,
  generate: 180_000,
  dispose: 10_000,
};

/** No-progress window before a model download is declared network-stalled. */
export const LOAD_STALL_TIMEOUT_MS = 15_000;

/**
 * Typed stall error. Carries how long the request ran before giving up and
 * which engine produced it, so callers (queue UI, logs) can render precise,
 * actionable messages instead of a generic failure.
 */
export class TimeoutError extends Error {
  readonly elapsedMs: number;
  readonly engineKind: string;
  readonly requestType: WatchableRequestType | 'generate';

  constructor(
    message: string,
    details: { elapsedMs: number; engineKind: string; requestType: WatchableRequestType | 'generate' },
  ) {
    super(message);
    this.name = 'TimeoutError';
    this.elapsedMs = details.elapsedMs;
    this.engineKind = details.engineKind;
    this.requestType = details.requestType;
  }
}

/** Internal sentinel: a load was aborted because the user asked for a retry. */
export class LoadAbortedError extends Error {
  constructor() {
    super('Load aborted for retry');
    this.name = 'LoadAbortedError';
  }
}

/**
 * Human-facing message stamped on a job when its generation hits the
 * watchdog bound. Wording is part of the contract surfaced in the queue UI.
 */
export function formatGenerateTimeout(elapsedMs: number): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  return `Generation timed out after ${seconds}s. Try shorter text or reload the model.`;
}
