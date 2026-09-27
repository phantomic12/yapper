// ─── Persistence ─────────────────────────────────────────────────
// Two stores with different lifecycles:
//
//   * localStorage  — settings + draft text. Small, synchronous, and the
//     draft must survive even if the tab dies mid-write.
//   * IndexedDB     — the job history, including finished audio blobs.
//     WAV blobs are far too large for localStorage (a few minutes of
//     audio blows past the ~5MB quota), and we don't want quota errors
//     to lose a day of generated speech.
//
// Everything here is best-effort: a private browser, a full quota, or a
// denied IndexedDB open must never break generation. Failures are
// swallowed; the app simply starts fresh.

import type { GenerationJob } from './engine';

// ─── Settings (localStorage) ─────────────────────────────────────

const SETTINGS_KEY = 'yapper.settings.v1';

export interface PersistedSettings {
  modelId: string;
  voiceId?: string;
  speed: number;
  draftText: string;
  languageFilter: string;
}

export function loadSettings(): Partial<PersistedSettings> | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Partial<PersistedSettings>) : null;
  } catch {
    return null;
  }
}

export function saveSettings(settings: PersistedSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Quota / private mode — persistence is best-effort.
  }
}

// ─── Job records (pure mapping, unit-tested) ─────────────────────

export interface StoredJob {
  id: string;
  text: string;
  voiceId?: string;
  voiceName?: string;
  customSpeakerEmbeddings?: string;
  modelId: string;
  modelName: string;
  speed: number;
  /** 'generating' is stored as 'pending' so a reload resumes the job. */
  status: 'pending' | 'done' | 'error' | 'cancelled';
  error?: string;
  createdAt: number;
  completedAt?: number;
  durationMs?: number;
  sampleRate?: number;
  /** Float32 PCM copy — kept so "Download all" works after a reload. */
  audio?: ArrayBuffer;
  /** The encoded WAV. Blob round-trips natively through IndexedDB. */
  blob?: Blob;
  readerSessionId?: string;
  readerIndex?: number;
}

export function jobToRecord(job: GenerationJob): StoredJob | null {
  // In-flight jobs are persisted as pending: if the tab dies mid-generation
  // the job resumes on the next visit instead of vanishing.
  const status = job.status === 'generating' ? 'pending' : job.status;
  return {
    id: job.id,
    text: job.text,
    voiceId: job.voiceId,
    voiceName: job.voiceName,
    customSpeakerEmbeddings: job.customSpeakerEmbeddings,
    modelId: job.modelId,
    modelName: job.modelName,
    speed: job.speed,
    status,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    durationMs: job.durationMs,
    sampleRate: job.sampleRate,
    // Copy the PCM: the live buffer may be a transferred view we don't own.
    audio: job.audio ? job.audio.slice().buffer : undefined,
    blob: job.status === 'done' ? job.blob : undefined,
    readerSessionId: job.readerSessionId,
    readerIndex: job.readerIndex,
  };
}

export function recordToJob(record: StoredJob): GenerationJob {
  return {
    id: record.id,
    text: record.text,
    voiceId: record.voiceId,
    voiceName: record.voiceName,
    customSpeakerEmbeddings: record.customSpeakerEmbeddings,
    modelId: record.modelId,
    modelName: record.modelName,
    speed: record.speed,
    status: record.status,
    error: record.error,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    sampleRate: record.sampleRate,
    audio: record.audio ? new Float32Array(record.audio) : undefined,
    blob: record.blob,
    readerSessionId: record.readerSessionId,
    readerIndex: record.readerIndex,
  };
}

// ─── Job store (IndexedDB) ───────────────────────────────────────

const DB_NAME = 'yapper';
const DB_VERSION = 1;
const JOB_STORE = 'jobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(JOB_STORE)) {
        db.createObjectStore(JOB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/**
 * Full sync of the job list into IndexedDB: upserts every current job and
 * deletes records whose jobs are gone (e.g. after "Clear finished", or
 * because the storage budget trimmed the oldest clips).
 *
 * Best-effort by design — see the module header. In particular a quota
 * error is retried once with a halved budget, because the alternative is
 * losing the clip the user just spent a minute generating.
 */
export async function persistJobs(
  jobs: GenerationJob[],
  budget: StorageBudget = DEFAULT_STORAGE_BUDGET,
): Promise<void> {
  const attempt = async (b: StorageBudget): Promise<void> => {
    const selected = selectJobsWithinBudget(jobs, b);
    const records = selected
      .map(jobToRecord)
      .filter((r): r is StoredJob => r !== null);
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(JOB_STORE, 'readwrite');
        const store = tx.objectStore(JOB_STORE);
        for (const record of records) store.put(record);
        // Delete ids that are no longer present.
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = () => {
          const keep = new Set(records.map(r => r.id));
          for (const key of keysReq.result) {
            if (!keep.has(String(key))) store.delete(key);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
      });
    } finally {
      db.close();
    }
  };

  try {
    await attempt(budget);
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    // Halve and retry. Two halvings free enough room for almost any real
    // history; past that the origin quota is simply too small to keep audio
    // and dropping the write is the only option left.
    await attempt({ maxJobs: Math.max(1, Math.floor(budget.maxJobs / 2)), maxBytes: Math.floor(budget.maxBytes / 2) })
      .catch(() => undefined);
  }
}

