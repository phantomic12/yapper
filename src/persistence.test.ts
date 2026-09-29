import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  jobToRecord,
  recordToJob,
  loadSettings,
  saveSettings,
  documentProgressKey,
  loadDocumentProgress,
  saveDocumentProgress,
  documentBookmarksKey,
  loadDocumentBookmarks,
  saveDocumentBookmarks,
  documentHighlightsKey,
  loadDocumentHighlights,
  saveDocumentHighlights,
  loadRecentDocuments,
  recordRecentDocument,
  clearRecentDocuments,
  selectJobsWithinBudget,
  estimateJobBytes,
  totalEstimatedBytes,
  formatBytes,
  isQuotaError,
  DEFAULT_STORAGE_BUDGET,
} from './persistence';
import type { GenerationJob } from './engine';

// In-memory localStorage stub: the node test env's localStorage is an
// experimental shim that silently no-ops, and jsdom isn't guaranteed here.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
});

function makeJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-7',
    text: 'hello world',
    modelId: 'kitten-nano',
    modelName: 'Kitten TTS Nano',
    speed: 1.0,
    status: 'pending',
    createdAt: 1000,
    ...overrides,
  };
}

/** A finished clip with audio, for the storage-budget tests. */
function makeClip(id: string, createdAt: number, samples = 1_000): GenerationJob {
  return makeJob({ id, createdAt, status: 'done', audio: new Float32Array(samples) });
}

describe('jobToRecord / recordToJob', () => {
  it('round-trips a finished job including its audio', () => {
    // f32-exact values (0.1 etc. are not exactly representable).
    const audio = new Float32Array([0.5, -0.25, 0.75]);
    const job = makeJob({
      status: 'done',
      audio,
      sampleRate: 24000,
      blob: new Blob([new ArrayBuffer(8)], { type: 'audio/wav' }),
      completedAt: 2000,
      durationMs: 500,
    });
    const record = jobToRecord(job)!;
    const back = recordToJob(record);
    expect(back.id).toBe('job-7');
    expect(back.status).toBe('done');
    expect(back.sampleRate).toBe(24000);
    expect(Array.from(back.audio!)).toEqual([0.5, -0.25, 0.75]);
    expect(back.blob).toBeInstanceOf(Blob);
    expect(back.durationMs).toBe(500);
  });

  it('stores in-flight jobs as pending so a reload resumes them', () => {
    const record = jobToRecord(makeJob({ status: 'generating' }))!;
    expect(record.status).toBe('pending');
  });

  it('copies the PCM buffer instead of aliasing the live one', () => {
    const audio = new Float32Array([1, 2]);
    const record = jobToRecord(makeJob({ status: 'done', audio }))!;
    audio[0] = 99; // mutate the live buffer afterwards
    const back = recordToJob(record);
    expect(back.audio![0]).toBe(1);
  });

  it('omits audio and blob for unfinished jobs', () => {
    const record = jobToRecord(makeJob({ status: 'pending' }))!;
    expect(record.audio).toBeUndefined();
    expect(record.blob).toBeUndefined();
  });
});

describe('document reading progress', () => {
  beforeEach(() => store.clear());

  it('keys progress to file identity without storing document content', () => {
    const file = { name: 'novel.epub', size: 1024, lastModified: 42 } as File;
    expect(documentProgressKey(file)).toBe('yapper.document-progress.v1:novel.epub:1024:42');
  });

  it('round-trips navigation state and validates corrupted values', () => {
    const key = 'yapper.document-progress.v1:sample';
    saveDocumentProgress(key, { offset: 412, page: 7, scale: 1.5, viewMode: 'document' });
    expect(loadDocumentProgress(key)).toEqual({ offset: 412, page: 7, scale: 1.5, viewMode: 'document' });
    store.set(key, '{bad json');
    expect(loadDocumentProgress(key)).toBeNull();
    store.set(key, JSON.stringify({ offset: -1, page: 0, scale: -2, viewMode: 'weird' }));
    expect(loadDocumentProgress(key)).toBeNull();
  });

  it('defaults invalid optional values and view mode safely', () => {
    const key = 'yapper.document-progress.v1:legacy';
    store.set(key, JSON.stringify({ offset: 10, page: -1, scale: Infinity, viewMode: 'unexpected', theme: 'neon' }));
    expect(loadDocumentProgress(key)).toEqual({ offset: 10, page: undefined, scale: undefined, viewMode: 'document', theme: undefined });
  });

  it('round-trips the reading theme and rejects unknown themes', () => {
    const key = 'yapper.document-progress.v1:themed';
    saveDocumentProgress(key, { offset: 0, viewMode: 'document', theme: 'night' });
    expect(loadDocumentProgress(key)?.theme).toBe('night');
  });
});

