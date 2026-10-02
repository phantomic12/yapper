/**
 * Worker-safe document extraction for every format that is not PDF or EPUB:
 * the ZIP/XML/text parsers (DOCX, DOC, ODT, RTF, XLSX, PPTX, CSV, HTML, TXT)
 * and the helpers they share.
 *
 * This module is the boundary the extraction worker is built around: it must
 * never import pdfjs, the OCR engines, or epubjs, so it runs unchanged on the
 * main thread or inside `document-extract.worker.ts`. DOMParser and File are
 * available in both, which is all these parsers need.
 */
import {
  blocksToTextHtmlAndSections,
  alignGridRow,
  gridsToTextAndHtml,
  slidesToTextAndHtml,
  type DocumentBlock,
  type DocumentRun,
  type DocumentGrid,
  type DocumentFrame,
} from './document-html';
import { CSV_ROW_SEPARATOR, sectionsFromCsvRows, sectionsFromPlainText } from './text-sections';
import { rtfParagraphs, parseCsv, type RtfParagraph } from './document-types';

/** What a format extractor produces, before the file identity is attached. */
export interface FormatExtraction {
  text: string;
  html?: string;
  sections?: Array<{ title: string; start: number; end: number }>;
}

export type FormatKind = 'docx' | 'doc' | 'odt' | 'rtf' | 'xlsx' | 'pptx' | 'csv' | 'html' | 'text';

/** Wire protocol between the page and document-extract.worker.ts. */
export interface FormatWorkerRequest {
  id: number;
  kind: FormatKind;
  file: File;
}

export type FormatWorkerResponse =
  | { id: number; ok: true; doc: FormatExtraction }
  | { id: number; ok: false; error: string }
  | { id: number; progress: string };

export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}


export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ─── DOCX extraction ──────────────────────────────────────────────

/** True when a `w:rPr` child like `w:b`/`w:i` is on (absent val means on). */
function docxFlagOn(run: Element, tag: string): boolean {
  const flags = run.getElementsByTagName(tag);
  if (!flags.length) return false;
  const val = flags[0].getAttribute('w:val');
  return val === null || !/^(0|false|off)$/i.test(val);
}

/**
 * Runs of one paragraph, with formatting.
 *
 * Falls back to a single unstyled run if the runs do not reconstruct the
 * paragraph's text exactly. The text is the contract — the reader segments it
 * and every offset in the document points into it — so when formatting and
 * text conflict, formatting loses. That keeps a DOCX with unusual markup (a
 * `w:t` outside any `w:r`, say) from silently shifting every offset in the
 * file by a character or two.
 */
function docxParagraphRuns(p: Element): DocumentRun[] {
  const whole = Array.from(p.getElementsByTagName('w:t'))
    .map(t => t.textContent ?? '')
    .join('');
  if (!whole.length) return [];

  const runs: DocumentRun[] = [];
  for (const r of Array.from(p.getElementsByTagName('w:r'))) {
    const text = Array.from(r.getElementsByTagName('w:t'))
      .map(t => t.textContent ?? '')
      .join('');
    if (!text) continue;
    runs.push({ text, bold: docxFlagOn(r, 'w:b'), italic: docxFlagOn(r, 'w:i') });
  }

  if (runs.length === 0 || runs.map(r => r.text).join('') !== whole) {
    return [{ text: whole }];
  }
  return runs;
}

/** Map a paragraph's style to a block kind, defaulting to a plain paragraph. */
function docxParagraphKind(p: Element): DocumentBlock['kind'] {
  if (p.getElementsByTagName('w:numPr').length > 0) return 'li';
  const style = p.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') ?? '';
  if (/^title$/i.test(style)) return 'h1';
  const heading = style.match(/^heading\s*(\d)/i);
  if (heading) {
    const level = Number(heading[1]);
    return level <= 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
  }
  return 'p';
}

