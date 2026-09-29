/**
 * Pure helpers for document routing. Kept in a separate file so they can
 * be unit-tested without pulling in pdfjs / tesseract / jszip / epubjs.
 */

export function getMimeType(ext: string, fallback: string): string {
  const e = ext.toLowerCase();
  // Documents
  if (e === 'pdf') return 'application/pdf';
  if (e === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (e === 'doc') return 'application/msword';
  if (e === 'odt') return 'application/vnd.oasis.opendocument.text';
  if (e === 'rtf') return 'application/rtf';
  if (e === 'epub') return 'application/epub+zip';
  // Spreadsheets
  if (e === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (e === 'csv') return 'text/csv';
  // Presentations
  if (e === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  // Web / markup
  if (e === 'html' || e === 'htm') return 'text/html';
  if (e === 'txt') return 'text/plain';
  if (e === 'md' || e === 'markdown') return 'text/markdown';
  return fallback;
}

export const MAX_PDF_PAGES = 500;

// ─── Page geometry ───────────────────────────────────────────────
// Pure functions, deliberately in this file rather than document-reader.ts:
// the viewer is the part most worth testing exhaustively, and it should not
// need a pdfjs worker, a canvas, or a 2MB engine shim to be exercised.

/**
 * One run of extracted text, located on the page it came from.
 *
 * Rectangles are in **viewport space at scale 1** for
 * `page.getViewport({ scale: 1 })` — top-left origin, pixels, page rotation
 * already applied. Storing them this way makes zoom exact rather than
 * approximate: pdfjs's viewport transform is linear in scale, so a rect
 * measured at scale 1 is exactly `scale` times larger at any other scale, with
 * rotation and page size already accounted for instead of being re-derived
 * (and re-got-wrong) on every render.
 */
export interface TextAnchor {
  /** 1-based page number. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Character offset into the extracted text where this run starts. */
  start: number;
  /** Character offset where this run ends (exclusive). */
  end: number;
}

/** A rectangle ready to be scaled and drawn over a rendered page. */
export interface SpanRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Do two rectangles sit on the same line of text?
 *
 * Judged by vertical overlap rather than by comparing baselines, because a
 * baseline is not something the anchors carry. Half the shorter height is the
 * threshold that survives a superscript in a footnote and still refuses to
 * merge a heading with the paragraph under it.
 */
function sameLine(a: SpanRect, b: SpanRect): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > Math.min(a.height, b.height) * 0.5;
}

/**
 * Collapse per-word rectangles into one rectangle per line.
 *
 * Without this a highlight over a normal sentence comes out as a barcode —
 * forty separate boxes with hairline gaps — because pdfjs emits one text item
 * per styled run, not per line. Merging is chained against the *accumulated*
 * line rather than the previous rect, so A-B-C on one line merges even when A
 * and C do not directly overlap.
 */
function mergeRectsOnPage(rects: SpanRect[]): SpanRect[] {
  const out: SpanRect[] = [];
  for (const rect of rects) {
    const line = out[out.length - 1];
    if (line && sameLine(line, rect)) {
      const right = Math.max(line.x + line.width, rect.x + rect.width);
      const bottom = Math.max(line.y + line.height, rect.y + rect.height);
      line.x = Math.min(line.x, rect.x);
      line.y = Math.min(line.y, rect.y);
      line.width = right - line.x;
      line.height = bottom - line.y;
    } else {
      out.push({ ...rect });
    }
  }
  return out;
}

/** First anchor whose end is past `offset`, assuming anchors are start-sorted. */
function firstAnchorPast(anchors: TextAnchor[], offset: number): number {
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].end > offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The rectangles covering characters `[start, end)` of the extracted text,
 * grouped by page.
 *
 * This is the whole bridge between "the reader is on sentence 412" and "draw
 * a box over the right lines of the right page". It is called continuously
 * during playback, so it binary-searches to the first candidate anchor rather
 * than scanning a 500-page document's worth of them for every sentence.
 */
export function rectsForSpan(
  anchors: TextAnchor[],
  start: number,
  end: number,
): Map<number, SpanRect[]> {
  const byPage = new Map<number, SpanRect[]>();
  if (!(end > start) || anchors.length === 0) return byPage;

  for (let i = firstAnchorPast(anchors, start); i < anchors.length; i++) {
    const a = anchors[i];
    // Anchors are pushed in document order, so their starts only increase and
    // everything from here on begins past the span.
    if (a.start >= end) break;
    if (a.end <= start) continue;
    const rect: SpanRect = { page: a.page, x: a.x, y: a.y, width: a.width, height: a.height };
    const list = byPage.get(a.page);
    if (list) list.push(rect);
    else byPage.set(a.page, [rect]);
  }

  for (const [page, rects] of byPage) byPage.set(page, mergeRectsOnPage(rects));
  return byPage;
}

/**
 * OCR backend selection for scanned PDFs.
 * - `tesseract`: rule-based OCR via Tesseract.js (fast, ~4MB WASM, good for
 *   clean printed text).
 * - `llm`: vision-language model OCR via Florence-2 (slower, ~200MB download,
 *   much better for complex layouts, varied fonts, and handwriting).
 */
export type OcrMode = 'tesseract' | 'llm';

// ─── OCR word types (shared between Tesseract and Florence-2 paths) ───

/** Axis-aligned bounding box word (Tesseract output format). */
export interface BboxWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence?: number;
}

/** 4-point polygon word (Florence-2 OCR_WITH_REGION output format). */
export interface QuadWord {
  text: string;
  /** [x1, y1, x2, y2, x3, y3, x4, y4] — 4-corner polygon in pixel coords */
  quad: number[];
}

/**
 * Convert a Florence-2 4-point quad to an axis-aligned bbox. Pure function
 * — lives here so it can be unit-tested without pulling in pdfjs/transformers.
 */
export function quadToBbox(word: QuadWord): BboxWord {
  const q = word.quad;
  const x0 = Math.min(q[0], q[2], q[4], q[6]);
  const y0 = Math.min(q[1], q[3], q[5], q[7]);
  const x1 = Math.max(q[0], q[2], q[4], q[6]);
  const y1 = Math.max(q[1], q[3], q[5], q[7]);
  return { text: word.text, bbox: { x0, y0, x1, y1 } };
}

/**
 * Extract the file extension (lowercase, no dot) from a file name. Returns
 * the empty string when no extension is present.
 */
export function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

// ─── RTF control-word stripper (pure, testable) ────────────────────

/**
 * Strip RTF control words and extract plain text. Handles Unicode escapes
 * (\uN?), hex escapes (\'XX), and converts \par/\line/\tab to whitespace.
 */
export function stripRtfControlWords(rtf: string): string {
  let out = '';
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '\\') {
      // Unicode escape: \uN? or \u-N?
      if (rtf[i + 1] === 'u' && (rtf[i + 2] === '-' || /\d/.test(rtf[i + 2]))) {
        let j = i + 2;
        if (rtf[j] === '-') j++;
        let numStr = '';
        while (j < rtf.length && /\d/.test(rtf[j])) {
          numStr += rtf[j];
          j++;
        }
        if (rtf[j] === '?') j++;
        if (numStr) {
          const code = parseInt(numStr, 10);
          const uint16 = code < 0 ? code + 0x10000 : code;
          out += String.fromCharCode(uint16);
        }
        i = j;
        continue;
      }
      // Hex escape: \'XX
      if (rtf[i + 1] === "'") {
        const hex = rtf.substring(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          continue;
        }
      }
      // Control word: \word
      let j = i + 1;
      while (j < rtf.length && /[a-zA-Z]/.test(rtf[j])) j++;
      const controlWord = rtf.substring(i + 1, j);
      if (rtf[j] === '-' || /\d/.test(rtf[j])) {
        if (rtf[j] === '-') j++;
        while (j < rtf.length && /\d/.test(rtf[j])) j++;
      }
      if (rtf[j] === ' ') j++;
      if (controlWord === 'par' || controlWord === 'line') {
        out += '\n';
      } else if (controlWord === 'tab') {
        out += '\t';
      }
      i = j;
      continue;
    }
    if (ch === '{' || ch === '}') {
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out
    .replace(/ {2,}/g, ' ')   // collapse multiple spaces (preserve tabs)
    .replace(/\t +/g, '\t')   // trim spaces after tabs
    .replace(/ +\t/g, '\t')   // trim spaces before tabs
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── CSV parser (pure, testable) ──────────────────────────────────

/**
 * Parse CSV text into rows of string fields. Handles quoted fields with
 * embedded commas, newlines, and escaped double-quotes ("").
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      currentField += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      if (text[i + 1] === '\n') i += 2;
      else i++;
      continue;
    }
    if (ch === '\n') {
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      i++;
      continue;
    }
    currentField += ch;
    i++;
  }
  if (currentField || currentRow.length) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }
  return rows;
}