// ─── OCR corrections ─────────────────────────────────────────────
// Scanned pages are read by a machine, and the mistakes are systematic
// rather than random: "rn" comes back as "m", a lowercase "l" as "1", a
// long dash as a hyphen. The same handful of mistakes recur across a whole
// document, so fixing them one at a time while reading is wasted effort.
//
// A rule list is the fix: find the wrong form, put the right one back. Two
// things matter for it to be safe:
//
//   * Rules must not cascade. If "rn" becomes "m" and "m" becomes "rn",
//     applying them in sequence either undoes or doubles the work depending
//     on order. Here every rule is matched against the ORIGINAL text only —
//     the output of one rule is never input to another — because a single
//     left-to-right scan decides at each character and then moves past the
//     replacement it emitted.
//   * Rules must be whole-word aware. "l = 1" is meant to fix a standalone
//     letter, not "hello". A rule only matches inside a larger word when the
//     reader explicitly asks for it with a leading `*`.
//
// Input and storage are plain text (`find = replace`, one per line), so a
// list can be pasted from a notes app, shared between readers, or exported
// and re-imported without a schema.

/** One find/replace pair. */
export interface CorrectionRule {
  /** The text as the OCR read it. Matched case-insensitively. */
  find: string;
  /** The text to put back. May be empty, which deletes the match. */
  replace: string;
  /**
   * Match inside longer words too. Default false: a rule for "l" leaves
   * "hello" alone. Prefix a plain-text rule with `*` to set this.
   */
  wholeWord?: boolean;
}

export interface CorrectionResult {
  /** Text with every rule applied once, in a single pass. */
  text: string;
  /** Rules that fired, once each, in the order they first matched. */
  applied: CorrectionRule[];
  /** Total number of replacements made. */
  replacements: number;
}

/** A runaway pasted list should not make extraction quadratic. */
export const MAX_CORRECTION_RULES = 500;

const STORAGE_KEY = 'yapper.corrections.v1';

// ─── Matching ────────────────────────────────────────────────────

/**
 * A character that makes a neighbouring letter part of the same word.
 *
 * Apostrophes count: "don" is inside "don't" even though it is not a letter,
 * and a rule for the word "don" must not touch the contraction. Hyphens and
 * spaces do not count — "well" in "well-known" is a word in its own right.
 */
const WORD_CHAR = /[\p{L}\p{N}'’]/u;

function isWordChar(char: string | undefined): boolean {
  return !!char && WORD_CHAR.test(char);
}

interface PreparedRule extends CorrectionRule {
  lowerFind: string;
}

/**
 * The rules that can do something, in the order the reader wrote them.
 *
 * Trims, drops empty finds and no-op rules (same text on both sides), and
 * keeps only the first rule for a given find: two rules matching the same
 * text at the same place would otherwise make the outcome depend on an
 * ordering the reader cannot see.
 */
export function sanitizeCorrections(rules: readonly CorrectionRule[]): CorrectionRule[] {
  const out: CorrectionRule[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule || typeof rule.find !== 'string' || typeof rule.replace !== 'string') continue;
    const find = rule.find.trim();
    const replace = rule.replace.trim();
    if (!find) continue;
    if (find === replace) continue;
    const key = find.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ find, replace, wholeWord: rule.wholeWord !== false });
    if (out.length >= MAX_CORRECTION_RULES) break;
  }
  return out;
}

/**
 * Index rules by the character they start with, longest first.
 *
 * The scan visits every character of the document, so it cannot afford to
 * test all rules at each one. Bucketing by first character means a page of
 * prose tests only the rules that could possibly begin at that character;
 * longest-first within a bucket makes "catastrophe" win over "cat".
 */
function indexRules(rules: readonly CorrectionRule[]): Map<string, PreparedRule[]> {
  const index = new Map<string, PreparedRule[]>();
  for (const rule of rules) {
    const prepared: PreparedRule = { ...rule, lowerFind: rule.find.toLowerCase() };
    const key = prepared.lowerFind[0];
    const bucket = index.get(key);
    if (bucket) bucket.push(prepared);
    else index.set(key, [prepared]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.find.length - a.find.length);
  }
  return index;
}

function matchesAt(text: string, start: number, rule: PreparedRule): boolean {
  const end = start + rule.find.length;
  if (end > text.length) return false;
  // toLowerCase on the slice, not the whole document: a 500-page book is
  // lowercased once per candidate rule rather than once per character.
  if (text.slice(start, end).toLowerCase() !== rule.lowerFind) return false;
  if (rule.wholeWord === false) return true;
  // Boundary checks apply only on the sides where the find text meets a
  // letter or digit. A rule for `word.` has no trailing boundary to check —
  // the period already ends it.
  if (isWordChar(rule.find[0]) && isWordChar(text[start - 1])) return false;
  if (isWordChar(rule.find[rule.find.length - 1]) && isWordChar(text[end])) return false;
  return true;
}

