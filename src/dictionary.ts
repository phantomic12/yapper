/**
 * The bundled word-lookup dictionary.
 *
 * `public/dict/en.json.gz` is generated from WordNet 3.1 data at
 * install/build time (scripts/build-dictionary.mjs) and fetched lazily the
 * first time the user looks a word up — 7 MB compressed is too heavy for the
 * app shell, and most sessions never open a document at all. The service
 * worker's same-origin cache-first strategy makes the second fetch free,
 * and nothing is ever sent off-device: lookups stay as private as reading.
 *
 * Syllabification is the other half of "look up a word": hypher + the
 * en-us pattern file hyphenate entirely in-memory.
 */

import { gunzipSync, strFromU8 } from 'fflate';
import Hypher from 'hypher';
import enUsPatterns from 'hyphenation.en-us';

/** What the generated dictionary file stores per lemma. */
interface DictionaryRecord {
  /** Senses as [pos, gloss] pairs; pos is 'n' | 'v' | 'a' | 's' | 'r'. */
  d: Array<[string, string]>;
  /** Synonyms gathered from the lemma's own synsets. */
  y?: string[];
}

export type DictionaryData = Record<string, DictionaryRecord>;

export interface DictionarySense {
  pos: string;
  gloss: string;
}

export interface DictionaryEntry {
  /** The lemma the lookup resolved to (may differ from the tapped form). */
  lemma: string;
  senses: DictionarySense[];
  synonyms: string[];
}

const POS_LABELS: Record<string, string> = {
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  s: 'adjective',
  r: 'adverb',
};

let dictionaryPromise: Promise<DictionaryData | null> | null = null;

/**
 * Fetch and decompress the dictionary, once. Failure is a promise of null —
 * an offline first visit or a missing asset turns lookup into a quiet
 * "no entry" state rather than a crash.
 */
export function loadDictionary(): Promise<DictionaryData | null> {
  if (!dictionaryPromise) {
    dictionaryPromise = fetch('dict/en.json.gz')
      .then(response => {
        if (!response.ok) throw new Error(`dictionary ${response.status}`);
        return response.arrayBuffer();
      })
      .then(buffer => JSON.parse(strFromU8(gunzipSync(new Uint8Array(buffer)))) as DictionaryData)
      .catch(() => null);
  }
  return dictionaryPromise;
}

/** Test hook: drop the cached promise so a test can inject its own data. */
export function resetDictionaryForTests(): void {
  dictionaryPromise = null;
}

/**
 * Inflectional fallbacks for the tapped form: dictionaries store lemmas,
 * and "running", "cars", or "studied" must resolve to their base forms.
 * Ordered by how much of the word they chop — longest suffixes first.
 */
const INFLECTIONS: Array<[RegExp, string]> = [
  [/ies$/, 'y'],
  [/ied$/, 'y'],
  [/ves$/, 'f'],
  [/ing$/, 'e'],
  [/ing$/, ''],
  [/ied$/, 'e'],
  [/ed$/, 'e'],
  [/ed$/, ''],
  [/es$/, ''],
  [/s$/, ''],
  [/er$/, ''],
  [/est$/, ''],
  [/ly$/, ''],
];

function recordToEntry(lemma: string, record: DictionaryRecord): DictionaryEntry {
  return {
    lemma,
    senses: record.d.map(([pos, gloss]) => ({ pos: POS_LABELS[pos] ?? pos, gloss })),
    synonyms: record.y ? [...record.y] : [],
  };
}

/**
 * Resolve a word against the dictionary, walking inflectional fallbacks
 * until a lemma matches. Returns null when no form is found.
 */
export function lookupWord(dict: DictionaryData, raw: string): DictionaryEntry | null {
  const word = raw.trim().toLowerCase();
  if (!word) return null;
  const candidates = [word];
  for (const [pattern, suffix] of INFLECTIONS) {
    if (!pattern.test(word)) continue;
    const stem = word.replace(pattern, suffix);
    candidates.push(stem);
    // 'running' → 'runn' still isn't the lemma; English doubles the final
    // consonant before -ing/-ed, so try the dedoubled stem too.
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]
      && !'aeiou'.includes(stem[stem.length - 1])) {
      candidates.push(stem.slice(0, -1));
    }
  }
  // Possessives and contractions keep a copy of the pre-apostrophe stem.
  const stem = word.replace(/[’'].+$/, '');
  if (stem !== word) candidates.unshift(stem);
  for (const candidate of candidates) {
    const record = dict[candidate];
    if (record) return recordToEntry(candidate, record);
  }
  return null;
}

let hypher: Hypher | null = null;

/**
 * Syllable-marked display form, e.g. "dictionary" → "dic·tio·nary".
 * Returns the word unchanged when it has no hyphenation point.
 */
export function syllabify(word: string): string {
  const h = (hypher ??= new Hypher(enUsPatterns));
  // Hyphenate each token separately: phrase headwords like "home ground"
  // keep their space instead of getting a dangling "· ·" between parts.
  return word.toLowerCase().split(/\s+/).map(token => {
    const parts = h.hyphenate(token);
    return parts.length > 1 ? parts.join('·') : token;
  }).join(' ');
}

export interface LocatedWord {
  word: string;
  /** Document-text offsets, [start, end). */
  start: number;
  end: number;
}

const WORD_CHAR = /[\p{L}\p{N}'’-]/u;

/**
 * The word the given document-text offset sits inside, expanded from the
 * click point to word boundaries. Returns null on whitespace/punctuation —
 * tapping a comma should not look anything up.
 */
export function wordSpanAt(text: string, offset: number): LocatedWord | null {
  if (offset < 0 || offset >= text.length) return null;
  if (!WORD_CHAR.test(text[offset])) return null;
  let start = offset;
  let end = offset + 1;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  const raw = text.slice(start, end);
  const word = raw.replace(/^['’-]+|['’-]+$/g, '');
  if (!word) return null;
  // Offsets track the cleaned word, not the punctuation it expanded over.
  const lead = raw.indexOf(word);
  return { word, start: start + lead, end: start + lead + word.length };
}

let frequencyPromise: Promise<string[]> | null = null;

/**
 * The frequency-ranked word list (bundled `dict/freq.txt`), used by the
 * writer's word completion. Lazily fetched like the dictionary itself.
 */
export function loadFrequencyList(): Promise<string[]> {
  if (!frequencyPromise) {
    frequencyPromise = fetch('dict/freq.txt')
      .then(response => {
        if (!response.ok) throw new Error(`freq ${response.status}`);
        return response.text();
      })
      .then(text => text.split('\n').filter(Boolean))
      .catch(() => []);
  }
  return frequencyPromise;
}
