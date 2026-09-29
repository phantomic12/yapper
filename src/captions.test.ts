import { describe, expect, it } from 'vitest';
import {
  buildCaptionCues,
  buildWebVtt,
  canBuildCaptions,
  formatVttTimestamp,
} from './captions';

describe('formatVttTimestamp', () => {
  it('formats hours, minutes, seconds, and milliseconds', () => {
    expect(formatVttTimestamp(0)).toBe('00:00:00.000');
    expect(formatVttTimestamp(65.4321)).toBe('00:01:05.432');
    expect(formatVttTimestamp(3661.5)).toBe('01:01:01.500');
  });

  it('clamps negatives and non-finite values to zero', () => {
    expect(formatVttTimestamp(-4)).toBe('00:00:00.000');
    expect(formatVttTimestamp(Number.NaN)).toBe('00:00:00.000');
  });
});

describe('buildCaptionCues', () => {
  it('closes cues on sentence punctuation', () => {
    const cues = buildCaptionCues(
      ['One.', 'Two', 'three.'],
      [0, 0.5, 1.0],
      2,
    );
    expect(cues).toEqual([
      { start: 0, end: 0.5, text: 'One.' },
      { start: 0.5, end: 2, text: 'Two three.' },
    ]);
  });

  it('caps words per cue', () => {
    const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const cues = buildCaptionCues(words, words.map((_, i) => i), 10, { maxWords: 3 });
    expect(cues.map(cue => cue.text)).toEqual(['a b c', 'd e f', 'g h i', 'j']);
  });

  it('breaks long-running cues at the soft time cap', () => {
    const cues = buildCaptionCues(
      ['a', 'b', 'c', 'd'],
      [0, 0.1, 0.2, 6],
      10,
      { maxSeconds: 5 },
    );
    expect(cues[0]).toEqual({ start: 0, end: 6, text: 'a b c' });
    expect(cues[1]).toEqual({ start: 6, end: 10, text: 'd' });
  });

  it('keeps timings monotonic and closes the last word at the clip end', () => {
    const cues = buildCaptionCues(['a', 'b', 'c'], [1.0, 0.5, 2.0], 4);
    expect(cues[0].start).toBe(1.0);
    // 'b' cannot start before 'a' ends; runs are nudged 10ms apart.
    expect(cues.every(cue => cue.end > cue.start)).toBe(true);
    expect(cues[cues.length - 1].end).toBe(4);
  });

  it('falls back to a half-second tail when the duration is unknown', () => {
    const cues = buildCaptionCues(['tail'], [2.0], 0);
    expect(cues).toEqual([{ start: 2.0, end: 2.5, text: 'tail' }]);
  });

  it('returns nothing for no words', () => {
    expect(buildCaptionCues([], [], 1)).toEqual([]);
  });
});

describe('buildWebVtt', () => {
  it('serializes cues into a WebVTT document', () => {
    const vtt = buildWebVtt('Hello world. This works.', [0, 0.4, 1.0, 1.4], 2);
    expect(vtt).toBe([
      'WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:01.000',
      'Hello world.',
      '',
      '2',
      '00:00:01.000 --> 00:00:02.000',
      'This works.',
      '',
    ].join('\n'));
  });

  it('refuses clips without complete timings', () => {
    expect(buildWebVtt('a b c', [0, 1], 3)).toBeNull();
    expect(buildWebVtt('a b c', undefined, 3)).toBeNull();
    expect(buildWebVtt('', [], 3)).toBeNull();
  });
});

describe('canBuildCaptions', () => {
  it('requires one timing per word', () => {
    expect(canBuildCaptions('a b c', [0, 1, 2])).toBe(true);
    expect(canBuildCaptions('a b c', [0, 1])).toBe(false);
    expect(canBuildCaptions('a b c', undefined)).toBe(false);
    expect(canBuildCaptions('   ', [])).toBe(false);
  });
});
