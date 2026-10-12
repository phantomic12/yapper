import { describe, expect, it } from 'vitest';
import { editDistance, findMisspellings, predictCompletions, suggestCorrections } from './spellcheck';
import type { DictionaryData } from './dictionary';

const DICT: DictionaryData = {
  the: { d: [['a', 'definite article']] },
  quick: { d: [['a', 'moving fast']] },
  brown: { d: [['a', 'of a color']] },
  dictionary: { d: [['n', 'a book of words']] },
};

describe('findMisspellings', () => {
  it('flags words not in the dictionary and skips noise', () => {
    const found = findMisspellings('The quik brown foxx, NASA 3000, abc', DICT);
    const words = found.map(m => m.word);
    expect(words).toContain('quik');
    expect(words).toContain('foxx');
    expect(words).not.toContain('brown');
    expect(words).not.toContain('NASA');
    expect(words).not.toContain('abc'); // under min length
  });

  it('counts repeats and records offsets', () => {
    const found = findMisspellings('quik and quik', DICT);
    expect(found).toHaveLength(1);
    expect(found[0].count).toBe(2);
    expect(found[0].start).toBe(0);
  });
});

describe('editDistance', () => {
  it('handles substitution, insertion, deletion and transposition', () => {
    expect(editDistance('quik', 'quick')).toBe(1);
    expect(editDistance('teh', 'the')).toBe(1);
    expect(editDistance('cat', 'cats')).toBe(1);
    expect(editDistance('cat', 'cut')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('suggestCorrections', () => {
  it('ranks closest edits first, list order within a distance', () => {
    const freq = ['quick', 'quip', 'quiz', 'quiet', 'quit', 'quirk'];
    const out = suggestCorrections('quik', freq);
    expect(out[0]).toBe('quick');
    expect(out).toContain('quit');
    expect(out).not.toContain('quik');
  });

  it('only suggests words sharing the first letter', () => {
    expect(suggestCorrections('quik', ['wik', 'kuik'])).toEqual([]);
  });
});

describe('predictCompletions', () => {
  it('returns frequency-ordered prefix matches minus the exact word', () => {
    const freq = ['reading', 'reader', 'reads', 'ready', 'real'];
    expect(predictCompletions('read', freq, 3)).toEqual(['reading', 'reader', 'reads']);
    expect(predictCompletions('reading', freq)).not.toContain('reading');
  });

  it('ignores short prefixes', () => {
    expect(predictCompletions('r', ['reading'])).toEqual([]);
  });
});