async function extractDocx(file: File): Promise<FormatExtraction> {
  // We use manual XML parsing instead of mammoth because mammoth's internal
  // xmldom wrapper calls DOMParser.parseFromString() without a mimeType,
  // which fails in modern browsers. Manual parsing of w:t runs covers the
  // vast majority of DOCX text content (paragraphs, tables, lists).
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await readArrayBuffer(file));
  const xmlText = await zip.file('word/document.xml')?.async('text');
  if (!xmlText) throw new Error('Invalid DOCX: missing word/document.xml');

  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const blocks: DocumentBlock[] = [];
  for (const p of Array.from(xml.getElementsByTagName('w:p'))) {
    const runs = docxParagraphRuns(p);
    if (!runs.length) continue;
    blocks.push({ kind: docxParagraphKind(p), runs });
  }

  // One pass produces all three, so the markup's stamped ranges and the
  // section offsets are guaranteed to be offsets into the text the reader is
  // going to segment. DOCX declares its own heading styles, so they become
  // the document's chapters.
  const { text, html, sections } = blocksToTextHtmlAndSections(blocks);
  return { text, html: html || undefined, sections: sections.length ? sections : undefined };
}

// ─── DOC (legacy Word binary) extraction ──────────────────────────
// The .doc format is a complex binary OLE container. Full parsing would
// require a dedicated library (e.g. antiword or libreoffice). We do a
// best-effort extraction: strip non-printable bytes and OLE overhead,
// then clean up the result. This works for simple documents but may
// produce noise for complex ones. Mammoth does not support .doc.

async function extractDoc(file: File): Promise<FormatExtraction> {
  const arrayBuffer = await readArrayBuffer(file);
  const bytes = new Uint8Array(arrayBuffer);
  // Extract printable ASCII + common UTF-8 sequences from the binary.
  // The WordDocument stream contains text as either Latin-1 or UTF-16LE.
  // We try UTF-16LE first (most common in modern .doc files), then fall
  // back to Latin-1.
  const text = extractTextFromDocBinary(bytes);
  if (!text.trim()) {
    throw new Error(
      'Could not extract text from .doc file. ' +
      'Try converting it to .docx or .pdf for better results.',
    );
  }
  return { text: text.trim() };
}

function extractTextFromDocBinary(bytes: Uint8Array): string {
  // Try UTF-16LE decoding first — .doc files typically store text this way.
  // We look for runs of valid UTF-16LE characters (printable ASCII range
  // in the low byte, zero in the high byte).
  const parts: string[] = [];
  let i = 0;
  let current: number[] = [];

  while (i < bytes.length - 1) {
    const lo = bytes[i];
    const hi = bytes[i + 1];
    // Printable ASCII or common Latin-1 in UTF-16LE
    if (hi === 0 && lo >= 0x20 && lo <= 0x7e) {
      current.push(lo);
      i += 2;
    } else if (hi === 0 && lo === 0x0a) {
      // Newline
      if (current.length) {
        parts.push(String.fromCharCode(...current));
        current = [];
      }
      i += 2;
    } else if (hi === 0 && lo >= 0xa0 && lo <= 0xff) {
      // Latin-1 supplement
      current.push(lo);
      i += 2;
    } else {
      // Non-text byte — flush current run
      if (current.length >= 3) {
        parts.push(String.fromCharCode(...current));
      }
      current = [];
      i += 1;
    }
  }
  if (current.length >= 3) {
    parts.push(String.fromCharCode(...current));
  }

  return parts
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .join('\n');
}

// ─── RTF extraction ───────────────────────────────────────────────

/**
 * The body font size of an RTF document: the size most of its characters are
 * set in. Headings are *larger* than this, so the comparison has to be
 * relative — a document at 10pt body has no 24pt "Heading 1" in the absolute
 * sense, only a bigger one.
 */
