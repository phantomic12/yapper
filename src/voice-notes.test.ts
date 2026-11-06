/**
 * Voice notes: the recorder contract and the honest-failure paths.
 *
 * The page must never break because a microphone is absent — that is the
 * case every desktop browser without a mic, every denied permission, and
 * every insecure origin hits. So the assertions are mostly about what the
 * module *returns* when recording is impossible, plus the one path that
 * proves a successful take carries a real Blob and a measured duration.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  VoiceNoteRecorder,
  deleteVoiceNote,
  formatNoteDuration,
  loadVoiceNotes,
  normalizeVoiceNote,
  pickRecordingMimeType,
  putVoiceNote,
  recorderErrorMessage,
  recorderSupport,
  type RecorderEnvironment,
  type RecorderLike,
} from './voice-notes';

function fakeStudio(options: { failStart?: unknown; chunks?: string[] } = {}) {
  let clock = 1_000;
  const state: { startedWith: number | undefined } = { startedWith: undefined };
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const recorder: RecorderLike = {
    mimeType: 'audio/webm',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start(timeslice?: number) {
      state.startedWith = timeslice;
    },
    stop() {
      for (const chunk of options.chunks ?? ['opush']) {
        this.ondataavailable?.({ data: new Blob([chunk], { type: 'audio/webm' }) });
      }
      this.onstop?.();
    },
  };
  const env: RecorderEnvironment = {
    getUserMedia: async () => {
      if (options.failStart) throw options.failStart;
      return stream;
    },
    createRecorder: () => recorder,
    isTypeSupported: type => type === 'audio/webm',
    now: () => clock,
  };
  return {
    env,
    state,
    tracks,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('voice-notes — duration formatting', () => {
  it('reads like a voice memo', () => {
    expect(formatNoteDuration(0)).toBe('0:00');
    expect(formatNoteDuration(7_400)).toBe('0:07');
    expect(formatNoteDuration(65_000)).toBe('1:05');
    expect(formatNoteDuration(-500)).toBe('0:00');
  });
});

describe('voice-notes — capability detection', () => {
  it('says which API is missing rather than throwing', () => {
    expect(recorderSupport({}).canRecord).toBe(false);
    expect(recorderSupport({}).reason).toContain('microphone API');

    const noRecorder = recorderSupport({ getUserMedia: async () => fakeStream() });
    expect(noRecorder.canRecord).toBe(false);
    expect(noRecorder.reason).toContain('MediaRecorder');
  });

  it('is ready when both pieces exist', () => {
    const support = recorderSupport({
      getUserMedia: async () => fakeStream(),
      createRecorder: () => null as unknown as RecorderLike,
    });
    expect(support).toEqual({ canRecord: true, reason: '' });
  });

  it('picks the first format the browser will encode', () => {
    expect(pickRecordingMimeType(type => type === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecordingMimeType(() => false)).toBe('');
    expect(pickRecordingMimeType(null)).toBe('');
  });

  it('turns a permission error into something a reader can act on', () => {
    expect(recorderErrorMessage({ name: 'NotAllowedError' })).toContain('allow it');
    expect(recorderErrorMessage({ name: 'NotFoundError' })).toContain('No microphone');
    expect(recorderErrorMessage({ name: 'NotReadableError' })).toContain('busy');
    expect(recorderErrorMessage(new Error('boom'))).toContain('boom');
  });
});

describe('voice-notes — recording without a microphone', () => {
  it('returns a reason instead of throwing when the browser cannot record', async () => {
    const recorder = new VoiceNoteRecorder({});
    const result = await recorder.start();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('microphone API');
    expect(recorder.recording).toBe(false);
    expect(recorder.elapsedMs()).toBe(0);
  });

  it('returns the browser’s refusal, not an exception', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const recorder = new VoiceNoteRecorder(fakeStudio({ failStart: denied }).env);
    const result = await recorder.start();
    expect(result).toEqual({ ok: false, reason: 'Microphone access was blocked — allow it for this page to record a note.' });
    expect(recorder.recording).toBe(false);
  });

  it('treats stopping when nothing is recording as a no-op', async () => {
    const recorder = new VoiceNoteRecorder({});
    await expect(recorder.stop(0)).resolves.toEqual({ ok: false, reason: 'Nothing is being recorded.' });
  });
});

describe('voice-notes — a completed take', () => {
  it('carries the anchor, the measured duration, and the audio itself', async () => {
    const studio = fakeStudio();
    const recorder = new VoiceNoteRecorder(studio.env);
    await expect(recorder.start()).resolves.toEqual({ ok: true });
    expect(recorder.recording).toBe(true);
    // The timeslice is what keeps chunks arriving during the take.
    expect(studio.state.startedWith).toBe(250);

    studio.advance(4_200);
    expect(recorder.elapsedMs()).toBe(4_200);

    const result = await recorder.stop(412);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.offset).toBe(412);
    expect(result.note.durationMs).toBe(4_200);
    expect(result.note.mimeType).toBe('audio/webm');
    expect(result.note.blob.size).toBeGreaterThan(0);
    expect(recorder.recording).toBe(false);
    expect(studio.tracks[0].stop).toHaveBeenCalled();
  });

  it('refuses an empty recording rather than storing a silent blob', async () => {
    const studio = fakeStudio({ chunks: [] });
    const recorder = new VoiceNoteRecorder(studio.env);
    await recorder.start();
    const result = await recorder.stop(0);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('empty');
  });

  it('releases the microphone when a take is abandoned', async () => {
    const studio = fakeStudio();
    const recorder = new VoiceNoteRecorder(studio.env);
    await recorder.start();
    recorder.cancel();
    expect(recorder.recording).toBe(false);
    expect(studio.tracks[0].stop).toHaveBeenCalled();
  });

  it('gives up on a recorder that never reports back', async () => {
    vi.useFakeTimers();
    try {
      const recorder = new VoiceNoteRecorder({
        getUserMedia: async () => fakeStream(),
        // Start succeeds, but neither `onstop` nor `onerror` ever fires.
        createRecorder: () => ({
          mimeType: 'audio/webm',
          ondataavailable: null,
          onstop: null,
          onerror: null,
          start() { /* noop */ },
          stop() { /* noop */ },
        }),
        now: () => 0,
      });
      await recorder.start();
      const pending = recorder.stop(0);
      await vi.advanceTimersByTimeAsync(2_100);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('did not finish');
      expect(recorder.recording).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('voice-notes — validating stored records', () => {
  const record = {
    id: 'vn1',
    documentKey: 'doc:1:2',
    offset: 10,
    durationMs: 900,
    mimeType: 'audio/webm',
    createdAt: 5,
    blob: new Blob(['abc'], { type: 'audio/webm' }),
  };

  it('accepts a note with audio', () => {
    const note = normalizeVoiceNote(record);
    expect(note?.id).toBe('vn1');
    expect(note?.offset).toBe(10);
    expect(note?.blob.size).toBe(3);
  });

  it('drops records that cannot be played or placed', () => {
    expect(normalizeVoiceNote(null)).toBeNull();
    expect(normalizeVoiceNote({ ...record, documentKey: '' })).toBeNull();
    expect(normalizeVoiceNote({ ...record, blob: undefined })).toBeNull();
    expect(normalizeVoiceNote({ ...record, offset: -1 })).toBeNull();
    expect(normalizeVoiceNote({ ...record, id: '' })).toBeNull();
  });

  it('repairs a missing duration instead of dropping the audio', () => {
    const note = normalizeVoiceNote({ ...record, durationMs: Number.NaN });
    expect(note?.durationMs).toBe(0);
  });
});

describe('voice-notes — storage degradation', () => {
  it('reads an unavailable store as empty', async () => {
    // jsdom has no IndexedDB: this is the private-mode / unsupported path.
    await expect(loadVoiceNotes('doc:1:2')).resolves.toEqual([]);
  });

  it('reports a failed write instead of throwing', async () => {
    await expect(putVoiceNote({
      id: 'vn1',
      documentKey: 'doc:1:2',
      offset: 0,
      durationMs: 100,
      mimeType: 'audio/webm',
      createdAt: 1,
      blob: new Blob(['abc']),
    })).resolves.toBe(false);
    await expect(deleteVoiceNote('vn1')).resolves.toBe(false);
  });
});

function fakeStream(): MediaStream {
  return { getTracks: () => [] } as unknown as MediaStream;
}