describe('document bookmarks', () => {
  beforeEach(() => store.clear());

  it('keys bookmarks to file identity without storing document content', () => {
    const file = { name: 'novel.epub', size: 1024, lastModified: 42 } as File;
    expect(documentBookmarksKey(file)).toBe('yapper.document-bookmarks.v1:novel.epub:1024:42');
  });

  it('round-trips bookmarks with notes', () => {
    const key = 'yapper.document-bookmarks.v1:sample';
    const bookmarks = [
      { id: 'a', label: 'The inciting line', offset: 412, note: 'Read this again tomorrow', createdAt: 5 },
      { id: 'b', label: 'Chapter two', offset: 900, createdAt: 6 },
    ];
    saveDocumentBookmarks(key, bookmarks);
    expect(loadDocumentBookmarks(key)).toEqual(bookmarks);
  });

  it('repairs what it can and drops what it cannot trust', () => {
    const key = 'yapper.document-bookmarks.v1:damaged';
    store.set(key, JSON.stringify([
      { id: 'ok', label: 'Fine', offset: 3, createdAt: 1 },
      { label: '   ', offset: -4 },
      { id: 'renamed', offset: 7 },
      'not an object',
    ]));
    const loaded = loadDocumentBookmarks(key);
    expect(loaded.map(b => ({ id: b.id, label: b.label, offset: b.offset }))).toEqual([
      { id: 'ok', label: 'Fine', offset: 3 },
      { id: 'renamed', label: 'Bookmark at 7', offset: 7 },
    ]);
    expect(loadDocumentBookmarks('missing:key')).toEqual([]);
    store.set(key, '{bad json');
    expect(loadDocumentBookmarks(key)).toEqual([]);
    store.set(key, JSON.stringify({ not: 'an array' }));
    expect(loadDocumentBookmarks(key)).toEqual([]);
  });
});

describe('settings', () => {
  beforeEach(() => store.clear());

  it('round-trips through localStorage', () => {
    saveSettings({ modelId: 'kokoro-82m', voiceId: 'af_heart', speed: 1.25, draftText: 'hi', languageFilter: 'en' });
    const loaded = loadSettings();
    expect(loaded?.modelId).toBe('kokoro-82m');
    expect(loaded?.speed).toBe(1.25);
    expect(loaded?.draftText).toBe('hi');
  });

  it('returns null when nothing is saved', () => {
    expect(loadSettings()).toBeNull();
  });
});

// ─── Storage budget ───────────────────────────────────────────────