function rtfBodyFontSize(paragraphs: RtfParagraph[]): number {
  const weight = new Map<number, number>();
  for (const paragraph of paragraphs) {
    if (!paragraph.maxFontSize) continue;
    const chars = Math.max(1, paragraph.text.length);
    weight.set(paragraph.maxFontSize, (weight.get(paragraph.maxFontSize) ?? 0) + chars);
  }
  let best = 0;
  let bestWeight = 0;
  for (const [size, chars] of weight) {
    if (chars > bestWeight) { bestWeight = chars; best = size; }
  }
  return best;
}

/**
 * RTF paragraphs as document blocks, with headings marked.
 *
 * Two sources, in order of trust. The document's own stylesheet is
 * authoritative: `\s1` mapped to "heading 1" is a declaration, not a guess.
 * Only when there is no stylesheet does this fall back to how a paragraph
 * *looks* — fully bold, in a font larger than the document's body size — which
 * is what every writer does when the stylesheet is absent.
 *
 * A document that declares no styles and never enlarges a font has no
 * headings we can honestly claim, and gets none.
 */
function rtfToBlocks(paragraphs: RtfParagraph[]): DocumentBlock[] {
  const bodySize = rtfBodyFontSize(paragraphs);
  const hasStylesheet = paragraphs.some(p => p.stylesheetLevel > 0);
  return paragraphs.map(paragraph => {
    let level = paragraph.stylesheetLevel;
    if (!level && !hasStylesheet && paragraph.allBold && paragraph.maxFontSize > bodySize && bodySize > 0) {
      // Proportion decides the depth: a title set at twice the body size is a
      // level 1, a section heading at a third more is a level 2.
      const ratio = paragraph.maxFontSize / bodySize;
      level = ratio >= 1.6 ? 1 : 2;
    }
    return {
      kind: (level === 1 ? 'h1' : level === 2 ? 'h2' : level ? 'h3' : 'p') as DocumentBlock['kind'],
      runs: [{ text: paragraph.text }],
    };
  });
}

async function extractRtf(file: File): Promise<FormatExtraction> {
  const rtf = await readTextFile(file);
  const paragraphs = rtfParagraphs(rtf);
  if (!paragraphs.length) {
    throw new Error('Could not extract text from RTF file (file may be empty or corrupted).');
  }
  const { text, html, sections } = blocksToTextHtmlAndSections(rtfToBlocks(paragraphs));
  if (!text.trim()) {
    throw new Error('Could not extract text from RTF file (file may be empty or corrupted).');
  }
  return { text, html: html || undefined, sections: sections.length ? sections : undefined };
}

// ─── HTML extraction ──────────────────────────────────────────────

/** Elements that never carry readable content. */
const HTML_NOISE = 'script, style, noscript, template, svg, math, iframe, object, embed, head';

/**
 * Block-level elements worth their own paragraph in the extracted text.
 *
 * `tr` rather than `td`: a table row spoken as one block reads as a sentence,
 * where each cell on its own line is a column of disconnected words.
 */
const HTML_BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, figcaption, dt, dd, tr';

/**
 * Elements that hold content without being it — the workhorses of hand-written
 * and generated HTML alike.
 *
 * A `<div>` full of `<p>`s must not become a block itself, or the paragraphs
 * inside it would be swallowed; one holding only loose text has to become a
 * block, or that text would be glued to the next element with no separator and
 * the sentences would run together.
 */
const HTML_CONTAINERS = 'div, section, article, main, aside, header, footer, body, span, li, dt, dd';

/** Elements that are blocks in their own right, at any nesting depth. */
const HTML_SELECTOR = `${HTML_BLOCKS}, ${HTML_CONTAINERS}`;

