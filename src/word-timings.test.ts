import { describe, expect, it } from 'vitest';
import { estimateWordTimings, mergeClipTimings, timedWords } from './word-timings';

describe('estimateWordTimings', () => {
  it('splits the duration proportionally to word size', () => {
    // 'aa' weighs 2 and 'bbbb' weighs 4, so the split is 2s / 4s of 6s.
    expect(estimateWordTimings('aa bbbb', 6)).toEqual([0, 2]);
  });

  it('gives tiny words a floor so they are not skipped', () => {
    // All three weigh the floor of 2, so the second divides evenly.
    expect(estimateWordTimings('a b c', 3)).toEqual([0, 1, 2]);
  });

  it('returns nothing when there is nothing to speak or no duration', () => {
    expect(estimateWordTimings('', 3)).toEqual([]);
    expect(estimateWordTimings('   ', 3)).toEqual([]);
    expect(estimateWordTimings('hello', 0)).toEqual([]);
    expect(estimateWordTimings('hello', Number.NaN)).toEqual([]);
    expect(estimateWordTimings('hello', -2)).toEqual([]);
  });

  it('produces one start per word, starting at zero and inside the clip', () => {
    const text = 'Hello world, this is a longer sentence to spread out.';
    const duration = 4.2;
    const starts = estimateWordTimings(text, duration);
    const words = text.split(/\s+/);
    expect(starts).toHaveLength(words.length);
    expect(starts[0]).toBe(0);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    }
    // The last word starts before the clip ends and plays out within it.
    expect(starts[starts.length - 1]).toBeLessThan(duration);
  });
});

describe('mergeClipTimings', () => {
  it('shifts each clip\'s timings onto the merged timeline with gaps', () => {
    const merged = mergeClipTimings([
      { text: 'one two', durationSeconds: 2, wordTimings: [0, 1] },
      { text: 'three', durationSeconds: 3, wordTimings: [0.5] },
    ], 0.5);
    expect(merged.text).toBe('one two three');
    expect(merged.wordTimings).toEqual([0, 1, 2 + 0.5 + 0.5]);
    // 2s + 0.5s gap + 3s — matches concatenateClips' total length.
    expect(merged.totalSeconds).toBe(5.5);
  });

  it('falls back to estimates for clips without usable timings', () => {
    const merged = mergeClipTimings([
      { text: 'aa bb', durationSeconds: 2, wordTimings: [0] },
      { text: 'cc', durationSeconds: 1 },
    ]);
    expect(merged.wordTimings).toHaveLength(3);
    // The second clip's word starts at its own beginning on the timeline.
    expect(merged.wordTimings[2]).toBe(2);
  });

  it('handles an empty session', () => {
    expect(mergeClipTimings([], 0.5)).toEqual({ text: '', wordTimings: [], totalSeconds: 0 });
  });
});

describe('timedWords', () => {
  it('gives each word the span up to the next word\'s start', () => {
    expect(timedWords('a b c', [0, 1, 2], 4)).toEqual([
      { text: 'a', start: 0, end: 1 },
      { text: 'b', start: 1, end: 2 },
      { text: 'c', start: 2, end: 4 },
    ]);
  });

  it('returns nothing without words', () => {
    expect(timedWords('', [], 3)).toEqual([]);
  });
});
