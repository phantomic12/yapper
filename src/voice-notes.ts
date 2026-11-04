/**
 * Voice notes: a few seconds of the reader's own voice, pinned to a place in
 * the document.
 *
 * Blobs live in IndexedDB, not localStorage — this is the same split
 * `persistence.ts` documents for generated audio. A minute of Opus is a few
 * hundred kilobytes, an order of magnitude past what a localStorage origin
 * will take, and a quota error there is a synchronous throw in the middle of
 * a save. IndexedDB stores the recorded Blob itself, so playback after a
 * reload does not have to re-encode anything.
 *
 * A separate database, deliberately. IndexedDB versions are per database, and
 * bumping the job store's version from a second module would lock out a tab
 * still running the older schema — for a feature the job store knows nothing
 * about. `yapper-voice-notes` can evolve on its own.
 *
 * Everything here degrades: no microphone, no MediaRecorder, no IndexedDB, or
 * a denied permission all return a reason a person can read. None of them
 * throw at the caller, because a study tool that breaks the page when the
 * microphone is missing is worse than one that says it is missing.
 */

export interface VoiceNote {
  id: string;
  /** Character offset into the document text the note hangs off. */
  offset: number;
  /** Length of the recording in milliseconds, as measured while recording. */
  durationMs: number;
  mimeType: string;
  createdAt: number;
  /** The audio itself. IndexedDB round-trips it natively. */
  blob: Blob;
}

/** A note as stored: the same record plus the document it belongs to. */
export interface VoiceNoteRecord extends VoiceNote {
  documentKey: string;
}

const DB_NAME = 'yapper-voice-notes';
const DB_VERSION = 1;
const STORE_NAME = 'voice-notes';
const DOCUMENT_INDEX = 'documentKey';
const MAX_NOTES_PER_DOCUMENT = 200;

/** Long enough for a spoken paragraph, short enough not to fill the quota. */
export const MAX_VOICE_NOTE_MS = 120_000;

export function newVoiceNoteId(now = Date.now(), random = Math.random): string {
  return `${now.toString(36)}-${random().toString(36).slice(2, 8)}`;
}

/** `0:07`, `1:05` — the shape a voice memo shows its length in. */
export function formatNoteDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ─── Recorder capability (pure) ──────────────────────────────────

/** The slice of MediaRecorder this module uses, so tests can supply their own. */
export interface RecorderLike {
  readonly mimeType?: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface RecorderEnvironment {
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  createRecorder?: ((stream: MediaStream, mimeType: string) => RecorderLike) | null;
  isTypeSupported?: ((type: string) => boolean) | null;
  now?: () => number;
}

export interface RecorderSupport {
  canRecord: boolean;
  /** Why not, in words a reader can act on. Empty when recording is possible. */
  reason: string;
}

/**
 * Whether this environment can record at all.
 *
 * Checked before the Record button is offered, not after it is pressed: an
 * enabled button that can only fail is a lie about what the page can do.
 */
export function recorderSupport(env: RecorderEnvironment): RecorderSupport {
  if (!env.getUserMedia) {
    return { canRecord: false, reason: 'This browser cannot record audio: it has no microphone API.' };
  }
  if (!env.createRecorder) {
    return { canRecord: false, reason: 'This browser cannot record audio: MediaRecorder is not available.' };
  }
  return { canRecord: true, reason: '' };
}

/** Formats a recorder may produce, best first. Empty when nothing is supported. */
export const RECORDING_MIME_TYPES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function pickRecordingMimeType(
  isTypeSupported: ((type: string) => boolean) | null | undefined,
): string {
  if (!isTypeSupported) return '';
  return RECORDING_MIME_TYPES.find(type => isTypeSupported(type)) ?? '';
}

/** A getUserMedia rejection, said in terms the reader can do something about. */
export function recorderErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'Microphone access was blocked — allow it for this page to record a note.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is busy in another app.';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message
    ? `Could not start recording: ${message}`
    : 'Could not start recording.';
}

/** The browser's real recorder, wired behind the interface above. */
export function browserRecorderEnvironment(): RecorderEnvironment {
  const devices = typeof navigator === 'undefined' ? null : navigator.mediaDevices;
  const Ctor = typeof MediaRecorder === 'undefined' ? null : MediaRecorder;
  return {
    getUserMedia: devices?.getUserMedia
      ? constraints => devices.getUserMedia(constraints)
      : null,
    // The cast is only about handler parameter types: MediaRecorder's
    // `ondataavailable` is declared with a BlobEvent, ours with the one field
    // this module reads. The runtime object is the same recorder.
    createRecorder: Ctor
      ? (stream, mimeType) => new Ctor(stream, mimeType ? { mimeType } : undefined) as unknown as RecorderLike
      : null,
    isTypeSupported: Ctor?.isTypeSupported ? type => Ctor.isTypeSupported(type) : null,
    now: () => Date.now(),
  };
}

export type RecorderStart = { ok: true } | { ok: false; reason: string };
export type RecorderStop = { ok: true; note: VoiceNote } | { ok: false; reason: string };

/**
 * One recording at a time, with the microphone released as soon as it ends.
 *
 * `release()` stops the stream tracks rather than only dropping the reference:
 * browsers keep the microphone indicator (and the device busy) alive for as
 * long as a track is live, so a forgotten stop looks like the app is still
 * listening.
 */
export class VoiceNoteRecorder {
  private readonly env: RecorderEnvironment;
  private recorder: RecorderLike | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private selectedMimeType = '';

  constructor(env: RecorderEnvironment = browserRecorderEnvironment()) {
    this.env = env;
  }

