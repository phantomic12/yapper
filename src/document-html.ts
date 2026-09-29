/**
 * Showing DOCX and EPUB as documents rather than as a wall of text.
 *
 * ── The trick that makes highlighting exact rather than fuzzy ─────────────
 * For a PDF the page geometry comes from pdfjs. There is no such thing for a
 * DOCX or an EPUB: the file is a bag of styled runs with no coordinates, so
 * "where is character 4,182" has to come from somewhere else.
 *
 * The obvious answer is to render the document and then search the DOM for the
 * sentence's text. That is what most readers do, and it is quietly wrong the
 * first time a sentence appears twice, or contains a typographic quote, or has
 * been re-wrapped — you get a confident highlight on the wrong paragraph.
 *
 * Instead: we build the markup ourselves, from the same runs that produce the
 * extracted text, and stamp each run with the character range it occupies. The
 * highlight is then a lookup, not a search. That is only possible because text
 * and markup are derived from one pass over one list of blocks, in one
 * function, so they cannot disagree — see `blocksToTextAndHtml`.
 */

/** One styled run of text: a contiguous piece with uniform formatting. */
export interface DocumentRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

/** A block-level element: a paragraph, a heading, or a list item. */
export interface DocumentBlock {
  /** Element to emit. */
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'li';
  runs: DocumentRun[];
  /**
   * First block of a new EPUB spine item (chapter). Styling only — it changes
   * no offsets, it just stops a novel's twenty chapters reading as one wall.
   */
  chapterStart?: boolean;
}

/** A character range stamped onto a rendered element. */
export interface StampedRange {
  start: number;
  end: number;
}

/**
 * Escape text for HTML.
 *
 * Not optional here: the content is a user's own file, and a DOCX is a zip of
 * XML that can contain anything, so this is the boundary between a document and
 * script execution in the page.
 */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build both the extracted text and the renderable markup from one list of
 * blocks, so the two cannot drift.
 *
 * They must agree character for character: the reader segments `text` and
 * computes sentence offsets into it (see `assignOffsets` in reader.ts), and the
 * markup's `data-off` values are looked up with those same numbers. Producing
 * them in separate passes — the previous structure, where extraction built a
 * string and rendering was imagined later — is how you end up with a highlight
 * that is off by the length of every dropped blank paragraph.
 */
export function blocksToTextAndHtml(blocks: DocumentBlock[]): { text: string; html: string } {
  // Blank paragraphs are dropped from the text, and therefore must not be
  // given ranges either; skipping them here is what keeps the two in step.
  const kept = blocks.filter(b => b.runs.map(r => r.text).join('').trim().length > 0);

  let offset = 0;
  const textParts: string[] = [];
  const htmlParts: string[] = [];

  for (const block of kept) {
    const runsHtml: string[] = [];
    for (const run of block.runs) {
      const start = offset;
      offset += run.text.length;
      const open = run.bold && run.italic ? '<strong><em>' : run.bold ? '<strong>' : run.italic ? '<em>' : '';
      const close = run.bold && run.italic ? '</em></strong>' : run.bold ? '</strong>' : run.italic ? '</em>' : '';
      // data-off is the contract with the highlighter; the formatting tags are
      // decoration around it and are deliberately inside the stamped span so a
      // range never has to know about them.
      runsHtml.push(
        `<span data-off="${start}:${offset}">${open}${escapeHtmlText(run.text)}${close}</span>`,
      );
    }
    const tag = block.kind;
    const cls = block.chapterStart ? ' class="doc-chapter-start"' : '';
    htmlParts.push(`<${tag}${cls}>${runsHtml.join('')}</${tag}>`);
    textParts.push(block.runs.map(r => r.text).join(''));
    // Matches the '\n\n' join the extracted text uses between blocks.
    offset += 2;
  }

  return { text: textParts.join('\n\n'), html: htmlParts.join('') };
}

/** Read the `start:end` range off a stamped element, or null if malformed. */
export function parseOffsetAttr(value: string | null | undefined): StampedRange | null {
  if (!value) return null;
  const [a, b] = value.split(':');
  const start = Number(a);
  const end = Number(b);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * The stamped ranges overlapping `[start, end)`, in document order.
 *
 * Binary-searches to the first candidate because this runs on every highlight
 * change during playback, and an EPUB novel is tens of thousands of runs. Like
 * `rectsForSpan`, it relies on the ranges being start-sorted — which they are,
 * because they were stamped by one forward pass in `blocksToTextAndHtml`.
 */
export function overlappingRanges<T extends StampedRange>(
  ranges: T[],
  start: number,
  end: number,
): T[] {
  if (ranges.length === 0 || !(end > start)) return [];

  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].end > start) hi = mid;
    else lo = mid + 1;
  }

  const out: T[] = [];
  for (let i = lo; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.start >= end) break;
    if (r.end > start) out.push(r);
  }
  return out;
}
