import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  jobToRecord,
  recordToJob,
  loadSettings,
  saveSettings,
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
