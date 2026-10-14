/**
 * Vocabulary extraction and the study guide.
 *
 * "Study words" are the words a reader is unlikely to know already —
 * approximated by words absent from the bundled frequency list's common
 * core. Extraction is one pass over the document text: tokenise, keep the
 * uncommon lemmas that repeat or are long, rank them, and let the reader
 * promote any of them onto the saved word list.
 *
 * The study guide turns the saved word list into a downloadable Markdown
 * sheet: each word syllabified with its dictionary senses, synonyms, and
 * the document sentence it came from.
 */

import { lookupWord, syllabify, type DictionaryData } from './dictionary';
import type { DocumentWordEntry } from './persistence';

const LETTER = /\p{L}/u;
const WORD_TOKEN = /[\p{L}\p{N}'’-]+/gu;

/** How much of the frequency list counts as "already known". */
export const COMMON_VOCABULARY_SIZE = 8000;
/** Longest suggested-words list offered at once. */
export const MAX_CANDIDATES = 40;
const MIN_WORD_LENGTH = 5;

export interface CandidateWord {
  /** The form as it appears in the document (lowercased). */
  word: string;
  /** Occurrences in the document. */
  count: number;
  /** Offset of the first occurrence — where a lookup/highlight can anchor. */
  offset: number;
}

/**
 * Rank the document's uncommon words for study. A word qualifies when it
 * is absent from the `common` set, is at least five letters, and contains
 * a letter; frequency in the document breaks ties.
 */
export function extractCandidateWords(text: string, common: ReadonlySet<string>, limit = MAX_CANDIDATES): CandidateWord[] {
  const seen = new Map<string, { count: number; offset: number }>();
  for (const match of text.matchAll(WORD_TOKEN)) {
    const raw = match[0].replace(/^['’-]+|['’-]+$/g, '').toLowerCase();
    if (raw.length < MIN_WORD_LENGTH || !LETTER.test(raw) || common.has(raw)) continue;
    const entry = seen.get(raw);
    if (entry) entry.count += 1;
    else seen.set(raw, { count: 1, offset: match.index ?? 0 });
  }
  return [...seen.entries()]
    .map(([word, v]) => ({ word, count: v.count, offset: v.offset }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit);
}

/** The smallest run of `text` around `offset` bounded by sentence edges. */
export function sentenceAround(text: string, offset: number): string {
  const edges = /[.!?\n]/g;
  let start = 0;
  let end = text.length;
  edges.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = edges.exec(text))) {
    if (m.index < offset) start = m.index + 1;
    else { end = m.index + 1; break; }
  }
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Markdown study sheet: syllabified headword, pos-tagged senses, synonyms,
 * and the in-context sentence for every saved word. Words with no
 * dictionary entry keep their context sentence so the sheet still works
 * for names and jargon.
 */
export function buildStudyGuide(docName: string, docText: string, entries: DocumentWordEntry[], dict: DictionaryData | null): string {
  const lines = [
    `# Study guide — ${docName}`,
    '',
    `${entries.length} word${entries.length === 1 ? '' : 's'}`,
    '',
  ];
  for (const entry of entries) {
    const looked = dict ? lookupWord(dict, entry.word) : null;
    const head = looked ? looked.lemma : entry.word;
    lines.push(`## ${head} (${syllabify(head)})`);
    if (looked) {
      for (const sense of looked.senses) lines.push(`- *${sense.pos}.* ${sense.gloss}`);
      if (looked.synonyms.length) lines.push(`- Synonyms: ${looked.synonyms.join(', ')}`);
    }
    const context = sentenceAround(docText, entry.offset);
    if (context) lines.push(`- In context: “${context}”`);
    lines.push('');
  }
  return lines.join('\n');
}
