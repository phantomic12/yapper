/**
 * Chapters for documents that declare no structure of their own.
 *
 * DOCX, EPUB, HTML, RTF, and ODT all carry headings the extractor can read.
 * A `.txt` file and a `.csv` do not, yet the audiobook still deserves chapter
 * markers — so here structure has to be *inferred* from how the content is
 * laid out.
 *
 * The inference is deliberately conservative. A wrong chapter marker sends a
 * listener to the wrong paragraph of their audiobook, which is worse than a
 * document with no markers at all, so each source has to earn its chapters:
 *
 *   • Plain text and Markdown: explicit markers (ATX `#`, setext `===`) are
 *     believed outright; otherwise a short line alone between blank lines has
 *     to sit in a document that also contains actual prose.
 *   • Spreadsheets: the column the file already sorts by becomes the chapter
 *     list. A table with no such grouping gets nothing.
 *
 * Everything else is left as prose. Fewer, correct chapters beat many wrong
 * ones.
 */

export interface TextSection {
  title: string;
  /** Character offset into the text. */
  start: number;
  end: number;
}

/**
 * Rows in the text built from a CSV. A blank line between rows makes
 * the reader treat each row as its own sentence, so a spreadsheet is
 * read row by row instead of as one unbroken utterance. The cell
 * separator is a parameter; the row separator is not, because it is
 * the one thing the extractor and this module must agree on.
 */
export const CSV_ROW_SEPARATOR = '\n\n';

/** Longest line still plausibly a title. Chapter titles are rarely essays. */
const MAX_HEADING_CHARS = 80;
/** Fewest non-heading lines a document needs before any heading counts. */
const MIN_BODY_LINES = 2;
/**
 * How many lines of running prose a document must contain before its inferred
 * headings are believed.
 *
 * Two is the smallest number that tells a document with real chapters apart
 * from one that merely happens to be made of short lines.
 */
const MIN_PROSE_LINES = 2;
/** Shortest line that counts as a sentence rather than a fragment. */
const MIN_PROSE_CHARS = 20;

/** ATX heading: one to six `#`, then the title, with optional closing hashes. */
const ATX_HEADING = /^#{1,6}\s+(.*?)\s*#*$/;
/** Setext underline: `===` for level 1, `---` for level 2. */
const SETEXT_RULE = /^(={3,}|-{3,})$/;
/** Titles end without a full stop, comma, or the punctuation of a sentence. */
const SENTENCE_END = /[.,;:!?'"“”)\]}…]$/;
/** A sentence, closing punctuation and all. Length is covered separately. */
const SENTENCE_FINISH = /[.!?]["'”’)\]]?$/;

/** One line and where it starts. */
interface LineInfo {
  text: string;
  start: number;
  end: number;
  /** Blank lines separate paragraphs; they carry no content. */
  blank: boolean;
}

function splitLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    lines.push({
      text: trimmed,
      start: offset,
      end: offset + raw.length,
      blank: trimmed.length === 0,
    });
    offset += raw.length + 1; // +1 for the '\n' this line consumed
  }
  return lines;
}

/** The title an ATX heading line declares, or null. */
function atxTitle(line: string): string | null {
  const atx = ATX_HEADING.exec(line);
  return atx ? (atx[1].trim() || null) : null;
}

/**
 * Sections for a plain-text or Markdown document, or [] when nothing in the
 * layout reads as structure.
 *
 * The result is ordered, non-overlapping, and spans the whole text: each
 * section runs to the next heading, the last to the end. A heading that is
 * never followed by body text — a trailing title, a document that is nothing
 * but a heading — yields no sections at all rather than a chapter list with a
 * single empty entry.
 */
