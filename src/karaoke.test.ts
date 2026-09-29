import { describe, it, expect } from 'vitest';
import { splitAtWord, wordIndexAtChar, wordSpanInDocument } from './karaoke';
import type { ReaderSentence } from './reader';

function sentence(text: string): ReaderSentence {
  return {
    text,
    words: text.match(/\S+/g) ?? [],
    globalIndex: 0,
    paragraphIndex: 0,
  };
}

describe('splitAtWord', () => {
  const s = sentence('the quick brown fox');

  it('splits around the active word', () => {
    const parts = splitAtWord(s, 2);
    expect(parts.before).toBe('the quick ');
    expect(parts.active).toBe('brown');
    expect(parts.after).toBe(' fox');
  });

  it('always rejoins to the original sentence', () => {
    for (let i = 0; i < s.words.length; i++) {
      const parts = splitAtWord(s, i);
      expect(parts.before + parts.active + parts.after).toBe(s.text);
    }
  });

  it('handles the first and last words', () => {
    expect(splitAtWord(s, 0).before).toBe('');
    expect(splitAtWord(s, 3).active).toBe('fox');
    expect(splitAtWord(s, 3).after).toBe('');
  });

  it('keeps trailing punctuation attached to the spoken word', () => {
    // `words` is a whitespace split, so the final token carries the period.
    // Marking just "there" would show text the sentence does not contain.
    const parts = splitAtWord(sentence('Hello there.'), 1);
    expect(parts.active).toBe('there.');
    expect(parts.after).toBe('');
  });

  it('advances past a repeated word instead of re-splitting the first one', () => {
    const parts = splitAtWord(sentence('go to the town to see the show'), 3);
    expect(parts.active).toBe('town');
    expect(parts.before).toBe('go to the ');
  });

  it('falls back to the whole sentence rather than rendering nothing', () => {
    for (const index of [99, -1]) {
      const parts = splitAtWord(s, index);
      expect(parts.before).toBe(s.text);
      expect(parts.active).toBe('');
      expect(parts.after).toBe('');
    }
  });

  it('falls back when the word list does not match the text', () => {
    // Extraction can rewrite whitespace, leaving a token the sentence text
    // does not contain. Highlighting the wrong offset is worse than none.
    const broken: ReaderSentence = { ...s, words: ['the', 'ghost', 'fox'] };
    const parts = splitAtWord(broken, 1);
    expect(parts.before).toBe(s.text);
    expect(parts.active).toBe('');
  });

  it('handles a sentence with no words', () => {
    const empty: ReaderSentence = { ...s, text: '', words: [] };
    expect(splitAtWord(empty, 0)).toEqual({ before: '', active: '', after: '' });
  });
});

describe('wordSpanInDocument', () => {
  const text = 'Chapter 1. the quick brown fox jumps.';
  const s: ReaderSentence = {
    ...sentence('the quick brown fox jumps.'),
    start: 11,
    end: 37,
  };

  it('maps each word to its exact document range', () => {
    for (let i = 0; i < s.words.length; i++) {
      const span = wordSpanInDocument(s, i);
      expect(span).not.toBeNull();
      expect(text.slice(span!.start, span!.end)).toBe(s.words[i]);
    }
  });

  it('distinguishes repeated words by walking a cursor', () => {
    const repeated: ReaderSentence = { ...sentence('very very dark'), start: 2, end: 15 };
    expect(wordSpanInDocument(repeated, 0)).toEqual({ start: 2, end: 6 });
    expect(wordSpanInDocument(repeated, 1)).toEqual({ start: 7, end: 11 });
    expect(wordSpanInDocument(repeated, 2)).toEqual({ start: 12, end: 16 });
  });

  it('returns null for unlocatable words and bad indices', () => {
    const broken: ReaderSentence = { ...s, words: ['the', 'ghost', 'fox'] };
    expect(wordSpanInDocument(broken, 1)).toBeNull();
    expect(wordSpanInDocument(s, -1)).toBeNull();
    expect(wordSpanInDocument(s, 99)).toBeNull();
  });

  it('returns null when the sentence has no document offsets', () => {
    expect(wordSpanInDocument(sentence('loose text'), 0)).toBeNull();
  });
});

describe('wordIndexAtChar', () => {
  const words = ['the', 'quick', 'fox'];

  it('maps character offsets to word indices across single spaces', () => {
    expect(wordIndexAtChar(words, 0)).toBe(0);
    expect(wordIndexAtChar(words, 2)).toBe(0);
    // 'the quick fox': positions 4-8 are 'quick'.
    expect(wordIndexAtChar(words, 4)).toBe(1);
    expect(wordIndexAtChar(words, 8)).toBe(1);
    expect(wordIndexAtChar(words, 10)).toBe(2);
    expect(wordIndexAtChar(words, 12)).toBe(2);
  });

  it('returns -1 past the end', () => {
    expect(wordIndexAtChar(words, 99)).toBe(-1);
    expect(wordIndexAtChar([], 0)).toBe(-1);
  });
});
