/**
 * Reading units: how much of the document a single highlight covers, and how
 * far one skip moves.
 *
 * The reader has always tracked sentences and words. "Highlight the current
 * line" and "skip a paragraph" cannot be answered from either alone, and the
 * answers have to be identical in the silent clock, the audio highlight loop
 * and the UI's skip buttons — or the three drift and the highlight jumps
 * somewhere the skip did not. So the grouping lives here as pure data,
 * computed from the same sentence array the rest of the reader uses.
 *
 * Deliberately DOM-free. A real visual line is whatever the browser decides
 * to wrap, which depends on font, zoom, column width and hyphenation; asking
 * the layout would make the reader's position untestable and would change
 * when the window is resized mid-read. The line unit therefore approximates
 * a display line with a character budget. It is stable, it matches what the
 * text view wraps at a typical width, and it never moves under the reader
 * just because a scrollbar appeared.
 */

import type { ReaderSentence } from './reader';

export type ReadingUnit = 'word' | 'line' | 'sentence' | 'paragraph';

/** One contiguous word range inside one sentence. */
export interface UnitRange {
  /** Global sentence index the range belongs to. */
  sentenceIndex: number;
  /** First word of the range, inclusive. */
  startWord: number;
  /** Last word of the range, exclusive. */
  endWord: number;
}

/**
 * One step of the reading cursor.
 *
 * `ranges` is plural because a paragraph is naturally several sentences:
 * one unit can light up several disjoint pieces of the page, and the skip
 * target is always the first range's first word.
 */
export interface ReadingUnitSpan {
  kind: ReadingUnit;
  /** Position in the unit list; the skip cursor. */
  index: number;
  ranges: UnitRange[];
}

/** Character budget for the approximate display line. */
export const DEFAULT_LINE_CHARS = 44;

/** The unit choices, in the order the selector shows them. */
export const READING_UNITS: ReadonlyArray<{ id: ReadingUnit; label: string }> = [
  { id: 'word', label: 'Word' },
  { id: 'line', label: 'Line' },
  { id: 'sentence', label: 'Sentence' },
  { id: 'paragraph', label: 'Paragraph' },
];

export function isReadingUnit(value: unknown): value is ReadingUnit {
  return value === 'word' || value === 'line'
    || value === 'sentence' || value === 'paragraph';
}

/**
 * Split one sentence into approximate display lines.
 *
 * A line always starts and ends on a word boundary, and never crosses a
 * sentence boundary: a line that ended mid-sentence and picked up the next
 * one would make "skip a line" move over text the reader has not seen yet,
 * and would paint two unrelated sentences as one unit.
 */
function lineRanges(
  sentence: ReaderSentence,
  lineChars: number,
): UnitRange[] {
  const ranges: UnitRange[] = [];
  const words = sentence.words;
  if (!words.length) return ranges;
  const budget = Math.max(8, lineChars);
  let start = 0;
  let length = 0;
  for (let i = 0; i < words.length; i++) {
    const add = (i === start ? 0 : 1) + words[i].length;
    // Always keep at least one word: a single token longer than the budget
    // is its own line rather than an empty range the cursor cannot land on.
    if (i > start && length + add > budget) {
      ranges.push({ sentenceIndex: sentence.globalIndex, startWord: start, endWord: i });
      start = i;
      length = words[i].length;
    } else {
      length += add;
    }
  }
  ranges.push({ sentenceIndex: sentence.globalIndex, startWord: start, endWord: words.length });
  return ranges;
}

/**
 * Build the ordered unit list for a document.
 *
 * Segments with no words produce no units: a cursor step has to land on
 * something highlightable, and an empty range would make skip appear to do
 * nothing (or worse, land between paragraphs).
 */