/** Map an HTML tag to a block kind; only h1–h3 exist as distinct levels. */
function htmlBlockKind(el: Element): DocumentBlock['kind'] {
  const tag = el.tagName.toLowerCase();
  if (tag === 'h1') return 'h1';
  if (tag === 'h2') return 'h2';
  if (tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'h3';
  if (tag === 'li') return 'li';
  return 'p';
}

/**
 * The runs of an element, marking bold and italic.
 *
 * Formatting is a bonus here, not the goal: HTML is the one format where the
 * author wrote `<strong>` rather than declared a style, so recognising it is
 * nearly free. Nesting is handled by walking children and folding the current
 * bold/italic state into each text run.
 */
function htmlRuns(el: Element, bold = false, italic = false): DocumentRun[] {
  const runs: DocumentRun[] = [];
  const push = (text: string, b: boolean, i: boolean) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && !!last.bold === b && !!last.italic === i) last.text += text;
    else runs.push({ text, bold: b || undefined, italic: i || undefined });
  };
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      push(node.textContent ?? '', bold, italic);
    } else if (node.nodeType === 1) {
      const child = node as Element;
      const tag = child.tagName.toLowerCase();
      const childBold = bold || tag === 'strong' || tag === 'b';
      const childItalic = italic || tag === 'em' || tag === 'i';
      // A nested block gets its own entry; do not fold its text into this one
      // as well, or every heading would also appear inside the paragraph above.
      if (child.matches(HTML_BLOCKS)) continue;
      // A container with block children is a wrapper, not a unit of text; its
      // children are walked in their own right.
      if (child.matches(HTML_CONTAINERS) && child.querySelector(HTML_BLOCKS)) continue;
      if (tag === 'br') { push(' ', bold, italic); continue; }
      runs.push(...htmlRuns(child, childBold, childItalic));
    }
  }
  return runs;
}

/**
 * HTML's readable content as document blocks.
 *
 * The previous extractor read `body.textContent`, which threw away every
 * heading and produced one undifferentiated run of text — the reason HTML
 * documents could never get a chapter track. Walking block elements instead
 * recovers the structure the author wrote.
 *
 * Elements that merely *contain* blocks (`<div>`, `<section>`, `<ul>`) are not
 * themselves blocks, and a block nested inside another block is skipped in
 * favour of the inner one, so no text is ever counted twice.
 */
export function htmlToBlocks(root: Element): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  for (const el of Array.from(root.querySelectorAll(HTML_SELECTOR))) {
    if (el.closest(HTML_NOISE)) continue;
    if (el === root) continue;
    // A container only counts when there is nothing better inside it; otherwise
    // it would repeat its children's text. The same applies to a block that
    // wraps other blocks — `<blockquote><p>…</p></blockquote>` is quoted by its
    // inner paragraph, and dropping both would lose the quote entirely.
    if (el.querySelector(HTML_BLOCKS)) continue;
    // A table row is one block: its cells are joined so the row speaks as a
    // phrase, with the separator CSV extraction already established.
    const runs = el.tagName.toLowerCase() === 'tr'
      ? [{ text: Array.from(el.querySelectorAll('td, th'))
        .map(cell => collapseWhitespace(cell.textContent ?? ''))
        .filter(Boolean)
        .join(', ') }]
      : htmlRuns(el);
    const kept = runs.filter(run => run.text.trim().length > 0);
    if (!kept.length) continue;
    blocks.push({ kind: htmlBlockKind(el), runs: kept });
  }
  return blocks;
}

async function extractHtml(file: File): Promise<FormatExtraction> {
  const html = await readTextFile(file);
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;
  if (!body) throw new Error('Could not extract text from HTML file (no body content).');

  const { text, html: markup, sections } = blocksToTextHtmlAndSections(htmlToBlocks(body));
  if (!text.trim()) {
    // No block elements at all — a page of bare text nodes. Fall back to the
    // flattened body so a minimal HTML file still reads aloud.
    const fallback = collapseWhitespace(body.textContent ?? '');
    if (!fallback) throw new Error('Could not extract text from HTML file (no body content).');
    return { text: fallback };
  }
  return { text, html: markup || undefined, sections: sections.length ? sections : undefined };
}

// ─── CSV extraction ───────────────────────────────────────────────
// CSV is plain text — we read it and format rows as lines, preserving
// the tabular structure for TTS readability.

