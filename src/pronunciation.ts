// ─── Pronunciation editor ────────────────────────────────────────
// Text-to-speech engines read what is written, not what the reader
// means. Proper nouns, acronyms, and heteronyms get mangled: "Dr.
// Reyes" comes out "drive reyes", "SQL" becomes "s-q-l", "read" is
// guessed wrong in the past tense. Every mature reading tool gives the
// reader a way to say "when you see this, say that" — this is that
// layer.
//
// The substitution happens at the engine boundary only. What is on
// screen is what the author wrote; only the string handed to synthesis
// is rewritten. That keeps a document faithful to itself while the
// voice stays intelligible.
//
// Rewriting the text changes how many words are spoken, which would
// desync word-level highlighting. So `applyPronunciations` also returns
// `wordMap` — for every spoken word, the index of the written word it
// came from. `reader.ts` translates highlighted positions back through
// it. When nothing matched, `wordMap` is null and the reader keeps its
// fast path.

export interface PronunciationEntry {
  /** The word or phrase as it appears in a document. */
  word: string;
  /** What the engine should say instead. */
  say: string;
  /** Match case exactly. Default false — "depot" and "Depot" share a rule. */
  caseSensitive?: boolean;
}

export interface AppliedPronunciations {
  /** Text to hand to the engine. Identical to the input when nothing matched. */
  text: string;
  /**
   * spoken-word index → written-word index, or null when no rule applied.
   * Length equals the number of whitespace-separated words in `text`.
   */
  wordMap: number[] | null;
  /** Rules that actually fired, in no particular order. */
  applied: PronunciationEntry[];
}

/** Longest phrase a single rule may claim. Beyond this it is a rewrite, not a fix. */
export const MAX_PHRASE_WORDS = 4;

const STORAGE_KEY = 'yapper.pronunciations.v1';

// ─── Matching ────────────────────────────────────────────────────

/**
 * The comparable form of a token: surrounding punctuation dropped,
 * letters and digits kept, case folded unless the rule is exact.
 *
 * This is what lets a rule written "Dr" match the token "Dr." in a
 * sentence without the reader having to spell out every punctuation
 * variant they might meet.
 */
function coreWord(token: string, caseSensitive: boolean): string {
  const core = token.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  return caseSensitive ? core : core.toLowerCase();
}

interface Token {
  word: string;
  /** Whitespace/punctuation that preceded this word. */
  before: string;
}

/** Split text into words plus the runs between them, preserving everything. */
export function splitTokens(text: string): { tokens: Token[]; trailing: string } {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push({ word: match[0], before: text.slice(last, match.index) });
    last = match.index + match[0].length;
  }
  return { tokens, trailing: text.slice(last) };
}

/** Drop rules that cannot do anything useful, and trim the rest. */
export function sanitizeEntries(entries: readonly PronunciationEntry[]): PronunciationEntry[] {
  const out: PronunciationEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.word !== 'string' || typeof entry.say !== 'string') continue;
    const word = entry.word.trim();
    const say = entry.say.trim();
    if (!word || !say) continue;
    if (!coreWord(word, entry.caseSensitive === true)) continue; // pure punctuation
    // A replacement with no letters or digits in it cannot be spoken —
    // "world = !!!" is a typo, not an instruction.
    if (!coreWord(say, false)) continue;
    out.push({ word, say, caseSensitive: entry.caseSensitive === true });
  }
  return out;
}

/** Index rules by their first word so lookups stay O(1) per token. */
function indexByFirstWord(entries: PronunciationEntry[]): Map<string, PronunciationEntry[]> {
  const index = new Map<string, PronunciationEntry[]>();
  for (const entry of entries) {
    const words = entry.word.split(/\s+/).filter(Boolean);
    const key = coreWord(words[0], entry.caseSensitive === true);
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }
  // Longest phrase first: "New York" must win over "New".
  for (const bucket of index.values()) {
    bucket.sort(
      (a, b) => b.word.split(/\s+/).filter(Boolean).length - a.word.split(/\s+/).filter(Boolean).length,
    );
  }
  return index;
}

interface Match {
  entry: PronunciationEntry;
  /** How many written words this rule consumes. */
  length: number;
}

/** Punctuation glued to the front of a token: opening quote, bracket, dash. */
function leadingPunct(token: string): string {
  const match = token.match(/^[^\p{L}\p{N}]+/u);
  return match ? match[0] : '';
}

/** Punctuation glued to the end of a token: period, comma, closing quote. */
function trailingPunct(token: string): string {
  const match = token.match(/[^\p{L}\p{N}]+$/u);
  return match ? match[0] : '';
}