export function buildReadingUnits(
  sentences: readonly ReaderSentence[],
  kind: ReadingUnit,
  lineChars: number = DEFAULT_LINE_CHARS,
): ReadingUnitSpan[] {
  const units: ReadingUnitSpan[] = [];
  const push = (ranges: UnitRange[]) => {
    if (!ranges.length) return;
    units.push({ kind, index: units.length, ranges });
  };

  if (kind === 'paragraph') {
    let current: UnitRange[] = [];
    let currentParagraph: number | null = null;
    for (const sentence of sentences) {
      if (!sentence.words.length) continue;
      const range: UnitRange = {
        sentenceIndex: sentence.globalIndex,
        startWord: 0,
        endWord: sentence.words.length,
      };
      if (currentParagraph !== null && sentence.paragraphIndex !== currentParagraph) {
        push(current);
        current = [];
      }
      currentParagraph = sentence.paragraphIndex;
      current.push(range);
    }
    push(current);
    return units;
  }

  for (const sentence of sentences) {
    if (!sentence.words.length) continue;
    if (kind === 'sentence') {
      push([{ sentenceIndex: sentence.globalIndex, startWord: 0, endWord: sentence.words.length }]);
    } else if (kind === 'line') {
      for (const range of lineRanges(sentence, lineChars)) push([range]);
    } else {
      for (let word = 0; word < sentence.words.length; word++) {
        push([{ sentenceIndex: sentence.globalIndex, startWord: word, endWord: word + 1 }]);
      }
    }
  }
  return units;
}

/**
 * The unit holding a reading position, or -1 when the position is outside
 * every unit (a stale sentence index from a document that has been replaced).
 *
 * Units are ordered by document position, so the walk stops as soon as it
 * passes the position. That keeps a per-frame highlight resolve cheap on a
 * long document without relying on a binary search over a structure whose
 * paragraph units can span several sentences.
 */
export function readingUnitAt(
  units: readonly ReadingUnitSpan[],
  sentenceIndex: number,
  wordIndex: number,
): number {
  for (let i = 0; i < units.length; i++) {
    const first = units[i].ranges[0];
    if (!first) continue;
    if (first.sentenceIndex > sentenceIndex
      || (first.sentenceIndex === sentenceIndex && first.startWord > wordIndex)) {
      return -1;
    }
    for (const range of units[i].ranges) {
      if (range.sentenceIndex === sentenceIndex
        && wordIndex >= range.startWord && wordIndex < range.endWord) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * The unit one step away, clamped at both ends.
 *
 * Clamping rather than wrapping is what makes the boundary honest: at the
 * first unit, "previous" stays put instead of jumping to the end of the
 * document, which would look like a lost highlight rather than a limit.
 */
export function nextReadingUnitIndex(
  units: readonly ReadingUnitSpan[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (!units.length) return -1;
  const base = Math.min(Math.max(currentIndex, 0), units.length - 1);
  return Math.min(Math.max(base + direction, 0), units.length - 1);
}

// ─── Silent pacing ─────────────────────────────────────────────────

/**
 * Time per word in silent mode, at speed 1, before per-character time.
 * Noise floor for short words like "a" and "of".
 */
export const SILENT_BASE_MS_PER_WORD = 130;

/** Extra time for each letter or digit, so longer words linger. */
export const SILENT_MS_PER_CHAR = 24;

/** A beat at the end of a sentence; the eye needs it even without a voice. */
export const SILENT_SENTENCE_PAUSE_MS = 300;

/** A shorter beat at a comma, semicolon or dash. */
export const SILENT_CLAUSE_PAUSE_MS = 120;

/**
 * How long the silent cursor rests on one word.
 *
 * Derived from the word itself rather than a flat interval: a fixed one is
 * either too fast for "internationalization" or too slow for "the", and the
 * mismatch is exactly what makes a silent highlight feel like a metronome
 * instead of reading. Punctuation adds a pause because that is where a
 * reader's eye actually stops.
 *
 * Speed divides the result, matching the audio path where a higher playback
 * rate shortens every word. Out-of-range speeds are clamped instead of
 * trusted: a zero would schedule an infinite burst of ticks.
 */
export function silentWordDurationMs(word: string, speed = 1): number {
  const rate = Number.isFinite(speed) && speed > 0
    ? Math.min(4, Math.max(0.25, speed))
    : 1;
  const letters = word.replace(/[^\p{L}\p{N}]/gu, '').length;
  let ms = SILENT_BASE_MS_PER_WORD + SILENT_MS_PER_CHAR * letters;
  if (/[.!?。！？…]["'”’)\]]?$/.test(word)) {
    ms += SILENT_SENTENCE_PAUSE_MS;
  } else if (/[,;:—–-]["'”’)\]]?$/.test(word)) {
    ms += SILENT_CLAUSE_PAUSE_MS;
  }
  return Math.round(ms / rate);
}
