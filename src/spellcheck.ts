/**
 * Offline spell checking and word prediction for the Write page.
 *
 * Both features run against the bundled WordNet snapshot and the
 * frequency list — no spell-check service, no network. A word counts as
 * misspelled when neither it nor its lowercase form resolves in the
 * dictionary. Corrections are ranked frequency-first candidates within
 * edit distance 2; predictions are prefix matches in frequency order.
 */

import type { DictionaryData } from './dictionary';
import { lookupWord } from './dictionary';

const WORD_TOKEN = /[\p{L}\p{N}'’-]+/gu;
const LETTER = /\p{L}/u;
const MIN_CHECK_LENGTH = 4;

export interface Misspelling {
  /** The form as typed. */
  word: string;
  /** Character offsets into the checked text, [start, end). */
  start: number;
  end: number;
  count: number;
}

/**
 * Words in `text` that resolve to no dictionary entry. Numbers, words
 * under four letters (the most forgiving class of typo), and mixed-case
 * acronyms are skipped — flagging "NASA" as wrong is noise.
 */
export function findMisspellings(text: string, dict: DictionaryData, limit = 60): Misspelling[] {
  const seen = new Map<string, Misspelling>();
  for (const match of text.matchAll(WORD_TOKEN)) {
    const raw = match[0].replace(/^['’-]+|['’-]+$/g, '');
    if (raw.length < MIN_CHECK_LENGTH || !LETTER.test(raw)) continue;
    if (/^\p{Lu}{2,}$/u.test(raw)) continue; // acronyms
    if (/\p{N}/u.test(raw)) continue; // anything containing digits
    if (lookupWord(dict, raw)) continue;
    const key = raw.toLowerCase();
    const found = seen.get(key);
    if (found) found.count += 1;
    else seen.set(key, { word: raw, start: match.index ?? 0, end: (match.index ?? 0) + raw.length, count: 1 });
  }
  return [...seen.values()].slice(0, limit);
}

/**
 * Damerau–Levenshtein distance with the transposition row — the minimum
 * needed for spelling suggestions ("teh" → "the" is one swap, not two).
 * Early-exits beyond `max`.
 */
export function editDistance(a: string, b: string, max = 2): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2: number[] | null = null;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  let cur = new Array<number>(lb + 1);
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && prev2) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array<number>(lb + 1);
  }
  return prev[lb];
}

/**
 * Correction candidates for a misspelled word: frequency-list entries
 * within edit distance 2, closest distance first then list order (the
 * list is already frequency-ranked).
 */
export function suggestCorrections(word: string, frequencyList: string[], limit = 6): string[] {
  const lower = word.toLowerCase();
  const ranked: Array<{ word: string; distance: number }> = [];
  for (const candidate of frequencyList) {
    // Most typos keep the first letter; filtering on it keeps the scan
    // of a 60k-entry list fast enough to run per misspelling.
    if (!candidate.startsWith(lower[0])) continue;
    if (Math.abs(candidate.length - lower.length) > 2) continue;
    const distance = editDistance(lower, candidate, 2);
    if (distance <= 2 && distance > 0) ranked.push({ word: candidate, distance });
  }
  ranked.sort((a, b) => a.distance - b.distance);
  return ranked.slice(0, limit).map(r => r.word);
}

/**
 * Predictive completions for the word being typed: frequency-first
 * prefix matches, skipping the prefix itself.
 */
export function predictCompletions(prefix: string, frequencyList: string[], limit = 5): string[] {
  const lower = prefix.toLowerCase();
  if (lower.length < 2) return [];
  const out: string[] = [];
  for (const candidate of frequencyList) {
    if (candidate === lower || !candidate.startsWith(lower)) continue;
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}
