import { describe, it, expect } from 'vitest';
import {
  MAX_CORRECTION_RULES,
  applyCorrections,
  createCorrectionApplier,
  formatCorrectionList,
  loadCorrections,
  parseCorrectionList,
  sanitizeCorrections,
  saveCorrections,
  type CorrectionRule,
} from './corrections';

/** Minimal in-memory Storage, so persistence tests do not depend on jsdom. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => { data.clear(); },
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

/** A Storage that behaves like a full quota or a locked-down private window. */
function hostileStorage(): Storage {
  const fail = (): never => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  };
  return {
    get length(): number { return fail(); },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

describe('parseCorrectionList', () => {
  it('parses the documented find = replace form', () => {
    expect(parseCorrectionList('rn = m\nmodem = modern')).toEqual([
      { find: 'rn', replace: 'm', wholeWord: true },
      { find: 'modem', replace: 'modern', wholeWord: true },
    ]);
  });

  it('accepts the separators people actually paste', () => {
    expect(parseCorrectionList('one => 1\ntwo -> 2')).toEqual([
      { find: 'one', replace: '1', wholeWord: true },
      { find: 'two', replace: '2', wholeWord: true },
    ]);
    expect(parseCorrectionList('two\t2')).toEqual([
      { find: 'two', replace: '2', wholeWord: true },
    ]);
    expect(parseCorrectionList('three → 3')).toEqual([
      { find: 'three', replace: '3', wholeWord: true },
    ]);
  });

  it('treats a leading * as the opt-in to mid-word matching', () => {
    expect(parseCorrectionList('*rn = m')).toEqual([
      { find: 'rn', replace: 'm', wholeWord: false },
    ]);
  });

  it('supports deletion with an empty replacement', () => {
    expect(parseCorrectionList('||| =')).toEqual([
      { find: '|||', replace: '', wholeWord: true },
    ]);
  });

  it('skips blanks, comments and lines without a separator', () => {
    const text = [
      '# OCR fixes',
      '',
      '   ',
      'no separator here',
      '= no find',
      'good = yes',
    ].join('\n');
    expect(parseCorrectionList(text)).toEqual([
      { find: 'good', replace: 'yes', wholeWord: true },
    ]);
  });

  it('handles CRLF and surrounding whitespace', () => {
    expect(parseCorrectionList('  rn  =  m  \r\nmodem=modern\r\n')).toEqual([
      { find: 'rn', replace: 'm', wholeWord: true },
      { find: 'modem', replace: 'modern', wholeWord: true },
    ]);
  });

  it('uses the earliest separator so a replacement may contain one', () => {
    expect(parseCorrectionList('a = b = c')).toEqual([
      { find: 'a', replace: 'b = c', wholeWord: true },
    ]);
  });
});

describe('formatCorrectionList', () => {
  it('writes one canonical rule per line', () => {
    expect(formatCorrectionList([
      { find: 'rn', replace: 'm' },
      { find: 'x', replace: 'y', wholeWord: false },
    ])).toBe('rn = m\n*x = y');
  });

  it('round-trips through the parser', () => {
    const rules: CorrectionRule[] = [
      { find: 'rn', replace: 'm', wholeWord: true },
      { find: 'modem', replace: 'modern', wholeWord: true },
      { find: '1', replace: 'l', wholeWord: false },
      { find: '|||', replace: '', wholeWord: true },
    ];
    expect(parseCorrectionList(formatCorrectionList(rules))).toEqual(rules);
  });

  it('drops no-op rules while formatting', () => {
    expect(formatCorrectionList([{ find: 'a', replace: 'a' }])).toBe('');
  });
});

describe('sanitizeCorrections', () => {
  it('trims and defaults rules to whole-word', () => {
    expect(sanitizeCorrections([{ find: '  rn ', replace: ' m ' }])).toEqual([
      { find: 'rn', replace: 'm', wholeWord: true },
    ]);
  });

  it('drops empty finds and empty-object entries', () => {
    const messy = [
      { find: '   ', replace: 'x' },
      { find: '', replace: 'x' },
      null,
      { find: 'ok', replace: 'yes' },
    ] as unknown as CorrectionRule[];
    expect(sanitizeCorrections(messy)).toEqual([
      { find: 'ok', replace: 'yes', wholeWord: true },
    ]);
  });

  it('keeps the first rule for a find, case-insensitively', () => {
    expect(sanitizeCorrections([
      { find: 'RN', replace: 'm' },
      { find: 'rn', replace: 'n' },
    ])).toEqual([{ find: 'RN', replace: 'm', wholeWord: true }]);
  });

  it('caps a runaway pasted list', () => {
    const many = Array.from({ length: MAX_CORRECTION_RULES + 20 }, (_, i) => ({
      find: `w${i}`,
      replace: `x${i}`,
    }));
    expect(sanitizeCorrections(many)).toHaveLength(MAX_CORRECTION_RULES);
  });
});

describe('applyCorrections', () => {
  it('replaces a whole word and leaves the rest of the text alone', () => {
    const result = applyCorrections('The rn is here.', [{ find: 'rn', replace: 'm' }]);
    expect(result.text).toBe('The m is here.');
    expect(result.replacements).toBe(1);
    expect(result.applied).toEqual([{ find: 'rn', replace: 'm', wholeWord: true }]);
  });

  it('matches case-insensitively but keeps the replacement as written', () => {
    expect(applyCorrections('RN and Rn', [{ find: 'rn', replace: 'm' }]).text).toBe('m and m');
  });

  it('applies several rules in one pass and counts each replacement', () => {
    const result = applyCorrections('modem and govemment', [
      { find: 'modem', replace: 'modern' },
      { find: 'govemment', replace: 'government' },
    ]);
    expect(result.text).toBe('modern and government');
    expect(result.replacements).toBe(2);
    expect(result.applied).toHaveLength(2);
  });

  describe('whole-word boundaries', () => {
    it('does not replace a rule inside a longer word', () => {
      expect(applyCorrections('hello l', [{ find: 'l', replace: '1' }]).text).toBe('hello 1');
    });

    it('does not touch a number that merely contains the find', () => {
      const result = applyCorrections('version 1, build 10, v1', [{ find: '1', replace: 'l' }]);
      expect(result.text).toBe('version l, build 10, v1');
    });

    it('treats an apostrophe as part of the word', () => {
      expect(applyCorrections("don't stop", [{ find: 'don', replace: 'do not' }]).text)
        .toBe("don't stop");
    });

    it('allows mid-word matching when the rule opts in with *', () => {
      expect(applyCorrections('hello', [{ find: 'l', replace: '1', wholeWord: false }]).text)
        .toBe('he11o');
    });

    it('checks only the side of the find that meets a letter', () => {
      // The trailing period already ends the match; the leading side still
      // has to be a word boundary, so "sword." is not rewritten.
      expect(applyCorrections('word. sword.', [{ find: 'word.', replace: 'term.' }]).text)
        .toBe('term. sword.');
    });

    it('handles punctuation-only rules at any position', () => {
      expect(applyCorrections('a "quote"', [{ find: '"', replace: '“' }]).text)
        .toBe('a “quote“');
    });
  });

  describe('single pass, no cascading', () => {
    it('does not feed one replacement to the next rule', () => {
      const result = applyCorrections('a b', [
        { find: 'a', replace: 'b' },
        { find: 'b', replace: 'c' },
      ]);
      expect(result.text).toBe('b c');
      expect(result.replacements).toBe(2);
    });

    it('does not undo itself when two rules are inverses', () => {
      const result = applyCorrections('m rn', [
        { find: 'rn', replace: 'm' },
        { find: 'm', replace: 'rn' },
      ]);
      expect(result.text).toBe('rn m');
    });

    it('does not rescan its own output', () => {
      // "a" → "aa" must not then match the second character and grow again.
      expect(applyCorrections('a', [{ find: 'a', replace: 'aa' }]).text).toBe('aa');
    });

    it('advances by the find length, so overlapping matches do not double up', () => {
      expect(applyCorrections('aaaa', [
        { find: 'aa', replace: 'b', wholeWord: false },
      ]).text).toBe('bb');
    });

    it('prefers the longest rule at a position', () => {
      const result = applyCorrections('catastrophe', [
        { find: 'cat', replace: 'X', wholeWord: false },
        { find: 'catastrophe', replace: 'Y', wholeWord: false },
      ]);
      expect(result.text).toBe('Y');
    });
  });

  it('deletes text when the replacement is empty', () => {
    expect(applyCorrections('a ||| b', [{ find: '|||', replace: '' }]).text).toBe('a  b');
  });

  it('returns the original string and no rules when nothing matches', () => {
    const text = 'Nothing to fix here.';
    const result = applyCorrections(text, [{ find: 'zzz', replace: 'x' }]);
    expect(result.text).toBe(text);
    expect(result.replacements).toBe(0);
    expect(result.applied).toEqual([]);
  });

  it('tolerates text that ends mid-potential-match', () => {
    expect(applyCorrections('rn', [{ find: 'rn', replace: 'm' }]).text).toBe('m');
    expect(applyCorrections('r', [{ find: 'rn', replace: 'm' }]).text).toBe('r');
  });

  it('lists each fired rule once even when it matches many times', () => {
    const result = applyCorrections('rn rn rn', [{ find: 'rn', replace: 'm' }]);
    expect(result.replacements).toBe(3);
    expect(result.applied).toHaveLength(1);
  });

  it('reuses one prepared rule set across many lines', () => {
    const apply = createCorrectionApplier([{ find: 'rn', replace: 'm' }]);
    expect(apply('rn one').text).toBe('m one');
    expect(apply('rn two').text).toBe('m two');
    // The applier is stateless: a line with no match must not inherit the
    // previous line's `applied` list.
    expect(apply('nothing here')).toEqual({ text: 'nothing here', applied: [], replacements: 0 });
  });

  it('an applier with no usable rules is a pass-through', () => {
    const apply = createCorrectionApplier([{ find: 'x', replace: 'x' }]);
    expect(apply('anything')).toEqual({ text: 'anything', applied: [], replacements: 0 });
  });
});

describe('correction persistence', () => {
  it('round-trips rules', () => {
    const storage = memoryStorage();
    saveCorrections([{ find: 'rn', replace: 'm' }], storage);
    expect(loadCorrections(storage)).toEqual([{ find: 'rn', replace: 'm', wholeWord: true }]);
  });

  it('removes the key when the list is emptied', () => {
    const storage = memoryStorage();
    saveCorrections([{ find: 'rn', replace: 'm' }], storage);
    saveCorrections([], storage);
    expect(storage.getItem('yapper.corrections.v1')).toBeNull();
    expect(loadCorrections(storage)).toEqual([]);
  });

  it('returns an empty list for corrupt data', () => {
    expect(loadCorrections(memoryStorage({ 'yapper.corrections.v1': '{not json' }))).toEqual([]);
    expect(loadCorrections(memoryStorage({ 'yapper.corrections.v1': '{"a":1}' }))).toEqual([]);
  });

  it('never throws on a hostile store', () => {
    expect(() => saveCorrections([{ find: 'a', replace: 'b' }], hostileStorage())).not.toThrow();
    expect(loadCorrections(hostileStorage())).toEqual([]);
  });
});