/** The cell separator CSV rows are joined with, for text and for offsets. */
const CSV_CELL_SEPARATOR = ', ';

async function extractCsv(file: File): Promise<FormatExtraction> {
  const csv = await readTextFile(file);
  if (!csv.trim()) {
    throw new Error('CSV file is empty.');
  }
  const rows = parseCsv(csv);
  const text = rows.map(row => row.join(CSV_CELL_SEPARATOR)).join(CSV_ROW_SEPARATOR);
  const sections = sectionsFromCsvRows(rows, CSV_CELL_SEPARATOR);
  return { text, sections: sections.length ? sections : undefined };
}

// ─── XLSX extraction ──────────────────────────────────────────────
// XLSX is a ZIP with XML sheets. We use JSZip (already a dependency) to
// read xl/worksheets/sheet*.xml and extract cell values from the shared
// strings table (xl/sharedStrings.xml).

/** Elements matched by local name so namespace prefixes cannot hide them. */
function elementsByLocalName(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter(el => el.localName === localName);
}

/** Resolve a workbook relationship target to its part path inside the zip. */
function normalizeXlsxPartPath(target: string): string {
  let decoded = target;
  try { decoded = decodeURIComponent(target); } catch { /* keep the raw form */ }
  const clean = decoded.replace(/^\.\//, '').replace(/^\//, '');
  return clean.startsWith('xl/') ? clean : `xl/${clean}`;
}

/**
 * Map worksheet part paths to the sheet names the workbook gave them.
 *
 * A workbook names its tabs (`<sheet name="Revenue" r:id="rId2"/>`) but the
 * worksheet XML is addressed by relationship (r:id → worksheets/sheet2.xml),
 * so the name has to be joined across xl/workbook.xml and
 * xl/_rels/workbook.xml.rels. Without this every grid renders as "Sheet N",
 * which is file order, not the name the user gave their tabs.
 */
export function xlsxSheetTitles(workbookXml: string, relsXml?: string): Record<string, string> {
  const parser = new DOMParser();
  const targets: Record<string, string> = {};
  if (relsXml) {
    const rels = parser.parseFromString(relsXml, 'application/xml');
    for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      const type = rel.getAttribute('Type') ?? '';
      if (id && target && type.endsWith('/worksheet')) {
        targets[id] = normalizeXlsxPartPath(target);
      }
    }
  }
  const titles: Record<string, string> = {};
  const workbook = parser.parseFromString(workbookXml, 'application/xml');
  for (const sheet of Array.from(workbook.getElementsByTagName('sheet'))) {
    const name = sheet.getAttribute('name')?.trim();
    const rid = sheet.getAttribute('r:id')
      ?? sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const path = rid ? targets[rid] : undefined;
    if (name && path) titles[path] = name;
  }
  return titles;
}

