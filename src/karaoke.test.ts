import { describe, it, expect } from 'vitest';
import { splitAtWord } from './karaoke';
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
