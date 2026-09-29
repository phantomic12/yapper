import { describe, expect, it } from 'vitest';
import { findMatches, matchSnippet } from './document-search';

describe('findMatches', () => {
  const text = 'The Cat sat on the cat mat. Category is not a cat.\nCats!';

  it('finds every occurrence case-insensitively by default', () => {
    const { matches, truncated } = findMatches(text, 'cat');
    expect(matches.map(m => text.slice(m.start, m.end)))
      .toEqual(['Cat', 'cat', 'Cat', 'cat', 'Cat']);
    expect(truncated).toBe(false);
  });

  it('respects case sensitivity', () => {
    expect(findMatches(text, 'Cat', { caseSensitive: true }).matches)
      .toHaveLength(3);
  });

  it('excludes substrings in whole-word mode', () => {
    expect(findMatches(text, 'cat', { wholeWord: true }).matches)
      .toHaveLength(3);
  });

  it('treats regex metacharacters as literal text', () => {
    const code = 'a.b aXb a.b (a.b) c++ c++?';
    expect(findMatches(code, 'a.b').matches).toHaveLength(3);
    expect(findMatches(code, 'c++').matches).toHaveLength(2);
  });

  it('still matches punctuation queries in whole-word mode', () => {
    const parens = 'see (cat) and (cat) again';
    expect(findMatches(parens, '(cat)', { wholeWord: true }).matches).toHaveLength(2);
  });

  it('keeps offsets into the original text when case-folding changes lengths', () => {
    // Lowercasing 'İ' yields TWO characters (i + combining dot), so any
    // search built on a lowercased copy drifts by one from here on and every
    // highlight downstream inherits the wrong offset. The spans must be
    // indices into the ORIGINAL string.
    const text2 = 'İstanbul noise NEEDLE';
    const { matches } = findMatches(text2, 'needle');
    expect(matches).toEqual([{ start: 15, end: 21 }]);
    expect(text2.slice(matches[0].start, matches[0].end)).toBe('NEEDLE');
  });

  it('caps the match list and says so', () => {
    const many = 'ab '.repeat(50);
    const summary = findMatches(many, 'ab', {}, 10);
    expect(summary.matches).toHaveLength(10);
    expect(summary.truncated).toBe(true);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches(text, '   ')).toEqual({ matches: [], truncated: false });
  });
});

describe('matchSnippet', () => {
  const text = 'x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100);

  it('adds ellipses only where text is cut', () => {
    const mid = matchSnippet(text, { start: 100, end: 106 }, 10);
    expect(mid.before).toBe('…' + 'x'.repeat(10));
    expect(mid.match).toBe('NEEDLE');
    expect(mid.after).toBe('y'.repeat(10) + '…');

    const start = matchSnippet(text, { start: 0, end: 1 }, 10);
    expect(start.before).toBe('');
    expect(start.after).toBe('x'.repeat(10) + '…');
  });
});

describe('findMatches in regex mode', () => {
  const text = 'cat1 cat22 cat333 dog';

  it('treats the query as a pattern', () => {
    const { matches, invalid } = findMatches(text, 'cat\\d+', { regex: true });
    expect(matches.map(m => text.slice(m.start, m.end))).toEqual(['cat1', 'cat22', 'cat333']);
    expect(invalid).not.toBe(true);
  });

  it('honours case sensitivity in regex mode', () => {
    expect(findMatches('Cat cat', 'Cat', { regex: true, caseSensitive: true }).matches)
      .toHaveLength(1);
  });

  it('reports invalid patterns instead of throwing', () => {
    const summary = findMatches(text, 'cat(', { regex: true });
    expect(summary.invalid).toBe(true);
    expect(summary.matches).toEqual([]);
  });

  it('skips zero-length matches', () => {
    expect(findMatches(text, 'x*', { regex: true }).matches).toEqual([]);
  });
});