async function extractXlsx(file: File): Promise<FormatExtraction> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await readArrayBuffer(file));

  // Load shared strings table (maps string IDs to text)
  const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('text');
  const sharedStrings: string[] = [];
  if (sharedStringsXml) {
    const parser = new DOMParser();
    const ssDoc = parser.parseFromString(sharedStringsXml, 'application/xml');
    const siNodes = ssDoc.getElementsByTagName('si');
    for (const si of Array.from(siNodes)) {
      // Each <si> contains one or more <t> (text runs)
      const tNodes = si.getElementsByTagName('t');
      const text = Array.from(tNodes).map(t => t.textContent ?? '').join('');
      sharedStrings.push(text);
    }
  }

  // The user's own tab names, joined to worksheet parts by relationship id.
  const workbookXml = await zip.file('xl/workbook.xml')?.async('text');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('text');
  const sheetTitles = workbookXml ? xlsxSheetTitles(workbookXml, relsXml) : {};

  // Find and parse all worksheets
  const sheetFiles = Object.keys(zip.files).filter(path => /^xl\/worksheets\/sheet\d+\.xml$/.test(path));
  if (sheetFiles.length === 0) throw new Error('Invalid XLSX: no worksheets found');

  const parser = new DOMParser();
  const grids: DocumentGrid[] = [];

  for (const sheetPath of sheetFiles.sort()) {
    const sheetXml = await zip.file(sheetPath)?.async('text');
    if (!sheetXml) continue;
    const sheetDoc = parser.parseFromString(sheetXml, 'application/xml');
    const rows = sheetDoc.getElementsByTagName('row');
    const gridRows: string[][] = [];
    for (const row of Array.from(rows)) {
      const cells = row.getElementsByTagName('c');
      const parsedCells: Array<{ ref?: string; text: string }> = [];
      for (const cell of Array.from(cells)) {
        const type = cell.getAttribute('t');
        const valueNode = cell.getElementsByTagName('v')[0];
        const value = valueNode?.textContent ?? '';
        if (type === 's') {
          // Shared string reference
          const idx = parseInt(value, 10);
          parsedCells.push({ ref: cell.getAttribute('r') ?? undefined, text: sharedStrings[idx] ?? '' });
        } else if (type === 'inlineStr') {
          // Inline string
          const tNode = cell.getElementsByTagName('t')[0];
          parsedCells.push({ ref: cell.getAttribute('r') ?? undefined, text: tNode?.textContent ?? '' });
        } else {
          // Number or other
          parsedCells.push({ ref: cell.getAttribute('r') ?? undefined, text: value });
        }
      }
      const cellTexts = alignGridRow(parsedCells);
      if (cellTexts.some(t => t.trim())) gridRows.push(cellTexts);
    }
    if (gridRows.length) {
      const fallback = `Sheet ${sheetPath.match(/sheet(\d+)\.xml$/)?.[1] ?? grids.length + 1}`;
      // Rows join with the grid default (a blank line), so the
      // reader speaks a spreadsheet row by row, as it does for CSV.
      grids.push({ title: sheetTitles[sheetPath] || fallback, rows: gridRows, delimiter: ', ' });
    }
  }

  const built = gridsToTextAndHtml(grids);
  if (!built.text) throw new Error('XLSX file contains no text data.');
  return { text: built.text, html: built.html, sections: built.sections };
}

// ─── PPTX extraction ──────────────────────────────────────────────
// PPTX is a ZIP with XML slides. Text lives in DrawingML <a:t> runs inside
// positioned shapes (<p:sp>), so the extractor keeps both the words and the
// geometry: the words under the same join contract extraction has always
// had, the geometry as percent-of-slide frames the view places text by.

/** Slide dimensions in Office EMUs (914400 per inch). */
export interface PptxSlideSize {
  cx: number;
  cy: number;
}

/** Read the declared slide size from ppt/presentation.xml. */
export function pptxSlideSize(presentationXml: string): PptxSlideSize | null {
  const doc = new DOMParser().parseFromString(presentationXml, 'application/xml');
  const sldSz = elementsByLocalName(doc, 'sldSz')[0];
  const cx = Number(sldSz?.getAttribute('cx'));
  const cy = Number(sldSz?.getAttribute('cy'));
  return Number.isFinite(cx) && cx > 0 && Number.isFinite(cy) && cy > 0 ? { cx, cy } : null;
}

function pptxShapeFrame(shape: Element, size: PptxSlideSize | null): DocumentFrame | null {
  if (!size) return null;
  const xfrm = elementsByLocalName(shape, 'xfrm')[0];
  if (!xfrm) return null;
  const off = elementsByLocalName(xfrm, 'off')[0];
  const ext = elementsByLocalName(xfrm, 'ext')[0];
  const x = Number(off?.getAttribute('x'));
  const y = Number(off?.getAttribute('y'));
  const width = Number(ext?.getAttribute('cx'));
  const height = Number(ext?.getAttribute('cy'));
  if (![x, y, width, height].every(value => Number.isFinite(value)) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: (x / size.cx) * 100,
    y: (y / size.cy) * 100,
    width: (width / size.cx) * 100,
    height: (height / size.cy) * 100,
  };
}

