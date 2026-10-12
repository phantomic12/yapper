import { describe, expect, it } from 'vitest';
import {
  lookupWord,
  syllabify,
  wordSpanAt,
  type DictionaryData,
} from './dictionary';

const DICT: DictionaryData = {
  run: { d: [['v', 'move fast on foot'], ['n', 'a score in baseball']], y: ['sprint', 'jog'] },
  leaf: { d: [['n', 'a flat green part of a plant']] },
  study: { d: [['n', 'a room for learning'], ['v', 'apply the mind to learning']] },
  quick: { d: [['a', 'moving fast']], y: ['fast', 'rapid'] },
};

describe('lookupWord', () => {
  it('finds the exact lemma with pos labels and synonyms', () => {
    const entry = lookupWord(DICT, 'run');
    expect(entry?.lemma).toBe('run');
    expect(entry?.senses.map(s => s.pos)).toEqual(['verb', 'noun']);
    expect(entry?.synonyms).toEqual(['sprint', 'jog']);
  });

  it('is case-insensitive', () => {
    expect(lookupWord(DICT, 'RUN')?.lemma).toBe('run');
  });

  it('resolves simple inflections to their lemma', () => {
    expect(lookupWord(DICT, 'leaves')?.lemma).toBe('leaf');
    expect(lookupWord(DICT, 'studies')?.lemma).toBe('study');
    expect(lookupWord(DICT, 'studied')?.lemma).toBe('study');
    expect(lookupWord(DICT, 'running')?.lemma).toBe('run');
    expect(lookupWord(DICT, 'quicker')?.lemma).toBe('quick');
    expect(lookupWord(DICT, 'quickly')?.lemma).toBe('quick');
  });

  it('resolves possessives to the stem', () => {
    expect(lookupWord(DICT, "leaf's")?.lemma).toBe('leaf');
  });

  it('returns null for unknown words and empty input', () => {
    expect(lookupWord(DICT, 'zzq')).toBeNull();
    expect(lookupWord(DICT, '')).toBeNull();
    expect(lookupWord(DICT, '   ')).toBeNull();
  });
});

describe('syllabify', () => {
  it('marks syllable boundaries', () => {
    expect(syllabify('dictionary')).toBe('dic·tio·nary');
  });

  it('returns the word unchanged when there is nothing to mark', () => {
    expect(syllabify('cat')).toBe('cat');
  });
});

describe('wordSpanAt', () => {
  const text = 'The quick, brown fox-jumps over.';

  it('expands a click inside a word to its boundaries', () => {
    expect(wordSpanAt(text, 5)).toEqual({ word: 'quick', start: 4, end: 9 });
  });

  it('keeps hyphens inside the word', () => {
    expect(wordSpanAt(text, 18)).toEqual({ word: 'fox-jumps', start: 17, end: 26 });
  });

  it('returns null on punctuation and whitespace', () => {
    expect(wordSpanAt(text, 9)).toBeNull(); // the comma
    expect(wordSpanAt(text, 3)).toBeNull(); // space
  });

  it('returns null out of range', () => {
    expect(wordSpanAt(text, -1)).toBeNull();
    expect(wordSpanAt(text, text.length)).toBeNull();
  });
});