  get support(): RecorderSupport {
    return recorderSupport(this.env);
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  private now(): number {
    return this.env.now ? this.env.now() : Date.now();
  }

  elapsedMs(): number {
    return this.recorder ? Math.max(0, this.now() - this.startedAt) : 0;
  }

  async start(): Promise<RecorderStart> {
    const support = this.support;
    if (!support.canRecord) return { ok: false, reason: support.reason };
    if (this.recorder) return { ok: true };

    const getUserMedia = this.env.getUserMedia;
    const createRecorder = this.env.createRecorder;
    if (!getUserMedia || !createRecorder) return { ok: false, reason: support.reason };

    let stream: MediaStream;
    try {
      stream = await getUserMedia({ audio: true });
    } catch (error) {
      return { ok: false, reason: recorderErrorMessage(error) };
    }

    const mimeType = pickRecordingMimeType(this.env.isTypeSupported ?? null);
    let recorder: RecorderLike;
    try {
      recorder = createRecorder(stream, mimeType);
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      return { ok: false, reason: recorderErrorMessage(error) };
    }

    this.recorder = recorder;
    this.stream = stream;
    this.chunks = [];
    this.selectedMimeType = mimeType;
    this.startedAt = this.now();
    recorder.ondataavailable = event => {
      // A zero-byte chunk is the recorder's own "nothing yet", not audio.
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    try {
      // A timeslice keeps chunks arriving during the recording: if the tab is
      // closed mid-note, everything up to the last tick can still be salvaged.
      recorder.start(250);
    } catch (error) {
      this.release();
      return { ok: false, reason: recorderErrorMessage(error) };
    }
    return { ok: true };
  }

  stop(offset: number): Promise<RecorderStop> {
    const recorder = this.recorder;
    if (!recorder) return Promise.resolve({ ok: false, reason: 'Nothing is being recorded.' });
    const durationMs = this.elapsedMs();

    return new Promise<RecorderStop>(resolve => {
      let settled = false;
      const release = (): void => this.release();
      // A recorder that never fires `onstop` would leave the rail stuck on
      // "finishing" forever, so the wait is bounded. Two seconds is well past
      // the flush a real MediaRecorder needs.
      const guard = setTimeout(() => {
        finish({ ok: false, reason: 'The recorder did not finish — the note was not saved.' });
      }, 2_000);
      function finish(result: RecorderStop): void {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        release();
        resolve(result);
      }
      recorder.onstop = () => {
        if (settled) return;
        const type = recorder.mimeType || this.selectedMimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        if (blob.size === 0) {
          finish({ ok: false, reason: 'The recording came back empty — check that a microphone is connected.' });
          return;
        }
        finish({
          ok: true,
          note: {
            id: newVoiceNoteId(),
            offset: Math.max(0, Math.floor(offset)),
            durationMs,
            mimeType: blob.type || type,
            createdAt: this.now(),
            blob,
          },
        });
      };
      recorder.onerror = () => finish({ ok: false, reason: 'Recording failed before it could be saved.' });
      try {
        recorder.stop();
      } catch (error) {
        finish({ ok: false, reason: recorderErrorMessage(error) });
      }
    });
  }

  /** Abandon the take and release the microphone; nothing is saved. */
  cancel(): void {
    const recorder = this.recorder;
    if (!recorder) return;
    recorder.onstop = null;
    recorder.ondataavailable = null;
    this.release();
    try {
      recorder.stop();
    } catch {
      // Already stopped — the release above is what mattered.
    }
  }

  private release(): void {
    this.recorder = null;
    this.chunks = [];
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks?.().forEach(track => track.stop());
  }
}

// ─── IndexedDB store ─────────────────────────────────────────────

function openVoiceNoteDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex(DOCUMENT_INDEX, 'documentKey', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

/**
 * Validate a record read back from storage.
 *
 * The store is per browser profile and survives app updates, so a record can
 * be from an older build or half-written. A note without a Blob is dropped:
 * it would render as a play button that cannot play.
 */
export function normalizeVoiceNote(value: unknown): VoiceNoteRecord | null {
  const entry = value as Partial<VoiceNoteRecord> | null;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.documentKey !== 'string' || !entry.documentKey) return null;
  if (typeof entry.id !== 'string' || !entry.id) return null;
  if (!Number.isFinite(entry.offset) || (entry.offset ?? -1) < 0) return null;
  if (typeof Blob === 'undefined' || !(entry.blob instanceof Blob)) return null;
  return {
    id: entry.id,
    documentKey: entry.documentKey,
    offset: Math.floor(entry.offset!),
    durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, entry.durationMs!) : 0,
    mimeType: typeof entry.mimeType === 'string' && entry.mimeType ? entry.mimeType : entry.blob.type,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt! : 0,
    blob: entry.blob,
  };
}

/** Load one document's notes, oldest first. Empty on any storage failure. */
export async function loadVoiceNotes(documentKey: string): Promise<VoiceNoteRecord[]> {
  try {
    const db = await openVoiceNoteDb();
    try {
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).index(DOCUMENT_INDEX).getAll(documentKey);
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
      });
      return records
        .flatMap(value => {
          const note = normalizeVoiceNote(value);
          return note && note.documentKey === documentKey ? [note] : [];
        })
        .sort((a, b) => a.offset - b.offset || a.createdAt - b.createdAt)
        .slice(0, MAX_NOTES_PER_DOCUMENT);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Store one note. False when the blob could not be written (quota, private mode). */
export async function putVoiceNote(record: VoiceNoteRecord): Promise<boolean> {
  try {
    const db = await openVoiceNoteDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(record);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
      });
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Remove one note. True when the record is gone (or never existed). */
export async function deleteVoiceNote(id: string): Promise<boolean> {
  try {
    const db = await openVoiceNoteDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB delete failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB delete aborted'));
      });
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
