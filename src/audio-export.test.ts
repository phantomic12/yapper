import { describe, it, expect } from 'vitest';
import { resampleClip, concatenateClips } from './audio-export';

describe('resampleClip', () => {
  it('returns the same array when the rate already matches', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(resampleClip({ audio: a, sampleRate: 24000 }, 24000)).toBe(a);
  });

  it('upsamples while preserving duration', () => {
    // 1 second of audio at 8kHz → 1 second at 16kHz = 16000 samples
    const a = new Float32Array(8000).fill(0.5);
    const out = resampleClip({ audio: a, sampleRate: 8000 }, 16000);
    expect(out.length).toBe(16000);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[15999]).toBeCloseTo(0.5, 5);
  });

  it('downsamples while preserving duration', () => {
    const a = new Float32Array(16000).fill(0.25);
    const out = resampleClip({ audio: a, sampleRate: 16000 }, 8000);
    expect(out.length).toBe(8000);
    expect(out[4000]).toBeCloseTo(0.25, 5);
  });

  it('rejects invalid sample rates', () => {
    const a = new Float32Array(10);
    expect(() => resampleClip({ audio: a, sampleRate: 0 }, 8000)).toThrow();
    expect(() => resampleClip({ audio: a, sampleRate: 8000 }, 0)).toThrow();
  });
});

describe('concatenateClips', () => {
  it('joins same-rate clips with silence gaps between them', () => {
    const a = new Float32Array(100).fill(1);
    const b = new Float32Array(100).fill(-1);
    const out = concatenateClips([
      { audio: a, sampleRate: 1000 },
      { audio: b, sampleRate: 1000 },
    ], 0.1); // 100-sample gap at 1000Hz
    expect(out.sampleRate).toBe(1000);
    expect(out.audio.length).toBe(100 + 100 + 100);
    expect(out.audio[0]).toBe(1);
    expect(out.audio[150]).toBe(0); // inside the gap
    expect(out.audio[250]).toBe(-1);
  });

  it('resamples mixed rates to the highest and keeps durations', () => {
    const a = new Float32Array(8000).fill(0.5);   // 1s @ 8kHz
    const b = new Float32Array(32000).fill(0.25); // 1s @ 32kHz
    const out = concatenateClips([
      { audio: a, sampleRate: 8000 },
      { audio: b, sampleRate: 32000 },
    ], 0); // no gap
    expect(out.sampleRate).toBe(32000);
    // 1s + 1s at 32kHz
    expect(out.audio.length).toBe(64000);
    expect(out.audio[0]).toBeCloseTo(0.5, 5);
    expect(out.audio[40000]).toBeCloseTo(0.25, 5);
  });

  it('returns a single clip unchanged apart from rate unification', () => {
    const a = new Float32Array([0.1, 0.2, 0.3]);
    const out = concatenateClips([{ audio: a, sampleRate: 24000 }]);
    expect(out.audio.length).toBe(3);
    expect(out.sampleRate).toBe(24000);
  });

  it('throws on an empty clip list', () => {
    expect(() => concatenateClips([])).toThrow();
  });
});
