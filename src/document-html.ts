/**
 * Showing DOCX and EPUB as documents rather than as a wall of text.
 *
 * Text and markup are produced together so stamped character ranges always
 * point into the exact text the reader segments and speaks.
 */

/** One styled run of text: a contiguous piece with uniform formatting. */
export interface DocumentRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

/** A block-level element: a paragraph, a heading, or a list item. */
export interface DocumentBlock {
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'li';
  runs: DocumentRun[];
  /** First block of a new EPUB spine item. */
  chapterStart?: boolean;
  /** Custom text separator before this block; defaults to a blank line. */
  separatorBefore?: string;
  /**
   * Proportional position inside a slide (percent of the slide), used by the
   * presentation view to place text where the shape sits in the file.
   */
  frame?: DocumentFrame;
  /** Per-block text alignment (PPTX `algn`). */
  align?: 'left' | 'center' | 'right';
}

/** Percent-of-slide geometry for one presentation shape. */
export interface DocumentFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A character range stamped onto a rendered element. */
export interface StampedRange {
  start: number;
  end: number;
}

/** Escape user document content before inserting it into generated markup. */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Emit one block's markup, stamping its run ranges from `offset`. */
export function stampBlock(block: DocumentBlock, offset: number): { html: string; end: number } {
  let cursor = offset;
  const runsHtml = block.runs.map(run => {
    const start = cursor;
    cursor += run.text.length;
    const open = run.bold && run.italic ? '<strong><em>' : run.bold ? '<strong>' : run.italic ? '<em>' : '';
    const close = run.bold && run.italic ? '</em></strong>' : run.bold ? '</strong>' : run.italic ? '</em>' : '';
    return `<span data-off="${start}:${cursor}">${open}${escapeHtmlText(run.text)}${close}</span>`;
  });
  const cls = block.chapterStart ? ' class="doc-chapter-start"' : '';
  const style = block.align ? ` style="text-align:${block.align}"` : '';
  return { html: `<${block.kind}${cls}${style}>${runsHtml.join('')}</${block.kind}>`, end: cursor };
}

/** A named range of a document, with a character offset into its text. */
export interface DocumentSection {
  title: string;
  start: number;
  end: number;
}

/** Heading levels that start a new section. */
const SECTION_HEADINGS = new Set<DocumentBlock['kind']>(['h1', 'h2']);

/**
 * Which heading levels divide this document into sections.
 *
 * `h1`/`h2` are the convention, but plenty of real documents use only `h3`
 * (a template that styles its chapter titles as Heading 3, a converted
 * manuscript). Treating those as a document with no structure throws away a
 * perfectly good outline, so when no `h1` or `h2` exists the shallowest
 * heading present takes their place. `h3` alongside `h1` is left alone:
 * a chapter split at every subheading is not a chapter list.
 */
function sectionHeadingLevels(blocks: DocumentBlock[]): Set<DocumentBlock['kind']> {
  if (blocks.some(block => SECTION_HEADINGS.has(block.kind))) return SECTION_HEADINGS;
  const present = new Set(blocks.map(block => block.kind).filter(kind => kind !== 'p' && kind !== 'li'));
  return present.size ? new Set([([...present].sort()[0] as DocumentBlock['kind'])]) : present;
}

/**
 * Build extracted text, stamped markup, and heading-derived sections from one
 * list of blocks.
 *
 * Sections come out of the same pass that produces the text, so their offsets
 * are correct by construction rather than by a second walk that has to
 * reproduce every separator decision — the drift-prone version of this.
 *
 * A section starts *at* its heading, so the chapter track in the audiobook
 * lands on the title being read aloud rather than after it.
 */