export function sectionsFromPlainText(text: string): TextSection[] {
  if (!text.trim()) return [];
  const lines = splitLines(text);
  const headings: Array<{ title: string; start: number; explicit: boolean }> = [];

  for (const [index, line] of lines.entries()) {
    if (line.blank) continue;
    const next = lines[index + 1];

    const atx = atxTitle(line.text);
    if (atx) {
      headings.push({ title: atx, start: line.start, explicit: true });
      continue;
    }

    // Setext heading: a short line underlined by === or ---.
    if (next && !next.blank && SETEXT_RULE.test(next.text) && line.text.length <= MAX_HEADING_CHARS) {
      headings.push({ title: line.text, start: line.start, explicit: true });
      continue;
    }
    // Prose convention: a short line that ends its own paragraph — the line
    // after it is blank (or the text ends), and the line before it is blank
    // or the document opens here. Nothing that reads as a sentence may follow
    // it on the same paragraph.
    const before = lines[index - 1];
    const startsParagraph = (!before || before.blank) && (!next || next.blank);
    if (startsParagraph
      && line.text.length > 0
      && line.text.length <= MAX_HEADING_CHARS
      // A rule of dashes or equals is a horizontal break, not a title, even
      // though it sits alone between blank lines like one would.
      && !SETEXT_RULE.test(line.text)
      && !SENTENCE_END.test(line.text)) {
      headings.push({ title: line.text, start: line.start, explicit: false });
    }
  }

  if (headings.length === 0) return [];

  // Every heading needs something to be a heading *of*. A document that is
  // nothing but a title gets no sections: one chapter named after the document
  // is not a chapter track.
  const bodyLines = lines.filter(line => !line.blank && !ATX_HEADING.test(line.text)).length;
  if (bodyLines < MIN_BODY_LINES) return [];

  // Inferred headings additionally need the document to read as prose. Song
  // lyrics, a meeting agenda, and chat logs are all short lines alone between
  // blank lines, and every one of them passes the heading test; what none of
  // them have is a sentence of running text. A chapter per lyric line is noise,
  // not navigation.
  //
  // Explicit Markdown markers skip this: an author who typed `#` on every line
  // said what they meant, whatever the surrounding prose looks like.
  if (!headings.some(heading => heading.explicit)) {
    const proseLines = lines.filter(line => !line.blank
      && line.text.length >= MIN_PROSE_CHARS
      && SENTENCE_FINISH.test(line.text)).length;
    if (proseLines < MIN_PROSE_LINES) return [];
  }

  const seen = new Set<string>();
  const deduped = headings.filter(heading => {
    const key = heading.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!deduped.length) return [];

  return deduped.map((heading, index) => ({
    title: heading.title,
    start: heading.start,
    end: deduped[index + 1]?.start ?? text.length,
  }));
}

// ─── Spreadsheets ─────────────────────────────────────────────────

/** Fewest data rows before a column is worth treating as a grouping. */
const MIN_GROUP_ROWS = 3;

/**
 * The column that groups a table, or -1 when it has none.
 *
 * A column groups a table when each value occupies one unbroken run of rows —
 * every `North` row, then every `South` row, never alternating. That signature
 * is what distinguishes an ordered export (sales by region, tickets by
 * department) from a table that merely happens to contain repeated words, and
 * it is the reason the scan can reject almost every sheet by construction: an
 * unsorted table interleaves its values and fails immediately.
 *
 * Columns are tried left to right, so the leftmost grouping wins, which is
 * usually the one a reader would name the sheet after.
 */
function csvGroupingColumn(rows: string[][]): number {
  const data = rows.slice(1);
  if (data.length < MIN_GROUP_ROWS) return -1;
  const width = Math.max(...data.map(row => row.length));
  for (let column = 0; column < width; column++) {
    const values = data.map(row => (row[column] ?? '').trim());
    if (values.some(value => !value)) continue;
    // Collect every value first: stopping at the first repeat would leave the
    // set half-built and the "more than one value" test would reject a column
    // that has three groups simply because the second row repeated the first.
    const seen = new Set(values);
    // A grouping has to repeat, and has to have more than one value: a column
    // with a different value on every row identifies nothing.
    if (seen.size < 2 || seen.size >= values.length) continue;
    // Every value must be one unbroken run: its first and last positions have
    // to be exactly as far apart as its number of occurrences.
    const interleaved = [...seen].some(value => {
      const indices = values.map((v, i) => (v === value ? i : -1)).filter(i => i >= 0);
      return indices[indices.length - 1] - indices[0] !== indices.length - 1;
    });
    if (interleaved) continue;
    return column;
  }
  return -1;
}

/**
 * Sections for a table read as prose.
 *
 * A spreadsheet has no headings, so a chapter has to come from the data. The
 * one grouping that means something to a listener is the one the file already
 * sorts by: chapters named for each run of rows sharing a value.
 *
 * When no column groups the table, this returns nothing. A list of records
 * with no order to it has no chapters, and inventing evenly-sized ones would
 * put chapter markers in places that mean nothing.
 *
 * The offsets assume the caller's text is the rows joined with `cellSeparator`
 * and blank lines — the layout `extractCsv` produces.
 */
export function sectionsFromCsvRows(rows: string[][], cellSeparator = ', '): TextSection[] {
  const column = csvGroupingColumn(rows);
  if (column < 0) return [];
  const starts: number[] = [];
  let offset = 0;
  for (const [index, row] of rows.entries()) {
    if (index > 0) offset += CSV_ROW_SEPARATOR.length;
    starts.push(offset);
    offset += row.join(cellSeparator).length;
  }

  const groups: Array<{ title: string; start: number }> = [];
  for (const [index, row] of rows.entries()) {
    if (index === 0) continue; // the header row names the columns, not a chapter
    const title = (row[column] ?? '').trim();
    if (!title) continue;
    if (groups[groups.length - 1]?.title === title) continue;
    groups.push({ title, start: starts[index] });
  }
  if (groups.length < 2) return [];

  const textEnd = starts[starts.length - 1] + rows[rows.length - 1].join(cellSeparator).length;
  return groups.map((group, index) => ({
    title: group.title,
    start: group.start,
    end: groups[index + 1]?.start ?? textEnd,
  }));
}
