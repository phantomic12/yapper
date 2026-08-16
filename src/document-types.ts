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