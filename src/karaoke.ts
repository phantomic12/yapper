/**
 * Karaoke word tracking for the streaming player.
 *
 * `DocumentReaderSession` already reports which sentence and word it is
 * speaking (`HighlightInfo`), but those are indices into its own parsed
 * view. The stream bar shows the sentence as one line of text, so something
 * has to turn "word 7 of sentence 3" back into a piece of markup with the
 * spoken word marked. This module does that as a pure function, so the
 * awkward parts (unlocatable words, out-of-range indices) are unit-testable
 * rather than buried in a requestAnimationFrame loop.
 */

import type { ReaderSentence } from './reader';

export interface SplitSentence {
  /** Everything before the spoken word, verbatim. */
  before: string;
  /** The word being spoken, or '' when it could not be located. */
  active: string;
  /** Everything after the spoken word, verbatim. */
  after: string;
}

/**
 * Split a sentence around the word being spoken, for display.
 *
 * The three parts always rejoin to `sentence.text` exactly, so wrapping
 * `active` in a `<mark>` never changes the text the user sees — punctuation
 * stays attached to the word it belongs to, and nothing is trimmed.
 *
 * When the word cannot be located the whole sentence comes back in `before`
 * and `active` is empty, so the "now speaking" line degrades to the plain
 * sentence instead of going blank.
 */
export interface WordSpan {
  /** Character offsets into the document text. */
  start: number;
  end: number;
}

/**
 * The document-text range of the word being spoken.
 *
 * `sentence.text` is an exact slice of the document at [sentence.start,
 * sentence.end) — `assignOffsets` guarantees it — so locating the word the
 * way `splitAtWord` does and shifting by `sentence.start` yields document
 * offsets. That is what lets the document view paint a moving karaoke box
 * over the actual page instead of highlighting the whole sentence.
 *
 * Returns null when the sentence carries no offsets (a sentence the
 * segmenter could not locate) or the word cannot be found — the caller then
 * falls back to the sentence's own range rather than painting nothing.
 */
export function wordSpanInDocument(
  sentence: ReaderSentence,
  wordIndex: number,
): WordSpan | null {
  if (sentence.start === undefined) return null;
  const words = sentence.words;
  if (wordIndex < 0 || wordIndex >= words.length) return null;
  let cursor = 0;
  for (let i = 0; i <= wordIndex; i++) {
    const at = sentence.text.indexOf(words[i], cursor);
    if (at === -1) return null;
    if (i === wordIndex) {
      return { start: sentence.start + at, end: sentence.start + at + words[i].length };
    }
    cursor = at + words[i].length;
  }
  return null;
}

/**
 * Which word a character offset falls inside, for text joined with single
 * spaces (as spoken sentences are). Returns -1 past the end.
 *
 * `speechSynthesis` boundary events report a `charIndex` into the utterance;
 * this turns it into the word index `wordSpanInDocument` wants, completing
 * the path from "the voice is on this character" to "paint this box".
 */
export function wordIndexAtChar(words: string[], charIndex: number): number {
  let pos = 0;
  for (let i = 0; i < words.length; i++) {
    if (charIndex < pos + words[i].length) return i;
    pos += words[i].length + 1;
  }
  return -1;
}

export function splitAtWord(
  sentence: ReaderSentence,
  wordIndex: number,
): SplitSentence {
  const words = sentence.words;
  if (wordIndex < 0 || wordIndex >= words.length) {
    return { before: sentence.text, active: '', after: '' };
  }

  // Walk the sentence's own text to the requested word so the offsets come
  // from the text that will be displayed, not from a re-tokenised guess.
  let cursor = 0;
  for (let i = 0; i < wordIndex; i++) {
    const at = sentence.text.indexOf(words[i], cursor);
    if (at === -1) return { before: sentence.text, active: '', after: '' };
    cursor = at + words[i].length;
  }
  const at = sentence.text.indexOf(words[wordIndex], cursor);
  if (at === -1) return { before: sentence.text, active: '', after: '' };

  return {
    before: sentence.text.slice(0, at),
    active: words[wordIndex],
    after: sentence.text.slice(at + words[wordIndex].length),
  };
}
