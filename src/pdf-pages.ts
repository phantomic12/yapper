// ─── Assembling PDF pages into reader text ───────────────────────
// pdfjs (and OCR) hand back lines with geometry attached. The reader wants
// one string plus anchors that point into it, and the two cleanups —
// dropping running headers/footers and applying OCR corrections — both
// change the text. They cannot run after the join: the moment lines are
// concatenated, "character 4,182" no longer knows which rectangle it came
// from, and a correction that shortens a line would shift every later
// highlight.
//
// So the passes run here, while the page/line structure still exists, and
// the character offsets are computed only once, over the text that will
// actually be read. This module is deliberately DOM-free and pdf-free:
// the extraction loop in document-reader.ts produces `PdfPageLine[]`, and
// everything that is easy to get subtly wrong (separators, offsets,
// dropped lines) is testable without a real PDF.

import type { TextAnchor } from './document-types';
import {
  createCorrectionApplier,
  type CorrectionRule,
} from './corrections';
import {
  detectPageMargins,
  type MarginSuppressionOptions,
} from './header-footer';

export interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One text run inside a line, with offsets relative to the line's text. */
export interface PdfLineRun extends PdfBox {
  start: number;
  end: number;
}

/**
 * One extracted line. OCR produces whole-line `rect`s; the PDF text layer
 * produces per-item `runs` so a highlight can land on the words it covers.
 */
export interface PdfPageLine {
  text: string;
  rect?: PdfBox;
  runs?: PdfLineRun[];
}

/** Structurally identical to document-reader.ts's LayoutBlock. */
export interface PdfLayoutBlock extends PdfBox {
  page: number;
  text: string;
}

export interface PdfAssemblyOptions {
  /** Rules applied once per line. Pass `[]` for no corrections. */
  corrections?: readonly CorrectionRule[];
  /** Drop repeating page headers/footers before corrections run. */
  stripPageMargins?: boolean;
  marginOptions?: MarginSuppressionOptions;
}

export interface PdfAssemblyResult {
  text: string;
  anchors: TextAnchor[];
  layoutBlocks: PdfLayoutBlock[];
  /** Lines dropped as repeated page furniture. */
  removedLines: number;
  /** Individual find/replace substitutions made. */
  replacements: number;
}

/**
 * The separator between two extracted lines.
 *
 * Two newlines, not one: a single newline is how the sentence segmenter
 * says "same paragraph", and a PDF line break is nearly always a wrap
 * rather than a paragraph boundary. `\n\n` lets the reader pace a page
 * without treating every visual line as its own sentence.
 */
export const PDF_LINE_SEPARATOR = '\n\n';

function unionBox(runs: readonly PdfLineRun[]): PdfBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const run of runs) {
    x0 = Math.min(x0, run.x);
    y0 = Math.min(y0, run.y);
    x1 = Math.max(x1, run.x + run.width);
    y1 = Math.max(y1, run.y + run.height);
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * Turn per-page lines into the string the reader speaks, with anchors,
 * OCR layout blocks, and both cleanups applied.
 *
 * Suppression runs first, on the raw text: corrections can make two
 * different headers look alike (or alike headers differ), and the margin
 * heuristic should judge the page as it was extracted. Corrections then run
 * per line — a rule cannot repair a phrase split across a line break, but
 * limiting it to one line keeps every offset inside that line's anchors.
 */
export function assemblePdfPages(
  pages: readonly (readonly PdfPageLine[])[],
  options: PdfAssemblyOptions = {},
): PdfAssemblyResult {
  const marginOptions = options.marginOptions;
  const suppression = options.stripPageMargins
    ? detectPageMargins(pages.map(page => page.map(line => line.text)), marginOptions)
    : null;
  const corrections = options.corrections ?? [];
  // Built once for the whole document: every line goes through the same
  // indexed rule set.
  const correct = corrections.length ? createCorrectionApplier(corrections) : null;

  const parts: string[] = [];
  const anchors: TextAnchor[] = [];
  const layoutBlocks: PdfLayoutBlock[] = [];
  let offset = 0;
  let removedLines = 0;
  let replacements = 0;

  pages.forEach((lines, pageIndex) => {
    const page = pageIndex + 1;
    lines.forEach((line, lineIndex) => {
      if (suppression?.drop[pageIndex]?.[lineIndex]) {
        removedLines += 1;
        return;
      }
      const corrected = correct ? correct(line.text) : null;
      const text = corrected ? corrected.text : line.text;
      if (!text.trim()) return;
      replacements += corrected?.replacements ?? 0;

      const start = offset;
      parts.push(text);
      offset += text.length + PDF_LINE_SEPARATOR.length;

      if (line.rect) {
        // OCR geometry is already one box for the whole line; corrections
        // change the text in place without moving the box.
        layoutBlocks.push({ page, text, ...line.rect });
        anchors.push({ page, ...line.rect, start, end: start + text.length });
        return;
      }
      const runs = line.runs;
      if (!runs?.length) return;
      if (corrected && corrected.replacements > 0) {
        // A substitution can change the length anywhere in the line, and
        // the per-run offsets are no longer trustworthy. Coarsen to a
        // line-wide anchor rather than paint a highlight in the wrong
        // place — the line is still highlighted, just less precisely.
        anchors.push({ page, ...unionBox(runs), start, end: start + text.length });
        return;
      }
      for (const run of runs) {
        anchors.push({
          page,
          x: run.x,
          y: run.y,
          width: run.width,
          height: run.height,
          start: start + run.start,
          end: start + run.end,
        });
      }
    });
  });

  return {
    text: parts.join(PDF_LINE_SEPARATOR),
    anchors,
    layoutBlocks,
    removedLines,
    replacements,
  };
}