describe('storage budget', () => {
  it('keeps everything when the history is small', () => {
    const jobs = [makeClip('a', 1_000), makeClip('b', 2_000)];
    const kept = selectJobsWithinBudget(jobs);
    expect(kept.map(j => j.id).sort()).toEqual(['a', 'b']);
  });

  it('caps the number of finished clips, dropping the oldest first', () => {
    const jobs = Array.from({ length: 30 }, (_, i) =>
      makeClip(`j${i}`, 1_000 + i));
    const kept = selectJobsWithinBudget(jobs, { maxJobs: 5, maxBytes: 1e12 });
    expect(kept).toHaveLength(5);
    // Newest five survive: j25..j29.
    expect(kept.map(j => j.id)).toEqual(['j25', 'j26', 'j27', 'j28', 'j29']);
  });

  it('caps on bytes even when the clip count is under the limit', () => {
    const jobs = Array.from({ length: 10 }, (_, i) =>
      makeClip(`j${i}`, 1_000 + i));
    // Each job's audio is 4000 bytes (1000 float32).
    const kept = selectJobsWithinBudget(jobs, { maxJobs: 100, maxBytes: 12_000 });
    expect(kept).toHaveLength(3);
    expect(kept.map(j => j.id)).toEqual(['j7', 'j8', 'j9']);
  });

  it('never drops queued or in-flight work, however large the history', () => {
    const finished = Array.from({ length: 40 }, (_, i) =>
      makeJob({ id: `f${i}`, createdAt: 1_000 + i, status: 'done' }));
    const pending = makeJob({ id: 'p1', createdAt: 500 });
    const generating = makeJob({ id: 'g1', createdAt: 501, status: 'generating' });
    const kept = selectJobsWithinBudget([...finished, pending, generating], {
      maxJobs: 2, maxBytes: 2_000,
    });
    const ids = kept.map(j => j.id);
    expect(ids).toContain('p1');
    expect(ids).toContain('g1');
    // The budget is still honoured for the audio — the cap is not a licence
    // to keep everything once unfinished work is protected.
    expect(kept.filter(j => j.status === 'done')).toHaveLength(2);
  });

  it('keeps at least one finished clip even when the byte budget is zero', () => {
    // Otherwise a single clip larger than the budget could never be saved,
    // and the user would lose the thing they just generated.
    const finished = [makeClip('a', 1_000), makeClip('b', 2_000)];
    const kept = selectJobsWithinBudget(finished, { maxJobs: 5, maxBytes: 0 });
    expect(kept).toHaveLength(1);
  });

  it('keeps a single clip that is larger than the whole budget', () => {
    // Otherwise a long generation could never be saved at all.
    const big = makeClip('big', 1_000);
    const kept = selectJobsWithinBudget([big], { maxJobs: 5, maxBytes: 10 });
    expect(kept.map(j => j.id)).toEqual(['big']);
  });

  it('returns the survivors oldest-first', () => {
    const jobs = [makeClip('c', 3_000), makeClip('a', 1_000), makeClip('b', 2_000)];
    expect(selectJobsWithinBudget(jobs).map(j => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('ships a default budget that is finite', () => {
    expect(DEFAULT_STORAGE_BUDGET.maxJobs).toBeGreaterThan(0);
    expect(DEFAULT_STORAGE_BUDGET.maxBytes).toBeGreaterThan(0);
    expect(DEFAULT_STORAGE_BUDGET.maxBytes).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('storage size helpers', () => {
  it('prefers the encoded blob size over the raw sample count', () => {
    const job = makeClip('x', 1_000);
    (job as { blob?: Blob }).blob = { size: 12_345 } as Blob;
    expect(estimateJobBytes(job)).toBe(12_345);
  });

  it('falls back to the sample count, then to a flat estimate', () => {
    expect(estimateJobBytes(makeClip('y', 1_000, 500))).toBe(2_000);
    expect(estimateJobBytes(makeJob({ status: 'pending' }))).toBe(512);
  });

  it('totals a list', () => {
    const jobs = [makeClip('a', 1_000, 10), makeClip('b', 2_000, 10)];
    expect(totalEstimatedBytes(jobs)).toBe(80);
  });

  it('formats sizes at each scale', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('isQuotaError', () => {
  it('recognises the quota error shapes browsers throw', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isQuotaError(new Error('connection lost'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe('document highlights', () => {
  const file = { name: 'novel.epub', size: 1024, lastModified: 42 };

  it('keys by file identity', () => {
    expect(documentHighlightsKey(file)).toBe('yapper.document-highlights.v1:novel.epub:1024:42');
  });

  it('round-trips highlights', () => {
    const key = documentHighlightsKey(file);
    const highlights = [
      { id: 'h1', start: 3, end: 9, color: 'green' as const, note: 'nice', createdAt: 5 },
      { id: 'h2', start: 20, end: 25, color: 'blue' as const, createdAt: 6 },
    ];
    saveDocumentHighlights(key, highlights);
    expect(loadDocumentHighlights(key)).toEqual(highlights);
    expect(loadDocumentHighlights('missing:key')).toEqual([]);
  });

  it('repairs malformed entries', () => {
    const key = documentHighlightsKey(file);
    localStorage.setItem(key, JSON.stringify([
      { start: -1, end: 4 },
      { start: 8, end: 4 },
      { start: 'x', end: 4 },
      { start: 1, end: 4, color: 'purple' },
      'junk',
    ]));
    expect(loadDocumentHighlights(key)).toEqual([
      { id: 'highlight-3', start: 1, end: 4, color: 'yellow', createdAt: 0 },
    ]);
  });
});

describe('document progress layout fields', () => {
  it('round-trips font family and paged mode', () => {
    saveDocumentProgress('progress:test', {
      offset: 10,
      viewMode: 'document',
      fontFamily: 'mono',
      paged: true,
    });
    const loaded = loadDocumentProgress('progress:test');
    expect(loaded?.fontFamily).toBe('mono');
    expect(loaded?.paged).toBe(true);
  });

  it('drops invalid values', () => {
    localStorage.setItem('progress:bad', JSON.stringify({
      offset: 1,
      viewMode: 'document',
      fontFamily: 'comic',
      paged: 'yes',
    }));
    const loaded = loadDocumentProgress('progress:bad');
    expect(loaded?.fontFamily).toBeUndefined();
    expect(loaded?.paged).toBeUndefined();
  });
});

describe('recent documents', () => {
  it('records newest first and refreshes duplicates in place', () => {
    recordRecentDocument({ name: 'a.pdf', size: 1, lastModified: 1, mimeType: 'application/pdf', charCount: 10, offset: 2, openedAt: 100 });
    recordRecentDocument({ name: 'b.pdf', size: 2, lastModified: 2, mimeType: 'application/pdf', charCount: 20, offset: 0, openedAt: 200 });
    recordRecentDocument({ name: 'a.pdf', size: 1, lastModified: 1, mimeType: 'application/pdf', charCount: 10, offset: 5, openedAt: 300 });
    const list = loadRecentDocuments();
    expect(list.map(entry => entry.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(list[0].offset).toBe(5);
    expect(list[0].openedAt).toBe(300);
  });

  it('caps the shelf at twelve entries', () => {
    for (let i = 0; i < 15; i++) {
      recordRecentDocument({ name: `f${i}.txt`, size: i, lastModified: i, mimeType: 'text/plain', charCount: 0, offset: 0, openedAt: i });
    }
    const list = loadRecentDocuments();
    expect(list).toHaveLength(12);
    expect(list[0].name).toBe('f14.txt');
  });

  it('clears and repairs', () => {
    recordRecentDocument({ name: 'a.pdf', size: 1, lastModified: 1, mimeType: 'application/pdf', charCount: 0, offset: 0, openedAt: 1 });
    clearRecentDocuments();
    expect(loadRecentDocuments()).toEqual([]);
    localStorage.setItem('yapper.recent-docs.v1', JSON.stringify([{ name: 'x' }, 7]));
    expect(loadRecentDocuments()).toEqual([]);
  });
});

describe('job records carry word timings', () => {
  it('round-trips per-word timings so captions survive a reload', () => {
    const job = makeJob({ status: 'done', wordTimings: [0, 0.4, 1.2] });
    const record = jobToRecord(job);
    expect(record?.wordTimings).toEqual([0, 0.4, 1.2]);
    expect(recordToJob(record!).wordTimings).toEqual([0, 0.4, 1.2]);
  });
});