function findMatch(
  words: readonly string[],
  start: number,
  index: Map<string, PronunciationEntry[]>,
): Match | null {
  for (const caseSensitive of [false, true]) {
    const key = coreWord(words[start], caseSensitive);
    if (!key) continue;
    const bucket = index.get(key);
    if (!bucket) continue;
    for (const entry of bucket) {
      if (entry.caseSensitive === true && !caseSensitive) continue;
      const ruleWords = entry.word.split(/\s+/).filter(Boolean);
      if (ruleWords.length > MAX_PHRASE_WORDS) continue;
      if (start + ruleWords.length > words.length) continue;
      let ok = true;
      for (let k = 0; k < ruleWords.length; k++) {
        const a = coreWord(words[start + k], entry.caseSensitive === true);
        const b = coreWord(ruleWords[k], entry.caseSensitive === true);
        if (a !== b) {
          ok = false;
          break;
        }
      }
      if (ok) return { entry, length: ruleWords.length };
    }
  }
  return null;
}

/**
 * Rewrite `text` for synthesis and record how spoken words map back to
 * written ones.
 */
export function applyPronunciations(
  text: string,
  entries: readonly PronunciationEntry[],
): AppliedPronunciations {
  const rules = sanitizeEntries(entries);
  if (!rules.length || !text) return { text, wordMap: null, applied: [] };

  const index = indexByFirstWord(rules);
  if (!index.size) return { text, wordMap: null, applied: [] };

  const { tokens, trailing } = splitTokens(text);
  if (!tokens.length) return { text, wordMap: null, applied: [] };

  const words = tokens.map((t) => t.word);
  const spoken: string[] = [];
  const wordMap: number[] = [];
  const appliedSet = new Set<PronunciationEntry>();
  let out = '';
  let i = 0;

  while (i < tokens.length) {
    out += tokens[i].before;
    const match = findMatch(words, i, index);
    if (!match) {
      out += tokens[i].word;
      spoken.push(words[i]);
      wordMap.push(i);
      i += 1;
      continue;
    }
    const writtenLead = leadingPunct(tokens[i].word);
    const writtenTail = trailingPunct((tokens[i + match.length - 1] ?? tokens[i]).word);
    // Carry the written punctuation onto the replacement, otherwise "Dr."
    // becomes "Doctor" mid-sentence and the period that ended the sentence
    // disappears — the reader hears a run-on.
    const replacement =
      (writtenLead && !leadingPunct(match.entry.word) ? writtenLead : '') +
      match.entry.say +
      (writtenTail && !trailingPunct(match.entry.word) ? writtenTail : '');
    out += replacement;
    const pieces = replacement.split(/\s+/).filter(Boolean);
    for (let p = 0; p < pieces.length; p++) {
      spoken.push(pieces[p]);
      wordMap.push(i);
    }
    appliedSet.add(match.entry);
    i += match.length;
  }
  out += trailing;

  if (!appliedSet.size) return { text, wordMap: null, applied: [] };
  return { text: out, wordMap, applied: [...appliedSet] };
}

/**
 * Translate a spoken-word index back to the written word it stands for.
 * Returns the input unchanged when there is no map.
 */
export function toWrittenWordIndex(spokenIndex: number, wordMap: readonly number[] | null): number {
  if (!wordMap || !wordMap.length) return spokenIndex;
  const clamped = Math.min(Math.max(spokenIndex, 0), wordMap.length - 1);
  return wordMap[clamped];
}

// ─── Bulk import / export ────────────────────────────────────────
// The editor is a list, not a single field: a document brings a dozen
// rules at once. These two functions are the clipboard format, and they
// are deliberately forgiving — a teacher pasting a column out of a
// spreadsheet should not have to read a spec.

/**
 * Parse `word = say` lines. Also accepts a tab, a comma, or `:` as the
 * separator, because that is what spreadsheet columns paste as.
 * Blank lines and `#` comments are skipped.
 */
export function parsePronunciationList(text: string): PronunciationEntry[] {
  const entries: PronunciationEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(.+?)\s*(?:=>|=|\t|,|:)\s*(.+)$/);
    if (!match) continue;
    const word = match[1].trim();
    const say = match[2].trim();
    if (word && say) entries.push({ word, say });
  }
  return entries;
}

/** Inverse of `parsePronunciationList`, for copying rules out. */
export function formatPronunciationList(entries: readonly PronunciationEntry[]): string {
  return sanitizeEntries(entries)
    .map((e) => `${e.word} = ${e.say}`)
    .join('\n');
}

// ─── Persistence ─────────────────────────────────────────────────
// Same contract as the rest of persistence.ts: best-effort, never throw.
// A private window or a full quota must not stop reading.

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPronunciations(storage?: Storage): PronunciationEntry[] {
  const store = resolveStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitizeEntries(parsed as PronunciationEntry[]);
  } catch {
    return [];
  }
}

export function savePronunciations(entries: readonly PronunciationEntry[], storage?: Storage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    const clean = sanitizeEntries(entries);
    if (!clean.length) {
      store.removeItem(STORAGE_KEY);
      return;
    }
    store.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Quota / private mode — best-effort.
  }
}

export const PRONUNCIATION_STORAGE_KEY = STORAGE_KEY;
