/**
 * A spoken review of the user's own notes: highlights and bookmarks, in
 * document order, as sentences a speech engine can read one at a time.
 *
 * Kept pure so the exact wording of a review can be tested without a speech
 * engine; the panel only decides when to speak it and what to paint while
 * each segment plays.
 */

export interface ReviewSegment {
  /** What the speech engine says for this segment. */
  text: string;
  kind: 'intro' | 'highlight' | 'bookmark' | 'outro';
  /** Document range to paint while this segment plays, when there is one. */
  start?: number;
  end?: number;
}

export interface ReviewBookmark {
  label: string;
  offset: number;
  note?: string;
}

export interface ReviewHighlight {
  start: number;
  end: number;
  color: string;
  note?: string;
}

const COLOR_WORDS: Record<string, string> = {
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
};

/** One spoken clause: whitespace collapsed, no trailing period. */
function clause(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
}

/** Join clauses into a single sentence, landing exactly one period. */
function asSentence(clauses: string[]): string {
  const joined = clauses.map(clause).filter(Boolean).join('. ');
  return joined ? `${joined}.` : '';
}

/**
 * Build the review script: one intro, one segment per note in document
 * order, one outro. Notes of both kinds are interleaved by position, so the
 * review walks the document the way the reader first met the notes.
 *
 * No notes means an empty script: the panel says "nothing to review" rather
 * than speaking an empty ceremony.
 */
export function buildReviewScript(
  source: { name: string; text: string },
  bookmarks: ReviewBookmark[],
  highlights: ReviewHighlight[],
): ReviewSegment[] {
  type Entry =
    | { position: number; kind: 'highlight'; item: ReviewHighlight }
    | { position: number; kind: 'bookmark'; item: ReviewBookmark };
  const entries: Entry[] = [
    ...highlights.map(item => ({ position: item.start, kind: 'highlight' as const, item })),
    ...bookmarks.map(item => ({ position: item.offset, kind: 'bookmark' as const, item })),
  ].sort((a, b) => a.position - b.position);
  if (!entries.length) return [];

  const segments: ReviewSegment[] = [{
    kind: 'intro',
    text: asSentence([
      `Review of ${source.name}: ${entries.length} note${entries.length === 1 ? '' : 's'}`,
    ]),
  }];
  let highlightCount = 0;
  let bookmarkCount = 0;
  for (const entry of entries) {
    if (entry.kind === 'highlight') {
      highlightCount++;
      const { start, end, color, note } = entry.item;
      const quote = source.text.slice(start, end);
      segments.push({
        kind: 'highlight',
        text: asSentence([
          `Highlight ${highlightCount}, ${COLOR_WORDS[color] ?? color}`,
          quote,
          ...(note ? [`Note: ${note}`] : []),
        ]),
        start,
        // highlight() paints nothing on an empty span; keep one character
        // under the brush even for a degenerate stored range.
        end: Math.max(end, start + 1),
      });
    } else {
      bookmarkCount++;
      const { label, offset, note } = entry.item;
      segments.push({
        kind: 'bookmark',
        text: asSentence([
          `Bookmark ${bookmarkCount}: ${label}`,
          ...(note ? [`Note: ${note}`] : []),
        ]),
        start: offset,
        end: offset + 1,
      });
    }
  }
  segments.push({ kind: 'outro', text: 'End of review.' });
  return segments;
}

export interface ReviewScriptText {
  /** The whole script as one string, segments separated by blank lines. */
  text: string;
  /** Character range of each segment inside `text`, in input order. */
  ranges: Array<{ start: number; end: number }>;
}

/**
 * Flatten segments into the single string a speech session reads, keeping
 * each segment's character range so a spoken sentence maps back to the note
 * (and the document span) it came from.
 */
export function reviewScriptText(segments: ReviewSegment[]): ReviewScriptText {
  let text = '';
  const ranges: Array<{ start: number; end: number }> = [];
  for (const [index, segment] of segments.entries()) {
    if (index > 0) text += '\n\n';
    const start = text.length;
    text += segment.text;
    ranges.push({ start, end: text.length });
  }
  return { text, ranges };
}
