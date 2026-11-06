import { describe, expect, it } from 'vitest';
import {
  MAX_PHRASE_WORDS,
  applyPronunciations,
  formatPronunciationList,
  loadPronunciations,
  parsePronunciationList,
  sanitizeEntries,
  savePronunciations,
  splitTokens,
  toWrittenWordIndex,
  PRONUNCIATION_STORAGE_KEY,
  type PronunciationEntry,
} from './pronunciation';

/** Minimal in-memory Storage so persistence can be tested without jsdom leaks. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  } as Storage;
}

describe('applyPronunciations', () => {
  it('replaces a single word and leaves the rest alone', () => {
    const result = applyPronunciations('We saw Dr Reyes yesterday.', [
      { word: 'Reyes', say: 'RAY-ess' },
    ]);
    expect(result.text).toBe('We saw Dr RAY-ess yesterday.');
    expect(result.applied).toHaveLength(1);
  });

  it('matches case-insensitively by default', () => {
    const result = applyPronunciations('the depot and the Depot', [{ word: 'depot', say: 'DEE-po' }]);
    expect(result.text).toBe('the DEE-po and the DEE-po');
  });

  it('respects caseSensitive rules', () => {
    const result = applyPronunciations('Polish the polish', [
      { word: 'Polish', say: 'POH-lish', caseSensitive: true },
    ]);
    expect(result.text).toBe('POH-lish the polish');
  });

  it('matches a token carrying punctuation the rule omits', () => {
    const result = applyPronunciations('Dr. Smith arrived.', [{ word: 'Dr', say: 'Doctor' }]);
    expect(result.text).toBe('Doctor. Smith arrived.');
  });

  it('replaces multi-word phrases as a unit', () => {
    const result = applyPronunciations('I lived in New York for years.', [
      { word: 'New York', say: 'New York City' },
    ]);
    expect(result.text).toBe('I lived in New York City for years.');
  });

  it('prefers the longest matching phrase', () => {
    const rules: PronunciationEntry[] = [
      { word: 'New', say: 'NEW' },
      { word: 'New York', say: 'NYC' },
    ];
    expect(applyPronunciations('New York', rules).text).toBe('NYC');
    expect(applyPronunciations('New Jersey', rules).text).toBe('NEW Jersey');
  });

  it('leaves text untouched and reports no map when nothing matches', () => {
    const text = 'Nothing to see here.';
    const result = applyPronunciations(text, [{ word: 'absent', say: 'x' }]);
    expect(result.text).toBe(text);
    expect(result.wordMap).toBeNull();
    expect(result.applied).toHaveLength(0);
  });

  it('preserves original whitespace and line breaks', () => {
    const text = 'first   line\n\nsecond\tline';
    expect(applyPronunciations(text, []).text).toBe(text);
    expect(applyPronunciations(text, [{ word: 'absent', say: 'x' }]).text).toBe(text);
  });

  it('maps spoken words back to the written word they came from', () => {
    // "said" -> "sed" keeps one word; "SQL" -> "sequel" also one word.
    const written = 'He said SQL twice';
    const result = applyPronunciations(written, [
      { word: 'said', say: 'sed' },
      { word: 'SQL', say: 'sequel' },
    ]);
    expect(result.text).toBe('He sed sequel twice');
    expect(result.wordMap).toEqual([0, 1, 2, 3]);

    // A multi-word replacement expands one written word into two spoken ones.
    const expanded = applyPronunciations('Use e.g. here', [{ word: 'e.g.', say: 'for example' }]);
    expect(expanded.text).toBe('Use for example here');
    expect(expanded.wordMap).toEqual([0, 1, 1, 2]);
  });

  it('maps a collapsed phrase onto its first written word', () => {
    const result = applyPronunciations('Ask Dr Reyes now', [
      { word: 'Dr Reyes', say: 'Doctor Rayess' },
    ]);
    expect(result.text).toBe('Ask Doctor Rayess now');
    // spoken: Ask(0) Doctor(1) Rayess(1) now(3)
    expect(result.wordMap).toEqual([0, 1, 1, 3]);
  });

  it('ignores rules longer than the phrase limit', () => {
    const long = Array.from({ length: MAX_PHRASE_WORDS + 1 }, () => 'word').join(' ');
    const result = applyPronunciations(long, [{ word: long, say: 'short' }]);
    expect(result.text).toBe(long);
    expect(result.wordMap).toBeNull();
  });

  it('ignores rules whose replacement is blank or punctuation only', () => {
    const result = applyPronunciations('hello world', [
      { word: 'hello', say: '   ' },
      { word: 'world', say: '!!!' },
    ]);
    expect(result.text).toBe('hello world');
  });

  it('handles repeated matches of the same rule', () => {
    const result = applyPronunciations('A a a', [{ word: 'a', say: 'ay' }]);
    expect(result.text).toBe('ay ay ay');
    expect(result.applied).toHaveLength(1);
  });
});

describe('toWrittenWordIndex', () => {
  it('is the identity without a map', () => {
    expect(toWrittenWordIndex(3, null)).toBe(3);
  });

  it('clamps out-of-range indices', () => {
    expect(toWrittenWordIndex(-4, [0, 0, 2])).toBe(0);
    expect(toWrittenWordIndex(99, [0, 0, 2])).toBe(2);
  });

  it('translates through the map', () => {
    expect(toWrittenWordIndex(1, [0, 1, 1, 3])).toBe(1);
    expect(toWrittenWordIndex(2, [0, 1, 1, 3])).toBe(1);
  });
});

describe('splitTokens', () => {
  it('keeps the leading separator of the first token', () => {
    const { tokens, trailing } = splitTokens('  hello world\n');
    expect(tokens.map((t) => t.word)).toEqual(['hello', 'world']);
    expect(tokens[0].before).toBe('  ');
    expect(trailing).toBe('\n');
  });
});

describe('sanitizeEntries', () => {
  it('trims, drops blanks, and normalises the flag', () => {
    const result = sanitizeEntries([
      { word: '  Dr  ', say: ' Doctor ' },
      { word: '', say: 'x' },
      { word: 'x', say: '' },
      { word: '—', say: 'dash' },
      { word: 'ok', say: 'fine', caseSensitive: undefined as unknown as boolean },
    ]);
    expect(result).toEqual([
      { word: 'Dr', say: 'Doctor', caseSensitive: false },
      { word: 'ok', say: 'fine', caseSensitive: false },
    ]);
  });
});

describe('bulk list format', () => {
  it('parses =, tab, comma and colon separators', () => {
    const parsed = parsePronunciationList(
      ['# comment', 'Dr = Doctor', 'SQL\tsequel', 'Reyes,RAY-ess', 'H2O: water', '', 'broken'].join(
        '\n',
      ),
    );
    expect(parsed).toEqual([
      { word: 'Dr', say: 'Doctor' },
      { word: 'SQL', say: 'sequel' },
      { word: 'Reyes', say: 'RAY-ess' },
      { word: 'H2O', say: 'water' },
    ]);
  });

  it('round-trips through format', () => {
    const entries: PronunciationEntry[] = [
      { word: 'Dr', say: 'Doctor' },
      { word: 'SQL', say: 'sequel' },
    ];
    expect(parsePronunciationList(formatPronunciationList(entries))).toEqual(entries);
  });
});

describe('persistence', () => {
  it('saves and loads entries', () => {
    const storage = fakeStorage();
    savePronunciations([{ word: 'Dr', say: 'Doctor' }], storage);
    expect(loadPronunciations(storage)).toEqual([{ word: 'Dr', say: 'Doctor', caseSensitive: false }]);
  });

  it('removes the key when the list is emptied', () => {
    const storage = fakeStorage();
    savePronunciations([{ word: 'Dr', say: 'Doctor' }], storage);
    savePronunciations([], storage);
    expect(storage.getItem(PRONUNCIATION_STORAGE_KEY)).toBeNull();
  });

  it('survives corrupt JSON', () => {
    const storage = fakeStorage();
    storage.setItem(PRONUNCIATION_STORAGE_KEY, '{not json');
    expect(loadPronunciations(storage)).toEqual([]);
  });

  it('survives a non-array payload', () => {
    const storage = fakeStorage();
    storage.setItem(PRONUNCIATION_STORAGE_KEY, '{"word":"x"}');
    expect(loadPronunciations(storage)).toEqual([]);
  });
});
