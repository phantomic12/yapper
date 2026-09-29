/**
 * Chapter markers for the assembled audiobook.
 *
 * A document's `sections` (EPUB chapters, spreadsheet sheets, slide decks)
 * carry character offsets into the extracted text — not times. The audiobook's
 * timeline is built from the TTS clips, whose word timings are the only
 * positions that mean anything to a player. So a section has to be located
 * inside the merged transcript before it can become a chapter.
 *
 * The mapping is by content, not arithmetic: each section's opening words are
 * matched against the merged word list, scanning forward from wherever the
 * previous chapter landed. Character offsets alone would need the merged text
 * to be a verbatim copy of the document, and it is not — reading starts from
 * the reader's cursor, chunks are rejoined with single spaces, and only the
 * parts the user actually generated are in the bundle.
 *
 * Pure and DOM-free, like the rest of the timeline math, because "which
 * chapter does this land in" is exactly the kind of thing worth pinning down
 * with tests rather than by listening to a zip.
 */

import { formatVttTimestamp } from './captions';

export interface Chapter {
  title: string;
  /** Offset on the merged timeline, in seconds. */
  startSeconds: number;
}

/** A document section, narrowed to what chapter mapping needs. */
export interface SectionSource {
  title: string;
  /** Character offset into the extracted document text. */
  start: number;
}

/** How many of a section's opening words to try to match. */
const PROBE_WORDS = 12;
/** Shortest probe still specific enough to identify a section. */
const MIN_PROBE = 3;

/** Compare words loosely: case and punctuation are not the point. */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeAll(text: string): string[] {
  return (text.match(/\S+/g) ?? []).map(normalizeWord);
}

/**
 * Locate a section's opening words in the merged transcript, at or after
 * `from`. Returns the merged word index, or -1.
 *
 * Tries the longest probe first and shortens it: a section opening with a
 * heading the engine may have dropped still resolves through its first few
 * body words, while a probe long enough to be ambiguous is never accepted.
 * A section shorter than that minimum gets one last attempt on its whole
 * (short) text — a two-word slide title is the whole section, and requiring
 * three words of it would drop a chapter we could have placed exactly.
 */
function findProbe(mergedWords: string[], probe: string[], from: number): number {
  // An empty probe would match anywhere, which is how a section pointing past
  // the end of the document turns into a chapter at the start.
  if (!probe.length) return -1;
  const matchesAt = (length: number): number => {
    for (let i = Math.max(0, from); i + length <= mergedWords.length; i++) {
      let match = true;
      for (let k = 0; k < length; k++) {
        if (mergedWords[i + k] !== probe[k]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  };
  const limit = Math.min(PROBE_WORDS, probe.length, mergedWords.length);
  for (let length = limit; length >= MIN_PROBE; length--) {
    const found = matchesAt(length);
    if (found >= 0) return found;
  }
  return probe.length < MIN_PROBE ? matchesAt(probe.length) : -1;
}

/**
 * Sections as chapters on the merged timeline.
 *
 * Sections that cannot be found in the transcript are dropped rather than
 * guessed at: a chapter pointing at the wrong line is worse than one missing.
 * The result is non-decreasing in time, never starts after 0 (a chapter track
 * that begins mid-file leaves players with an unnamed opening stretch), and is
 * empty when there are no sections or no words to anchor them to.
 */
export function chaptersFromSections(
  sections: SectionSource[] | undefined,
  documentText: string,
  mergedText: string,
  wordTimings: number[],
): Chapter[] {
  const mergedWords = normalizeAll(mergedText);
  // No document text means no evidence at all: the offsets point into a
  // string that was not supplied, and guessing would place chapters wrong.
  if (!sections?.length || !mergedWords.length || !documentText) return [];

  const chapters: Chapter[] = [];
  let cursor = 0;
  for (const section of sections) {
    const title = section.title?.trim();
    if (!title || !Number.isFinite(section.start)) continue;
    const probe = normalizeAll(documentText.slice(Math.max(0, section.start)));
    let index = findProbe(mergedWords, probe, cursor);
    // A document that opens with this section needs no match: it is the start.
    if (index < 0 && section.start <= 0) index = 0;
    if (index < 0) continue;
    const startSeconds = wordTimings[index] ?? 0;
    const last = chapters[chapters.length - 1];
    if (last && startSeconds <= last.startSeconds) {
      // Two sections landing together carry no information; keep the first.
      cursor = index + 1;
      continue;
    }
    chapters.push({ title, startSeconds: Math.max(0, startSeconds) });
    cursor = index + 1;
  }
  if (chapters.length && chapters[0].startSeconds > 0) {
    chapters.unshift({ title: 'Start', startSeconds: 0 });
  }
  return chapters;
}

/**
 * The chapter track as WebVTT.
 *
 * Cue-based rather than a `CHAPTRE` extension: a cue running from one chapter
 * to the next is what players already understand, and the same file doubles as
 * a readable outline. Each chapter's cue ends where the next begins, the last
 * running to the end of the audio.
 */
export function buildChapterVtt(chapters: Chapter[], endSeconds: number): string | null {
  if (!chapters.length) return null;
  const lines = ['WEBVTT', '', 'NOTE Chapter track — one cue per chapter.', ''];
  for (const [index, chapter] of chapters.entries()) {
    const next = chapters[index + 1];
    const end = next ? next.startSeconds : Math.max(endSeconds, chapter.startSeconds);
    lines.push(String(index + 1));
    lines.push(`${formatVttTimestamp(chapter.startSeconds)} --> ${formatVttTimestamp(end)}`);
    lines.push(chapter.title);
    lines.push('');
  }
  return lines.join('\n');
}
