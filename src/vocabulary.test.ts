import { describe, expect, it } from 'vitest';
import { buildStudyGuide, extractCandidateWords, sentenceAround } from './vocabulary';
import type { DictionaryData } from './dictionary';

describe('extractCandidateWords', () => {
  const text = 'The xerophyte survives aridity. Xerophyte species conserve water; aridity persists.';

  it('surfaces uncommon repeated words, not common ones', () => {
    const common = new Set(['the', 'survives', 'species', 'conserve', 'water', 'persists']);
    const found = extractCandidateWords(text, common).map(c => c.word);
    expect(found).toContain('xerophyte');
    expect(found).toContain('aridity');
    expect(found).not.toContain('survives');
  });

  it('ranks by document frequency then alphabetically', () => {
    const common = new Set(['the', 'survives', 'species', 'conserve', 'water', 'persists']);
    const found = extractCandidateWords(text, common);
    // Both occur twice; the alphabetical tiebreak puts aridity first.
    expect(found[0].word).toBe('aridity');
    expect(found[0].count).toBe(2);
    expect(found[1].word).toBe('xerophyte');
    expect(found[1].count).toBe(2);
    const freqFirst = extractCandidateWords('zzqqu. zzqqu. xylophone.', common);
    expect(freqFirst[0].word).toBe('zzqqu');
  });

  it('drops short words, punctuation edges, and respects the limit', () => {
    const found = extractCandidateWords('an in -odd- xylophone', new Set());
    expect(found.map(c => c.word)).toEqual(['xylophone']);
    expect(extractCandidateWords('alpha '.repeat(60), new Set(), 40)).toHaveLength(1);
  });
});

describe('sentenceAround', () => {
  const text = 'First sentence here. Second sentence has the word. Third ends.';

  it('returns the sentence containing the offset', () => {
    expect(sentenceAround(text, 30)).toBe('Second sentence has the word.');
  });

  it('handles the first sentence and document end', () => {
    expect(sentenceAround(text, 0)).toBe('First sentence here.');
    expect(sentenceAround(text, text.length - 1)).toBe('Third ends.');
  });
});

describe('buildStudyGuide', () => {
  const dict: DictionaryData = {
    aridity: { d: [['n', 'the state of being dry']], y: ['dryness'] },
  };
  const entries = [
    { id: 'a', word: 'aridity', offset: 20, createdAt: 0 },
    { id: 'b', word: 'flibberty', offset: 0, createdAt: 0 },
  ];
  const text = 'Flibberty gibbet. Plants adapt to aridity slowly.';

  it('emits headwords with senses, synonyms and context', () => {
    const guide = buildStudyGuide('demo.txt', text, entries, dict);
    expect(guide).toContain('# Study guide — demo.txt');
    expect(guide).toContain('## aridity');
    expect(guide).toContain('*noun.* the state of being dry');
    expect(guide).toContain('Synonyms: dryness');
    expect(guide).toContain('Plants adapt to aridity slowly.');
  });

  it('keeps words without entries as context-only items', () => {
    const guide = buildStudyGuide('demo.txt', text, entries, dict);
    expect(guide).toContain('## flibberty');
    expect(guide).toContain('Flibberty gibbet.');
  });

  it('still emits context when the dictionary failed to load', () => {
    const guide = buildStudyGuide('demo.txt', text, entries, null);
    expect(guide).toContain('## aridity');
    expect(guide).not.toContain('the state of being dry');
  });
});
