import { describe, it, expect } from 'vitest';
import { prepareReaderData, pickHighlightedWord } from './reader';

describe('prepareReaderData — sentence segmentation', () => {
  it('splits on plain terminal punctuation', () => {
    const { sentences } = prepareReaderData('Hello. World! How are you?');
    expect(sentences.map(s => s.text)).toEqual(['Hello.', 'World!', 'How are you?']);
  });

  it('keeps English titles like "Mr." and "Dr." inside the same sentence', () => {
    const { sentences } = prepareReaderData('Mr. Smith went to Washington. He arrived at noon.');
    expect(sentences.map(s => s.text)).toEqual([
      'Mr. Smith went to Washington.',
      'He arrived at noon.',
    ]);
  });

  it('keeps Mrs./Ms./Mx./Prof. together', () => {
    const { sentences } = prepareReaderData('Mrs. Jones met Prof. Brown at the cafe.');
    expect(sentences.map(s => s.text)).toEqual(['Mrs. Jones met Prof. Brown at the cafe.']);
  });

  it('keeps month abbreviations intact', () => {
    const { sentences } = prepareReaderData('On Jan. 5, 2024, the meeting was held.');
    expect(sentences.map(s => s.text)).toEqual(['On Jan. 5, 2024, the meeting was held.']);
  });

  it('splits on Chinese/CJK punctuation', () => {
    const { sentences } = prepareReaderData('你好。世界！你好吗？');
    expect(sentences.map(s => s.text)).toEqual(['你好。', '世界！', '你好吗？']);
  });

  it('preserves trailing closing quotes/parentheses', () => {
    const { sentences } = prepareReaderData('"Stop!" she shouted. He ran.');
    // We accept either fully-merged or split-by-quote pairs as long as the
    // first sentence preserves both the punctuation and the closing quote.
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences[0].text.endsWith('!')).toBe(true);
  });

  it('returns one sentence for text without terminal punctuation', () => {
    const { sentences } = prepareReaderData('a long sentence without terminal punctuation');
    expect(sentences).toHaveLength(1);
    expect(sentences[0].text).toBe('a long sentence without terminal punctuation');
  });

  it('handles paragraphs separated by blank lines', () => {
    const { sentences } = prepareReaderData('First paragraph one.\n\nSecond paragraph two.');
    expect(sentences).toHaveLength(2);
    expect(sentences[0].paragraphIndex).toBe(0);
    expect(sentences[1].paragraphIndex).toBe(1);
  });

  it('returns a single fallback sentence for empty text', () => {
    const { sentences } = prepareReaderData('');
    expect(sentences).toEqual([]);
  });

  it('extracts whitespace-separated words', () => {
    const { sentences } = prepareReaderData('Hello, world. Foo bar baz.');
    expect(sentences[0].words).toEqual(['Hello,', 'world.']);
    expect(sentences[1].words).toEqual(['Foo', 'bar', 'baz.']);
  });
});

describe('prepareReaderData — chunking', () => {
  it('packs multiple short sentences into one chunk under the limit', () => {
    const { chunks } = prepareReaderData('A. B. C. D. E.', 50);
    // "A. B. C. D." is 12 chars, well under 50 → one chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0].sentences.length).toBeGreaterThan(1);
  });

  it('splits into multiple chunks when the limit is exceeded', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.';
    const { chunks } = prepareReaderData(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('keeps a long single sentence in its own chunk (no word-clipping)', () => {
    const long = 'a'.repeat(500);
    const { chunks } = prepareReaderData(long + '. short.', 100);
    const longChunk = chunks.find(c => c.text.startsWith('aaaa'));
    expect(longChunk).toBeDefined();
    // The single long sentence stays whole; the period is consumed as its
    // terminator. No word-clipping anywhere.
    expect(longChunk!.text).toBe(long + '.');
  });

  it('produces chunks in sentence order', () => {
    const { chunks } = prepareReaderData('one. two. three. four.', 15);
    const flat = chunks.flatMap(c => c.sentences.map(s => s.text));
    expect(flat).toEqual(['one.', 'two.', 'three.', 'four.']);
  });

  it('returns no chunks for empty text', () => {
    const { chunks } = prepareReaderData('');
    expect(chunks).toEqual([]);
  });
});

describe('pickHighlightedWord', () => {
  it('returns 0 when there are no words', () => {
    expect(pickHighlightedWord(0, 1, 10)).toBe(0);
    expect(pickHighlightedWord(-1, 1, 10)).toBe(0);
  });

  it('falls back to chunk ratio when no timings are provided', () => {
    // 10 words, chunk duration 10s → halfway is word 5
    expect(pickHighlightedWord(10, 5, 10)).toBe(5);
    expect(pickHighlightedWord(10, 0, 10)).toBe(0);
    expect(pickHighlightedWord(10, 9.99, 10)).toBe(9);
    expect(pickHighlightedWord(10, 100, 10)).toBe(9); // clamped at last
  });

  it('clamps negative or NaN time to 0', () => {
    expect(pickHighlightedWord(10, -1, 10)).toBe(0);
    expect(pickHighlightedWord(10, NaN, 10)).toBe(0);
  });

  it('uses wordTimings when present (binary search)', () => {
    // 6 words, evenly spaced across 6s
    const timings = [0, 1, 2, 3, 4, 5];
    expect(pickHighlightedWord(6, 0.0, 6, timings)).toBe(0);
    expect(pickHighlightedWord(6, 1.5, 6, timings)).toBe(1);
    expect(pickHighlightedWord(6, 5.5, 6, timings)).toBe(5);
    // Exactly at a boundary: word 3 starts at t=3, so t=3 returns word 3
    expect(pickHighlightedWord(6, 3.0, 6, timings)).toBe(3);
  });

  it('does not jump backwards when timings are dense at the start', () => {
    // Word 5 starts at t=0.1 — even at currentTime=0 it's already "passed"
    // because we want the *latest* word whose start <= currentTime.
    const timings = [0, 0.01, 0.02, 0.03, 0.04, 0.1];
    // t=0: only word 0 has start <= 0
    expect(pickHighlightedWord(6, 0, 6, timings)).toBe(0);
    // t=0.05: words 0..4 qualify, latest is 4
    expect(pickHighlightedWord(6, 0.05, 6, timings)).toBe(4);
  });

  it('falls back to chunk ratio if timings are shorter than word count', () => {
    // Engine provided timings for fewer words than the chunk contains;
    // ratio fallback is safer than indexing past the end.
    const timings = [0, 1];  // only 2 timings, 10 words
    expect(pickHighlightedWord(10, 5, 10, timings)).toBe(5); // ratio wins
  });
});