import { describe, it, expect } from 'vitest';
import {
  buildReadingUnits,
  nextReadingUnitIndex,
  readingUnitAt,
  silentWordDurationMs,
  SILENT_BASE_MS_PER_WORD,
  SILENT_CLAUSE_PAUSE_MS,
  SILENT_MS_PER_CHAR,
  SILENT_SENTENCE_PAUSE_MS,
} from './reading-units';
import type { ReaderSentence } from './reader';

/** Sentences shaped exactly as the segmenter emits them. */
function sentences(
  ...specs: Array<string | { text: string; paragraph?: number }>
): ReaderSentence[] {
  return specs.map((raw, index) => {
    const spec = typeof raw === 'string' ? { text: raw } : raw;
    return {
      text: spec.text,
      words: spec.text.match(/\S+/g) ?? [],
      globalIndex: index,
      paragraphIndex: spec.paragraph ?? 0,
    };
  });
}

const TWO_PARAGRAPHS = sentences(
  { text: 'First sentence here.', paragraph: 0 },
  { text: 'Second sentence here.', paragraph: 0 },
  { text: 'Third sentence here.', paragraph: 1 },
);

describe('buildReadingUnits — word', () => {
  it('makes one unit per word, in reading order', () => {
    const units = buildReadingUnits(sentences('Alpha beta gamma.'), 'word');
    expect(units).toHaveLength(3);
    expect(units.map(u => u.ranges[0].startWord)).toEqual([0, 1, 2]);
    expect(units.every(u => u.kind === 'word')).toBe(true);
    expect(units.every(u => u.index === units.indexOf(u))).toBe(true);
  });

  it('never puts two sentences in one word unit', () => {
    const units = buildReadingUnits(sentences('One two.', 'Three four.'), 'word');
    expect(units).toHaveLength(4);
    expect(units.map(u => u.ranges[0].sentenceIndex)).toEqual([0, 0, 1, 1]);
  });
});

describe('buildReadingUnits — sentence', () => {
  it('makes one unit per sentence', () => {
    const units = buildReadingUnits(TWO_PARAGRAPHS, 'sentence');
    expect(units).toHaveLength(3);
    expect(units[1].ranges).toEqual([{ sentenceIndex: 1, startWord: 0, endWord: 3 }]);
  });
});

describe('buildReadingUnits — paragraph', () => {
  it('groups consecutive sentences of one paragraph into a single unit', () => {
    const units = buildReadingUnits(TWO_PARAGRAPHS, 'paragraph');
    expect(units).toHaveLength(2);
    expect(units[0].ranges.map(r => r.sentenceIndex)).toEqual([0, 1]);
    expect(units[1].ranges.map(r => r.sentenceIndex)).toEqual([2]);
  });

  it('keeps the readable order of every range', () => {
    const units = buildReadingUnits(TWO_PARAGRAPHS, 'paragraph');
    const flat = units.flatMap(u => u.ranges.map(r => r.sentenceIndex));
    expect(flat).toEqual([0, 1, 2]);
  });
});

describe('buildReadingUnits — line', () => {
  it('splits a sentence into contiguous lines on word boundaries', () => {
    const line = 'aa bb cc dd ee ff gg hh';
    const units = buildReadingUnits(sentences(line), 'line', 8);
    expect(units.length).toBeGreaterThan(1);
    // Every word appears exactly once, in order, across the line units.
    const covered = units.flatMap(u =>
      Array.from({ length: u.ranges[0].endWord - u.ranges[0].startWord }, (_, i) => u.ranges[0].startWord + i));
    expect(covered).toEqual(Array.from({ length: 8 }, (_, i) => i));
  });

  it('does not run one line across a sentence boundary', () => {
    const units = buildReadingUnits(sentences('aa bb.', 'cc dd.'), 'line', 40);
    expect(units.map(u => u.ranges[0].sentenceIndex)).toEqual([0, 1]);
  });

  it('keeps a word longer than the budget as its own line', () => {
    const units = buildReadingUnits(sentences('a supercalifragilistic word'), 'line', 8);
    const long = units.find(u => u.ranges[0].startWord === 1)!;
    expect(long.ranges[0].endWord - long.ranges[0].startWord).toBe(1);
  });

  it('never merges separate sentences when the budget is generous', () => {
    const units = buildReadingUnits(sentences('One two three.', 'Four five.'), 'line', 200);
    expect(units).toHaveLength(2);
  });
});

