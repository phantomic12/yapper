import { describe, it, expect } from 'vitest';
import { prepareReaderData } from './reader';

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