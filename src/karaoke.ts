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