function isTitlePlaceholder(shape: Element): boolean {
  const ph = elementsByLocalName(shape, 'ph')[0];
  const type = ph?.getAttribute('type') ?? '';
  return type === 'title' || type === 'ctrTitle';
}

function paragraphAlign(paragraph: Element): DocumentBlock['align'] {
  const pPr = elementsByLocalName(paragraph, 'pPr')[0];
  const algn = pPr?.getAttribute('algn') ?? '';
  return algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'l' ? 'left' : undefined;
}

/**
 * Parse one slide into text blocks carrying their shape geometry.
 *
 * The text contract is deliberately unchanged from the flat extraction this
 * replaces: every DrawingML run keeps its trimmed text, runs join with spaces
 * inside a paragraph, and paragraphs join with spaces across the slide (see
 * `separatorBefore`). Only the presentation of that text gained geometry.
 */
export function pptxSlideBlocks(
  slideXml: string,
  size: PptxSlideSize | null,
): { blocks: DocumentBlock[]; aspect?: number } {
  const doc = new DOMParser().parseFromString(slideXml, 'application/xml');
  const entries: Array<{
    text: string;
    frame: DocumentFrame | null;
    align: DocumentBlock['align'];
    titleShape: boolean;
  }> = [];
  let hasTitleShape = false;

  for (const shape of elementsByLocalName(doc, 'sp')) {
    const body = elementsByLocalName(shape, 'txBody')[0];
    if (!body) continue;
    const titleShape = isTitlePlaceholder(shape);
    if (titleShape) hasTitleShape = true;
    const frame = pptxShapeFrame(shape, size);
    for (const paragraph of elementsByLocalName(body, 'p')) {
      const text = elementsByLocalName(paragraph, 't')
        .map(node => (node.textContent ?? '').trim()).filter(Boolean).join(' ');
      if (!text.trim()) continue;
      entries.push({ text, frame, align: paragraphAlign(paragraph), titleShape });
    }
  }

  // The slide heading is the title placeholder's first paragraph; decks with
  // no title placeholder head with their first paragraph, as extraction has
  // always done.
  let headingUsed = false;
  const blocks: DocumentBlock[] = entries.map((entry, index) => {
    const useHeading = !headingUsed && (entry.titleShape || (!hasTitleShape && index === 0));
    if (useHeading) headingUsed = true;
    return {
      kind: useHeading ? 'h2' : 'p',
      runs: [{ text: entry.text }],
      ...(index > 0 ? { separatorBefore: ' ' } : {}),
      ...(entry.frame ? { frame: entry.frame } : {}),
      ...(entry.align ? { align: entry.align } : {}),
    };
  });

  return {
    blocks,
    ...(size ? { aspect: size.cx / size.cy } : {}),
  };
}

async function extractPptx(file: File): Promise<FormatExtraction> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await readArrayBuffer(file));

  const slideFiles = Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  if (slideFiles.length === 0) throw new Error('Invalid PPTX: no slides found');

  const presentationXml = await zip.file('ppt/presentation.xml')?.async('text');
  const size = presentationXml ? pptxSlideSize(presentationXml) : null;
  const slides: Array<{ blocks: DocumentBlock[]; aspect?: number }> = [];

  // Sort slides by number (slide1.xml, slide2.xml, ... slide10.xml)
  slideFiles.sort((a, b) => {
    const numA = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
    const numB = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
    return numA - numB;
  });

  for (const slidePath of slideFiles) {
    const slideXml = await zip.file(slidePath)?.async('text');
    if (!slideXml) continue;
    const parsed = pptxSlideBlocks(slideXml, size);
    if (parsed.blocks.length) slides.push(parsed);
  }

  const built = slidesToTextAndHtml(slides);
  if (!built.text) throw new Error('PPTX file contains no text data.');
  return { text: built.text, html: built.html, sections: built.sections };
}

