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
 * deletes records whose jobs are gone (e.g. after "Clear finished").
 */
export async function persistJobs(jobs: GenerationJob[]): Promise<void> {
  const records = jobs
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
    });
  } finally {
    db.close();
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
