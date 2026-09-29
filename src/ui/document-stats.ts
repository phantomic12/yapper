/**
 * Reading statistics for the document status bar. Pure and dependency-free:
 * these numbers appear everywhere (status bar, export headers, recent list)
 * and must count the same way in each place.
 */

const WORDS_PER_MINUTE = 200;

/** Count words the way a reader cares about: runs of non-whitespace. */
export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Estimated reading time in whole minutes, at a plain-prose pace. */
export function readingMinutes(words: number, wordsPerMinute = WORDS_PER_MINUTE): number {
  if (words <= 0 || wordsPerMinute <= 0) return 0;
  return Math.max(1, Math.round(words / wordsPerMinute));
}

/**
 * How far through a document `offset` is, as 0–100.
 *
 * A document of zero length has no positions, so the answer is 0 rather
 * than a divide-by-zero NaN wearing a percent sign.
 */
export function positionPercent(offset: number, totalLength: number): number {
  if (!(totalLength > 0)) return 0;
  const clamped = Math.max(0, Math.min(totalLength, offset));
  return Math.round((clamped / totalLength) * 100);
}

/** "42% · 1,234 words · ~6 min read" — one place decides the wording. */
export function formatStatusBar(position: number, words: number): string {
  const minutes = readingMinutes(words);
  return `${position}% · ${words.toLocaleString()} words · ~${minutes} min read`;
}