// ─── ODT extraction ──────────────────────────────────────────────

const ODT_TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';

/**
 * Is this element a paragraph inside a list item?
 *
 * Walks up rather than trusting the immediate parent: ODT puts the text in a
 * `text:p` nested inside `text:list-item`, and a nested list hangs off that
 * same item, so an inner item's paragraph is two list levels up. The walk
 * stops at the first ancestor that is neither a list nor a list item, so a
 * paragraph after a list is not mistaken for one inside it.
 */
function odtInListItem(el: Element): boolean {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const name = node.localName;
    if (name === 'list-item') return true;
    if (name !== 'list' && name !== 'list-header') return false;
  }
  return false;
}

/**
 * ODT's block elements as document blocks.
 *
 * Headings are `text:h`, not `text:p`, and carry their depth in
 * `text:outline-level`. The previous extractor queried only `text:p`, so every
 * heading in an ODT file was dropped from the text outright — the content was
 * not just unstructured, it was missing.
 */
export function odtToBlocks(root: Element | Document): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    const name = el.localName;
    let kind: DocumentBlock['kind'] | null = null;
    if (name === 'p') kind = odtInListItem(el) ? 'li' : 'p';
    else if (name === 'h') {
      const level = Number(el.getAttributeNS(ODT_TEXT_NS, 'outline-level'));
      kind = level <= 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
    } else if (name === 'list-item') {
      // Only reached when the item holds its text directly, with no nested
      // paragraph — otherwise the paragraph above is the block.
      kind = 'li';
    }
    if (!kind) continue;
    // Nested content (a list inside a list) is walked in its own right.
    if (Array.from(el.children).some(child => child.localName === 'p'
      || child.localName === 'h' || child.localName === 'list')) continue;
    const text = collapseWhitespace(el.textContent ?? '');
    if (!text) continue;
    blocks.push({ kind, runs: [{ text }] });
  }
  return blocks;
}

async function extractOdt(file: File): Promise<FormatExtraction> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await readArrayBuffer(file));
  const xmlText = await zip.file('content.xml')?.async('text');
  if (!xmlText) throw new Error('Invalid ODT: missing content.xml');

  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const { text, html, sections } = blocksToTextHtmlAndSections(odtToBlocks(xml));
  if (!text.trim()) throw new Error('Could not extract text from ODT file (file may be empty).');
  return { text, html: html || undefined, sections: sections.length ? sections : undefined };
}

// ─── Format dispatch ────────────────────────────────────────

/** Map a detected MIME type to a worker-safe extraction kind. */
export function formatKindForMime(mime: string): FormatKind | null {
  switch (mime) {
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'application/msword': return 'doc';
    case 'application/vnd.oasis.opendocument.text': return 'odt';
    case 'application/rtf': return 'rtf';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'pptx';
    case 'text/csv': return 'csv';
    case 'text/html': return 'html';
    case 'text/plain':
    case 'text/markdown': return 'text';
    default: return null;
  }
}

/** Extract one worker-safe format. Shared by the page and the worker. */
export async function extractFormat(kind: FormatKind, file: File): Promise<FormatExtraction> {
  switch (kind) {
    case 'docx': return extractDocx(file);
    case 'doc': return extractDoc(file);
    case 'odt': return extractOdt(file);
    case 'rtf': return extractRtf(file);
    case 'xlsx': return extractXlsx(file);
    case 'pptx': return extractPptx(file);
    case 'csv': return extractCsv(file);
    case 'html': return extractHtml(file);
    case 'text': {
      const text = await readTextFile(file);
      // Plain text and Markdown declare no structure, so chapters are
      // inferred from the layout. Nothing recognisable means no sections.
      const sections = sectionsFromPlainText(text);
      return { text, sections: sections.length ? sections : undefined };
    }
  }
}