/**
 * How much of the origin's storage this app is using, when the browser will
 * tell us. Returns null where StorageManager.estimate() is unavailable.
 */
export async function readStorageUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    const storage = navigator.storage;
    if (!storage?.estimate) return null;
    const est = await storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}

/** Load all persisted jobs, oldest-first (ready for engine.restoreJobs). */
export async function restoreJobsFromStore(): Promise<GenerationJob[]> {
  const db = await openDb();
  try {
    const records = await new Promise<StoredJob[]>((resolve, reject) => {
      const tx = db.transaction(JOB_STORE, 'readonly');
      const req = tx.objectStore(JOB_STORE).getAll();
      req.onsuccess = () => resolve(req.result as StoredJob[]);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
    });
    return records
      .map(recordToJob)
      .sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    db.close();
  }
}

// ─── Storage budget ───────────────────────────────────────────────
// Persisting every clip forever is a slow failure: audio blobs are
// megabytes each, the origin quota is finite, and once it is hit the
// *newest* writes start failing — which is exactly when the user is
// generating something they want to keep. So the store is trimmed to a
// budget, oldest-audio-first, and a quota error triggers a second,
// smaller attempt rather than silently dropping the write.

export interface StorageBudget {
  /** Cap on how many jobs carry audio. */
  maxJobs: number;
  /** Cap on approximate stored bytes. */
  maxBytes: number;
}

export const DEFAULT_STORAGE_BUDGET: StorageBudget = {
  // 24 clips of a few seconds each is a couple of hours of listening; the
  // byte cap is the real limit and the job cap just stops a pathological
  // list of tiny clips from growing without bound.
  maxJobs: 24,
  maxBytes: 64 * 1024 * 1024,
};

/** Approximate stored size of a job, preferring the encoded blob's own size. */
export function estimateJobBytes(job: GenerationJob): number {
  if (job.blob?.size) return job.blob.size;
  if (job.audio) return job.audio.byteLength;
  // Text-only jobs (pending / errored) are a few hundred bytes.
  return 512;
}

const isUnfinished = (job: GenerationJob): boolean =>
  job.status === 'pending' || job.status === 'generating';

/**
 * Choose which jobs to persist under a budget.
 *
 * Unfinished jobs are always kept regardless of the budget: dropping a
 * queued or in-flight job to save bytes would silently discard work the
 * user asked for, and they carry no audio anyway. Among the rest, the
 * newest are kept and the oldest audio is dropped first.
 */
export function selectJobsWithinBudget(
  jobs: GenerationJob[],
  budget: StorageBudget = DEFAULT_STORAGE_BUDGET,
): GenerationJob[] {
  const unfinished = jobs.filter(isUnfinished);
  const finished = jobs
    .filter(j => !isUnfinished(j))
    .sort((a, b) => b.createdAt - a.createdAt); // newest first

  const kept: GenerationJob[] = [];
  let bytes = 0;
  for (const job of finished) {
    if (kept.length >= budget.maxJobs) break;
    const size = estimateJobBytes(job);
    // A single clip larger than the whole budget still gets kept when the
    // store is empty — otherwise a long generation could never persist.
    if (bytes + size > budget.maxBytes && kept.length > 0) break;
    kept.push(job);
    bytes += size;
  }

  return [...unfinished, ...kept].sort((a, b) => a.createdAt - b.createdAt);
}

/** Total approximate bytes across a job list. */
export function totalEstimatedBytes(jobs: GenerationJob[]): number {
  return jobs.reduce((sum, job) => sum + estimateJobBytes(job), 0);
}

/** Human-readable size for the queue footer (e.g. "4.2 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name ?? '';
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || (err as { code?: number }).code === 22;
}

export { isQuotaError };