export function blocksToTextHtmlAndSections(blocks: DocumentBlock[]): {
  text: string;
  html: string;
  sections: DocumentSection[];
} {
  const kept = blocks.filter(block => block.runs.map(run => run.text).join('').trim().length > 0);
  const levels = sectionHeadingLevels(kept);
  let offset = 0;
  let text = '';
  const htmlParts: string[] = [];
  const headings: Array<{ title: string; start: number }> = [];

  for (const [index, block] of kept.entries()) {
    if (index > 0) {
      const separator = block.separatorBefore ?? '\n\n';
      text += separator;
      offset += separator.length;
    }
    const blockStart = offset;
    const stamped = stampBlock(block, offset);
    htmlParts.push(stamped.html);
    offset = stamped.end;
    text += block.runs.map(run => run.text).join('');
    if (levels.has(block.kind)) {
      headings.push({ title: block.runs.map(run => run.text).join('').trim(), start: blockStart });
    }
  }

  const sections: DocumentSection[] = headings
    .filter(heading => heading.title)
    .map((heading, index) => ({
      title: heading.title,
      start: heading.start,
      end: headings[index + 1]?.start ?? text.length,
    }));

  return { text, html: htmlParts.join(''), sections };
}

/** Build extracted text and stamped markup from one list of blocks. */
export function blocksToTextAndHtml(blocks: DocumentBlock[]): { text: string; html: string } {
  const { text, html } = blocksToTextHtmlAndSections(blocks);
  return { text, html };
}

export interface DocumentGrid {
  title: string;
  rows: string[][];
  /** Text delimiter for TTS and offsets; legacy XLSX uses comma-space. */
  delimiter?: string;
  /** Newline style between rows; legacy XLSX uses a single LF. */
  rowSeparator?: string;
}

/** Restore empty columns omitted by sparse XLSX XML rows. */
export function alignGridRow(cells: Array<{ ref?: string; text: string }>): string[] {
  const row: string[] = [];
  let sequential = 0;
  for (const cell of cells) {
    const reference = cell.ref?.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
    const column = reference
      ? Array.from(reference).reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1
      : sequential;
    row[column] = cell.text;
    sequential = column + 1;
  }
  return Array.from({ length: row.length }, (_, index) => row[index] ?? '');
}

/** Build accessible table markup with cell ranges aligned to extracted text. */
export function gridsToTextAndHtml(grids: DocumentGrid[]): {
  text: string;
  html: string;
  sections: Array<{ title: string; start: number; end: number }>;
} {
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  const sections: Array<{ title: string; start: number; end: number }> = [];
  let offset = 0;
  const kept = grids.map(grid => ({
    ...grid,
    rows: grid.rows.map(row => [...row]).filter(row => row.some(cell => cell.trim())),
  })).filter(grid => grid.rows.length);

  kept.forEach((grid, gridIndex) => {
    if (gridIndex > 0) offset += 2;
    const start = offset;
    const renderedRows: string[] = [];
    const gridText: string[] = [];
    grid.rows.forEach((row, rowIndex) => {
      const cells: string[] = [];
      const values: string[] = [];
      row.forEach((value, cellIndex) => {
        if (cellIndex) offset += (grid.delimiter ?? '\t').length;
        const cellStart = offset;
        offset += value.length;
        values.push(value);
        const tag = rowIndex === 0 ? 'th' : 'td';
        const scope = rowIndex === 0 ? ' scope="col"' : '';
        const content = value ? `<span data-off="${cellStart}:${offset}">${escapeHtmlText(value)}</span>` : '';
        cells.push(`<${tag}${scope}>${content}</${tag}>`);
      });
      renderedRows.push(`<tr>${cells.join('')}</tr>`);
      gridText.push(values.join(grid.delimiter ?? '\t'));
      if (rowIndex < grid.rows.length - 1) offset += (grid.rowSeparator ?? '\n\n').length;
    });
    const title = grid.title ? `<caption>${escapeHtmlText(grid.title)}</caption>` : '';
    htmlParts.push(`<table class="dochtml__table">${title}<tbody>${renderedRows.join('')}</tbody></table>`);
    const text = gridText.join(grid.rowSeparator ?? '\n\n');
    textParts.push(text);
    sections.push({ title: grid.title || `Sheet ${gridIndex + 1}`, start, end: start + text.length });
    offset = start + text.length;
  });

  return { text: textParts.join('\n\n'), html: htmlParts.join(''), sections };
}

