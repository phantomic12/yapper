import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jobToRecord, recordToJob, loadSettings, saveSettings } from './persistence';
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
    modelName: 'Kitten TTS Nano (~24MB)',
    speed: 1.0,
    status: 'pending',
    createdAt: 1000,
    ...overrides,
  };
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