describe('buildReadingUnits — empty input', () => {
  it('produces no units for a document with no sentences', () => {
    expect(buildReadingUnits([], 'sentence')).toEqual([]);
  });

  it('skips sentences with no words', () => {
    const units = buildReadingUnits([{ text: '', words: [], globalIndex: 0, paragraphIndex: 0 }], 'word');
    expect(units).toEqual([]);
  });
});

describe('readingUnitAt', () => {
  it('finds the sentence unit holding a word', () => {
    const units = buildReadingUnits(TWO_PARAGRAPHS, 'sentence');
    expect(readingUnitAt(units, 1, 2)).toBe(1);
  });

  it('finds the paragraph unit that contains a sentence', () => {
    const units = buildReadingUnits(TWO_PARAGRAPHS, 'paragraph');
    expect(readingUnitAt(units, 2, 0)).toBe(1);
  });

  it('finds the word unit for a word', () => {
    const units = buildReadingUnits(sentences('Alpha beta gamma.'), 'word');
    expect(readingUnitAt(units, 0, 2)).toBe(2);
  });

  it('returns -1 for a position outside every unit', () => {
    const units = buildReadingUnits(TWO_PARAGRAPHS, 'sentence');
    expect(readingUnitAt(units, 99, 0)).toBe(-1);
    expect(readingUnitAt(units, 0, 99)).toBe(-1);
    expect(readingUnitAt([], 0, 0)).toBe(-1);
  });
});

describe('nextReadingUnitIndex', () => {
  const units = buildReadingUnits(TWO_PARAGRAPHS, 'sentence');

  it('steps forward and back', () => {
    expect(nextReadingUnitIndex(units, 0, 1)).toBe(1);
    expect(nextReadingUnitIndex(units, 1, -1)).toBe(0);
  });

  it('clamps at the first unit instead of wrapping', () => {
    expect(nextReadingUnitIndex(units, 0, -1)).toBe(0);
  });

  it('clamps at the last unit instead of wrapping', () => {
    expect(nextReadingUnitIndex(units, units.length - 1, 1)).toBe(units.length - 1);
  });

  it('returns -1 when there is nowhere to move', () => {
    expect(nextReadingUnitIndex([], 0, 1)).toBe(-1);
  });
});

describe('silentWordDurationMs', () => {
  it('gives longer words more time than short ones', () => {
    expect(silentWordDurationMs('internationalization'))
      .toBeGreaterThan(silentWordDurationMs('the'));
  });

  it('derives the baseline from the word length', () => {
    // Four letters, no punctuation: base + 4 characters.
    expect(silentWordDurationMs('word', 1))
      .toBe(SILENT_BASE_MS_PER_WORD + 4 * SILENT_MS_PER_CHAR);
  });

  it('rests longer at a sentence end than mid-sentence', () => {
    expect(silentWordDurationMs('done.', 1))
      .toBe(SILENT_BASE_MS_PER_WORD + 4 * SILENT_MS_PER_CHAR + SILENT_SENTENCE_PAUSE_MS);
    expect(silentWordDurationMs('done,', 1))
      .toBe(SILENT_BASE_MS_PER_WORD + 4 * SILENT_MS_PER_CHAR + SILENT_CLAUSE_PAUSE_MS);
  });

  it('halves the time at double speed', () => {
    expect(silentWordDurationMs('reading', 2))
      .toBe(Math.round(silentWordDurationMs('reading', 1) / 2));
  });

  it('never schedules a zero-length tick for a zero or invalid speed', () => {
    expect(silentWordDurationMs('word', 0)).toBe(silentWordDurationMs('word', 1));
    expect(silentWordDurationMs('word', Number.NaN)).toBe(silentWordDurationMs('word', 1));
  });

  it('clamps extreme speeds to the supported range', () => {
    expect(silentWordDurationMs('word', 100)).toBe(silentWordDurationMs('word', 4));
    expect(silentWordDurationMs('word', 0.01)).toBe(silentWordDurationMs('word', 0.25));
  });

  it('handles punctuation-only tokens without dividing by nothing', () => {
    expect(silentWordDurationMs('%', 1)).toBe(SILENT_BASE_MS_PER_WORD);
  });
});