function sameFrame(a: DocumentFrame | null, b: DocumentFrame | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
    && Math.abs(a.width - b.width) < 1e-6 && Math.abs(a.height - b.height) < 1e-6;
}

function frameStyle(frame: DocumentFrame): string {
  return `left:${frame.x.toFixed(3)}%;top:${frame.y.toFixed(3)}%;`
    + `width:${frame.width.toFixed(3)}%;height:${frame.height.toFixed(3)}%;`;
}

/**
 * Render each presentation slide as an accessible navigable card, placing
 * text inside the shape frames the file declared so the slide reads like the
 * slide. Blocks sharing a frame become one positioned shape container.
 */
export function slidesToTextAndHtml(slides: Array<{ blocks: DocumentBlock[]; aspect?: number }>): {
  text: string;
  html: string;
  sections: Array<{ title: string; start: number; end: number }>;
} {
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  const sections: Array<{ title: string; start: number; end: number }> = [];
  let offset = 0;

  for (const slide of slides) {
    const kept = slide.blocks.filter(block => block.runs.map(run => run.text).join('').trim().length > 0);
    if (!kept.length) continue;
    const slideStart = offset;
    const index = sections.length;
    let slideText = '';
    const bodyParts: string[] = [];
    let openFrame: DocumentFrame | null = null;
    let frameParts: string[] = [];

    const flushFrame = () => {
      if (!openFrame) return;
      bodyParts.push(`<div class="dochtml__slide-shape" style="${frameStyle(openFrame)}">${frameParts.join('')}</div>`);
      frameParts = [];
      openFrame = null;
    };

    for (const [blockIndex, block] of kept.entries()) {
      if (blockIndex > 0) {
        const separator = block.separatorBefore ?? '\n\n';
        slideText += separator;
        offset += separator.length;
      }
      const frame = block.frame ?? null;
      if (!sameFrame(frame, openFrame)) {
        flushFrame();
        openFrame = frame;
      }
      const stamped = stampBlock(block, offset);
      (openFrame ? frameParts : bodyParts).push(stamped.html);
      offset = stamped.end;
      slideText += block.runs.map(run => run.text).join('');
    }
    flushFrame();

    const label = `Slide ${index + 1}`;
    const aspectStyle = slide.aspect && slide.aspect > 0 && Number.isFinite(slide.aspect)
      ? ` style="aspect-ratio:${slide.aspect.toFixed(4)}"`
      : '';
    htmlParts.push(
      `<section class="dochtml__slide"${aspectStyle} aria-label="${label}">`
      + `<div class="dochtml__slide-number">${label}</div>${bodyParts.join('')}</section>`,
    );
    textParts.push(slideText);
    sections.push({ title: label, start: slideStart, end: slideStart + slideText.length });
    offset = slideStart + slideText.length + 2;
  }

  return { text: textParts.join('\n\n'), html: htmlParts.join(''), sections };
}

export function parseOffsetAttr(value: string | null | undefined): StampedRange | null {
  if (!value) return null;
  const [a, b] = value.split(':');
  const start = Number(a);
  const end = Number(b);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/** The stamped ranges overlapping [start, end), in document order. */
export function overlappingRanges<T extends StampedRange>(ranges: T[], start: number, end: number): T[] {
  if (ranges.length === 0 || !(end > start)) return [];
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].end > start) hi = mid;
    else lo = mid + 1;
  }
  const out: T[] = [];
  for (let index = lo; index < ranges.length; index++) {
    const range = ranges[index];
    if (range.start >= end) break;
    if (range.end > start) out.push(range);
  }
  return out;
}