/**
 * Apply every rule to `text` exactly once.
 *
 * The scan is manual rather than a chain of `String.replace` calls for two
 * reasons: chained replaces cascade (the output of rule 1 is the input of
 * rule 2), and a combined regex would have to give up per-rule case
 * handling. Here the cursor advances past a replacement and never looks at
 * it again, so the result is a function of the original text alone.
 */
export function applyCorrections(
  text: string,
  rules: readonly CorrectionRule[],
): CorrectionResult {
  return createCorrectionApplier(rules)(text);
}

/**
 * A reusable `applyCorrections` bound to one rule set.
 *
 * Extraction applies corrections line by line across a whole document;
 * sanitising and indexing the list again for every line would turn a
 * 500-page PDF into tens of thousands of redundant Map allocations. Build
 * the applier once per document.
 */
export function createCorrectionApplier(
  rules: readonly CorrectionRule[],
): (text: string) => CorrectionResult {
  const clean = sanitizeCorrections(rules);
  if (!clean.length) {
    return (text: string) => ({ text, applied: [], replacements: 0 });
  }
  const index = indexRules(clean);
  return (text: string) => applyIndexed(text, index);
}

function applyIndexed(
  text: string,
  index: Map<string, PreparedRule[]>,
): CorrectionResult {
  if (!text) return { text, applied: [], replacements: 0 };

  const applied: CorrectionRule[] = [];
  const appliedSet = new Set<string>();
  let replacements = 0;
  let out = '';
  let copiedTo = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const bucket = index.get(text[cursor].toLowerCase());
    let match: PreparedRule | null = null;
    if (bucket) {
      for (const rule of bucket) {
        if (matchesAt(text, cursor, rule)) {
          match = rule;
          break;
        }
      }
    }
    if (!match) {
      cursor += 1;
      continue;
    }
    out += text.slice(copiedTo, cursor) + match.replace;
    cursor += match.find.length;
    copiedTo = cursor;
    replacements += 1;
    if (!appliedSet.has(match.lowerFind)) {
      appliedSet.add(match.lowerFind);
      applied.push({ find: match.find, replace: match.replace, wholeWord: match.wholeWord });
    }
  }

  if (!replacements) return { text, applied: [], replacements: 0 };
  out += text.slice(copiedTo);
  return { text: out, applied, replacements };
}

// ─── Plain-text list format ──────────────────────────────────────
// Deliberately forgiving, in the same spirit as the pronunciation list: a
// rule pasted from a spreadsheet arrives tab-separated, one copied from a
// changelog arrives as `find -> replace`, and neither should need editing
// before it works. `*` before the find opts into mid-word matching.

/** Split a line at its first separator, preferring the longest at that spot. */
function splitRuleLine(line: string): { find: string; replace: string } | null {
  let at = -1;
  let separator = '';
  for (const candidate of ['=>', '->', '→', '\t', '=']) {
    const found = line.indexOf(candidate);
    if (found === -1) continue;
    if (at === -1 || found < at || (found === at && candidate.length > separator.length)) {
      at = found;
      separator = candidate;
    }
  }
  if (at === -1) return null;
  return {
    find: line.slice(0, at).trim(),
    replace: line.slice(at + separator.length).trim(),
  };
}

/**
 * Parse `find = replace` lines. Blank lines and `#` comments are skipped.
 * An empty replacement is allowed — it deletes the match — because OCR
 * sometimes reads a decorative rule as a run of junk characters.
 */
export function parseCorrectionList(text: string): CorrectionRule[] {
  const rules: CorrectionRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parsed = splitRuleLine(line);
    if (!parsed || !parsed.find) continue;
    const wholeWord = !parsed.find.startsWith('*');
    const find = wholeWord ? parsed.find : parsed.find.slice(1).trim();
    if (!find) continue;
    rules.push({ find, replace: parsed.replace, wholeWord });
  }
  return rules;
}

/** Inverse of `parseCorrectionList`: the plain text the reader can copy out. */
export function formatCorrectionList(rules: readonly CorrectionRule[]): string {
  return sanitizeCorrections(rules)
    .map(rule => `${rule.wholeWord === false ? '*' : ''}${rule.find} = ${rule.replace}`)
    .join('\n');
}

// ─── Persistence ─────────────────────────────────────────────────
// Same contract as the rest of the app: best-effort, never throw. A private
// window, a full quota, or a blocked storage API must not stop a document
// from being read — it only means the rules have to be re-entered next time.

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadCorrections(storage?: Storage): CorrectionRule[] {
  const store = resolveStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitizeCorrections(parsed as CorrectionRule[]);
  } catch {
    return [];
  }
}

export function saveCorrections(rules: readonly CorrectionRule[], storage?: Storage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    const clean = sanitizeCorrections(rules);
    if (!clean.length) {
      store.removeItem(STORAGE_KEY);
      return;
    }
    store.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Quota / private mode — best-effort.
  }
}

export const CORRECTIONS_STORAGE_KEY = STORAGE_KEY;
