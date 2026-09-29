// Must come first: pdfjs 6.3 assumes a handful of built-ins that postdate
// this app's advertised engine floor (Chrome 128+), and without them every
// PDF import fails on Chrome 128–139. See the shim for the full list.
import './pdfjs-engine-shim.js';
import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { TextAnchor } from './document-types';
import {
  blocksToTextAndHtml,
  type DocumentBlock,
  type DocumentRun,
} from './document-html';
import { getOcrEngine } from './ocr';
import { getLlmOcrEngine } from './engines/llm-ocr';
import { engineSupportsPdfJs, pdfUnsupportedMessage } from './pdf-capability';
import { getMimeType, getFileExtension, MAX_PDF_PAGES, quadToBbox, stripRtfControlWords, parseCsv, type OcrMode, type BboxWord, type QuadWord } from './document-types';
export { getMimeType, getFileExtension, MAX_PDF_PAGES, type OcrMode, type BboxWord, type QuadWord, quadToBbox, stripRtfControlWords, parseCsv } from './document-types';

// PDF.js worker must be told where its worker script is. In Vite we copy the
// worker to public/ and reference it relative to the served page so it works on
// GitHub Pages subpaths as well as at the domain root.
function getPdfWorkerPath(): string {
  return new URL('pdf.worker.mjs', window.location.href).href;
}

export interface ExtractedDocument {
  /** Plain text extracted from the document. */
  text: string;
  /** For PDFs, optional per-page OCR layout blocks when OCR is enabled. */
  layoutBlocks?: LayoutBlock[];
  /**
   * Where runs of `text` sit on the page they came from, in character
   * offsets. This is what lets the reader show the actual document and move a
   * highlight over the real layout instead of over a wall of extracted text.
   *
   * It has to be produced *during* extraction. pdfjs hands us one text item
   * at a time with a position attached, and the moment those are joined into
   * a string the mapping from "character 4,182" back to "rectangle on page 7"
   * is gone — there is no way to recover it afterwards, which is why the
   * existing text-layer path reads `transform` only to detect line breaks and
   * throws the rest away.
   */
  anchors?: TextAnchor[];
  /**
   * Renderable markup for formats with no page geometry (DOCX, EPUB), where
   * the structure is real but there are no coordinates to anchor text to.
   *
   * Every element in it carries a `data-off="start:end"` stamp, and those
   * ranges are offsets into `text` — both produced together by
   * `blocksToTextAndHtml`, so a highlight is a lookup rather than a search for
   * the sentence somewhere in the rendered DOM. PDFs leave this undefined and
   * use `anchors` instead.
   */
  html?: string;
  /** Detected / declared MIME type. */
  mimeType: string;
  /** File name. */
  name: string;
}

export type { TextAnchor };

/**
 * Bounding box for one pdfjs text item, in scale-1 viewport space.
 *
 * This is pdfjs's own highlight recipe: compose the item's transform with the
 * viewport's, take the origin from the composed matrix, and step *up* by the
 * item height, because text space is bottom-left origin while viewport space
 * is top-left. Getting that sign wrong is the classic way to end up with
 * highlights mirrored onto the wrong lines of the page.
 *
 * Rotated text is flattened to an axis-aligned box. pdfjs's own viewer rotates
 * the rectangle by `atan2(tx[1], tx[0])`; this does not, which is exact for
 * the horizontal body text of essentially every book and slightly over-wide on
 * a rotated caption or a table header. Carrying the angle per anchor costs a
 * second rectangle and a rotation at every highlight, and is not worth
 * carrying until a document actually needs it.
 */
function textItemRect(
  viewport: { transform: number[] },
  item: TextItem,
): { x: number; y: number; width: number; height: number } {
  const tx = pdfjs.Util.transform(viewport.transform, item.transform);
  const height = item.height || Math.hypot(tx[2], tx[3]) || 10;
  return {
    x: tx[4],
    y: tx[5] - height,
    width: item.width || 0,
    height,
  };
}

export interface LayoutBlock {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractOptions {
  /** For PDFs only: render pages and run OCR instead of normal text extraction. */
  useOcr?: boolean;
  /**
   * Which OCR backend to use when `useOcr` is true.
   * - `tesseract` (default): Tesseract.js — fast, rule-based, ~4MB WASM.
   * - `llm`: Florence-2 vision-language model — slower, ~200MB download,
   *   but much better for complex layouts, varied fonts, and handwriting.
   */
  ocrMode?: OcrMode;
  /** Language passed to Tesseract (ignored for LLM mode). */
  ocrLang?: string;
  /** Optional progress callback for large documents. */
  onProgress?: (message: string) => void;
  /**
   * Maximum PDF pages to extract. Defaults to 500. A 1000-page PDF can OOM
   * the browser tab because pdfjs holds every page's content stream in
   * memory until the loop finishes. Callers can override when they know the
   * document is small (e.g. tests) by passing a lower number.
   */
  maxPdfPages?: number;
  /**
   * Kill-switch for the extraction stall watchdog (see withProgressWatchdog).
   * Defaults to enabled; tests may pass false to avoid real timers.
   */
  watchdogEnabled?: boolean;
  /** Override the stall deadline (ms). Defaults to EXTRACT_STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
}

/** Default time without a progress event before extraction is declared hung. */
export const EXTRACT_STALL_TIMEOUT_MS = 30_000;

export class ExtractionStalledError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Document extraction stalled (no progress for ${Math.round(timeoutMs / 1000)}s). ` +
      `The file may be corrupted, or the browser's document engine is too old — ` +
      `try a different browser or another format.`,
      );
    this.name = 'ExtractionStalledError';
  }
}

/**
 * Race `work` against a stall watchdog that fires when `onProgress` goes
 * quiet for longer than `timeoutMs`.
 *
 * Why this exists: pdfjs's worker protocol can hang without ever rejecting.
 * The known case is an engine without Promise.try running pdfjs 6 — every
 * worker round-trip throws before a reply is posted, so
 * `getDocument().promise` never settles and a plain try/catch in the caller
 * never runs (the await just hangs). Any progress-carrying extraction can be
 * wrapped; OCR paths call onProgress frequently enough that normal operation
 * resets the timer many times over.
 *
 * When the watchdog wins the race the returned promise rejects with
 * ExtractionStalledError; if `work` later settles it loses silently (its
 * value/error is dropped) — callers treat the rejection as terminal.
 */
export function withProgressWatchdog<T>(
  work: Promise<T>,
  timeoutMs: number,
  onProgress?: (message: string) => void,
): { promise: Promise<T>; onProgress: ((message: string) => void) | undefined } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveWork: (value: T) => void;
  let rejectWork: (reason: unknown) => void;

  const fail = () => {
    if (settled) return;
    settled = true;
    rejectWork(new ExtractionStalledError(timeoutMs));
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fail, timeoutMs);
  };
  const settleOk = (value: T) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveWork(value);
  };
  const settleErr = (reason: unknown) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    rejectWork(reason instanceof Error ? reason : new Error(String(reason)));
  };

  arm();
  // Every progress event pushes the deadline out; the wrapped callback is
  // what callers wire into their extraction pipeline, so feeding events
  // through it keeps the watchdog alive during normal (slow but moving)
  // work like OCR.
  const wrapped = onProgress
    ? (message: string) => {
        if (settled) return;
        arm();
        onProgress(message);
      }
    : undefined;

  const promise = new Promise<T>((resolve, reject) => {
    resolveWork = resolve;
    rejectWork = reject;
    work.then(settleOk, settleErr);
  });

  return { promise, onProgress: wrapped };
}

export async function extractDocument(file: File, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  const ext = getFileExtension(file.name);
  const mime = getMimeType(ext, file.type);
  options.onProgress?.(`Reading ${ext.toUpperCase()} file…`);

  // OCR is only meaningful for scanned/image PDFs. Catching it here gives
  // a clearer error than letting it silently no-op downstream.
  if (options.useOcr && mime !== 'application/pdf') {
    throw new Error(
      `OCR is only supported for PDFs; got ${mime || ext || 'unknown'}. ` +
      `Disable the OCR toggle for this document.`,
    );
  }

  // pdfjs 6 requires Promise.try; without it extraction hangs forever
  // instead of failing (see src/pdf-capability.ts). Fail fast with an
  // actionable message rather than sticking on "Reading PDF file…".
  if (mime === 'application/pdf' && !engineSupportsPdfJs()) {
    throw new Error(pdfUnsupportedMessage());
  }

  switch (mime) {
    case 'application/pdf':
      return extractPdf(file, options);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return { ...(await extractDocx(file)), mimeType: mime, name: file.name };
    case 'application/msword':
      return { ...(await extractDoc(file)), mimeType: mime, name: file.name };
    case 'application/vnd.oasis.opendocument.text':
      return { ...(await extractOdt(file)), mimeType: mime, name: file.name };
    case 'application/rtf':
      return { ...(await extractRtf(file)), mimeType: mime, name: file.name };
    case 'application/epub+zip':
      return { ...(await extractEpub(file)), mimeType: mime, name: file.name };
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return { ...(await extractXlsx(file)), mimeType: mime, name: file.name };
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return { ...(await extractPptx(file)), mimeType: mime, name: file.name };
    case 'text/csv':
      return { ...(await extractCsv(file)), mimeType: mime, name: file.name };
    case 'text/html':
      return { ...(await extractHtml(file)), mimeType: mime, name: file.name };
    case 'text/plain':
    case 'text/markdown':
      return { text: await readTextFile(file), mimeType: mime, name: file.name };
    default:
      throw new Error(
        `Unsupported file type: ${file.type || ext}. ` +
        `Supported: PDF, DOCX, DOC, ODT, RTF, EPUB, XLSX, PPTX, CSV, HTML, TXT, MD.`,
      );
  }
}

// (getMimeType and getFileExtension moved to ./document-types so they can be
//  unit-tested without pulling pdfjs/tesseract into the test bundle.)

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// ─── PDF extraction ────────────────────────────────────────────────

async function extractPdf(file: File, options: ExtractOptions): Promise<ExtractedDocument> {
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = getPdfWorkerPath();
  }

  // pdfjs's worker protocol can hang without ever rejecting (the known case:
  // an engine without Promise.try running pdfjs 6 — getDocument().promise
  // never settles, so no try/catch downstream would ever run). Wrap the
  // whole pipeline in a stall watchdog: progress events keep it alive, and
  // if nothing moves for EXTRACT_STALL_TIMEOUT_MS the caller gets a real
  // rejection instead of an eternal spinner.
  const run = async (
    onProgress: ((message: string) => void) | undefined,
  ): Promise<ExtractedDocument> => {
    const buffer = await readArrayBuffer(file);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const parts: string[] = [];
    const layoutBlocks: LayoutBlock[] = [];
    const anchors: TextAnchor[] = [];
    const useOcr = options.useOcr ?? false;
    const maxPages = Math.min(pdf.numPages, options.maxPdfPages ?? MAX_PDF_PAGES);
    if (maxPages < pdf.numPages) {
      onProgress?.(
        `PDF has ${pdf.numPages} pages; only the first ${maxPages} will be extracted`,
      );
    }

    /**
     * Append a line and report where it landed in the joined text.
     *
     * The final document is `parts.join('\n\n')`, so part N starts at the sum
     * of every earlier part's length plus two. Tracking that running offset
     * as we go is the only way the anchors can point at real characters —
     * a two-character-per-part error here would shift every subsequent
     * highlight by two characters, which is invisible until a sentence
     * highlights the wrong line and then looks like a rendering bug.
     */
    let offset = 0;
    const pushPart = (text: string): number => {
      const start = offset;
      offset += text.length + 2; // the '\n\n' separator join() inserts
      parts.push(text);
      return start;
    };

    for (let i = 1; i <= maxPages; i++) {
      onProgress?.(`Processing PDF page ${i}/${maxPages}…`);
      const page = await pdf.getPage(i);

      if (useOcr) {
        // Route OCR progress through the same stream so long OCR runs keep
        // resetting the stall timer (Tesseract emits per-% updates).
        const ocrOptions: ExtractOptions = { ...options, onProgress };
        const blocks = await ocrPage(page, i, ocrOptions);
        layoutBlocks.push(...blocks);
        // OCR already produced page geometry; the anchors are a re-index of
        // the same rectangles, so the viewer has one shape to read.
        for (const block of blocks) {
          const start = pushPart(block.text);
          anchors.push({
            page: block.page,
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
            start,
            end: start + block.text.length,
          });
        }
      } else {
        const content = await page.getTextContent({ includeMarkedContent: false });
        // Rectangles are captured in scale-1 viewport space, so a zoom is a
        // multiply at render time rather than a second transform here.
        const viewport = page.getViewport({ scale: 1 });
        let lastY = 0;
        const lineParts: string[] = [];
        const lineAnchors: Omit<TextAnchor, 'page'>[] = [];
        let lineLen = 0;

        const flushLine = (): void => {
          if (!lineParts.length) return;
          const lineStart = pushPart(lineParts.join(' '));
          for (const a of lineAnchors) {
            anchors.push({ ...a, page: i, start: lineStart + a.start, end: lineStart + a.end });
          }
          lineParts.length = 0;
          lineAnchors.length = 0;
          lineLen = 0;
        };

        for (const item of content.items) {
          const textItem = item as TextItem;
          const txt = textItem.str;
          if (!txt) continue;
          // Heuristic line break: large vertical gaps
          if (lineParts.length && Math.abs(textItem.transform[5] - lastY) > 3) {
            flushLine();
          }
          if (lineParts.length) lineLen += 1; // the space join() puts between items
          lineParts.push(txt);
          lineAnchors.push({
            ...textItemRect(viewport, textItem),
            start: lineLen,
            end: lineLen + txt.length,
          });
          lineLen += txt.length;
          lastY = textItem.transform[5];
        }
        flushLine();
      }
    }

    return {
      text: parts.join('\n\n'),
      layoutBlocks: useOcr && layoutBlocks.length ? layoutBlocks : undefined,
      // A PDF with no extractable text (pure scans, or a text layer pdfjs
      // cannot find) has nothing to anchor and still renders fine visually,
      // so an empty array is a legitimate answer, not a failure.
      anchors: anchors.length ? anchors : undefined,
      mimeType: 'application/pdf',
      name: file.name,
    };
  };

  if (options.watchdogEnabled === false) {
    return run(options.onProgress);
  }
  const watchdog = withProgressWatchdog<ExtractedDocument>(
    new Promise<ExtractedDocument>((resolve, reject) => {
      // Start the pipeline only after the watchdog hands back its wrapped
      // progress callback, so every onProgress event inside `run` both
      // reaches the UI and resets the stall deadline.
      queueMicrotask(() => {
        run(watchdog.onProgress ?? undefined).then(resolve, reject);
      });
    }),
    options.stallTimeoutMs ?? EXTRACT_STALL_TIMEOUT_MS,
    options.onProgress,
  );
  return watchdog.promise;
}

async function ocrPage(page: pdfjs.PDFPageProxy, pageNumber: number, options: ExtractOptions): Promise<LayoutBlock[]> {
  const scale = 2.0;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cannot create canvas context');
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;

  const mode: OcrMode = options.ocrMode ?? 'tesseract';
  if (mode === 'llm') {
    return ocrPageWithLlm(canvas, pageNumber, scale, options);
  }
  return ocrPageWithTesseract(canvas, pageNumber, scale, options);
}

/** Tesseract.js OCR path — fast, rule-based, self-hosted WASM. */
async function ocrPageWithTesseract(
  canvas: HTMLCanvasElement,
  pageNumber: number,
  scale: number,
  options: ExtractOptions,
): Promise<LayoutBlock[]> {
  const ocrEngine = getOcrEngine(options.ocrLang ?? 'eng');
  const result = await ocrEngine.recognize(canvas, {
    onProgress: (p) => {
      if (p.status === 'recognizing text') {
        options.onProgress?.(`OCR page ${pageNumber}: ${Math.round(p.progress * 100)}%`);
      }
    },
    includeWords: true,
  });

  const blocks: LayoutBlock[] = [];
  const words: BboxWord[] = result.words ?? [];
  if (words.length) {
    const lineThreshold = (canvas.height * 0.025);
    const lines = groupWordsIntoLines(words, lineThreshold);
    for (const line of lines) {
      const text = line.words.map(w => w.text).join(' ');
      if (!text.trim()) continue;
      blocks.push({
        page: pageNumber,
        text,
        x: line.x / scale,
        y: line.y / scale,
        width: line.width / scale,
        height: line.height / scale,
      });
    }
  }
  return blocks;
}

/**
 * Florence-2 LLM OCR path — slower but much better for complex layouts,
 * varied fonts, and handwriting. Converts the model's quad-box output to
 * the same LayoutBlock format as the Tesseract path.
 */
async function ocrPageWithLlm(
  canvas: HTMLCanvasElement,
  pageNumber: number,
  scale: number,
  options: ExtractOptions,
): Promise<LayoutBlock[]> {
  const llmEngine = getLlmOcrEngine();
  options.onProgress?.(`OCR page ${pageNumber}: LLM analyzing…`);
  let result;
  try {
    result = await llmEngine.recognize(canvas, {
      onProgress: (p) => {
        if (p.status === 'recognizing text') {
          options.onProgress?.(`OCR page ${pageNumber}: LLM generating…`);
        }
      },
      includeWords: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `LLM OCR failed on page ${pageNumber}: ${msg}. ` +
      `Try switching to Tesseract OCR mode.`,
      { cause: err },
    );
  }

  const blocks: LayoutBlock[] = [];
  const llmWords: QuadWord[] = result.words ?? [];
  if (llmWords.length) {
    // Convert Florence-2 quad-boxes to axis-aligned bboxes so we can reuse
    // the same line-grouping logic as the Tesseract path.
    const words: BboxWord[] = llmWords.map(w => quadToBbox(w));
    const lineThreshold = (canvas.height * 0.025);
    const lines = groupWordsIntoLines(words, lineThreshold);
    for (const line of lines) {
      const text = line.words.map(w => w.text).join(' ');
      if (!text.trim()) continue;
      blocks.push({
        page: pageNumber,
        text,
        x: line.x / scale,
        y: line.y / scale,
        width: line.width / scale,
        height: line.height / scale,
      });
    }
  }
  // If the LLM returned text but no word boxes (e.g., <OCR> without regions),
  // fall back to the full text as a single block.
  if (blocks.length === 0 && result.text.trim()) {
    blocks.push({
      page: pageNumber,
      text: result.text.trim(),
      x: 0,
      y: 0,
      width: canvas.width / scale,
      height: canvas.height / scale,
    });
  }
  return blocks;
}

// quadToBbox is imported from ./document-types (pure helper, testable
// without pulling in pdfjs or transformers).

interface LineGroup {
  y: number;
  x: number;
  width: number;
  height: number;
  words: BboxWord[];
}

function groupWordsIntoLines(words: BboxWord[], yThreshold: number): LineGroup[] {
  const sorted = [...words].sort((a, b) => {
    const ay = a.bbox.y0;
    const by = b.bbox.y0;
    if (Math.abs(ay - by) > yThreshold) return ay - by;
    return a.bbox.x0 - b.bbox.x0;
  });

  const lines: LineGroup[] = [];
  for (const word of sorted) {
    const cy = (word.bbox.y0 + word.bbox.y1) / 2;
    const existing = lines.find(l => Math.abs(l.y - cy) <= yThreshold);
    if (existing) {
      existing.words.push(word);
      existing.x = Math.min(existing.x, word.bbox.x0);
      existing.y = Math.min(existing.y, word.bbox.y0);
      existing.width = Math.max(existing.x + existing.width, word.bbox.x1) - existing.x;
      existing.height = Math.max(existing.y + existing.height, word.bbox.y1) - existing.y;
    } else {
      lines.push({
        y: cy,
        x: word.bbox.x0,
        width: word.bbox.x1 - word.bbox.x0,
        height: word.bbox.y1 - word.bbox.y0,
        words: [word],
      });
    }
  }
  // Sort each line left-to-right and recompute width/height.
  return lines.map(line => {
    line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const x0 = Math.min(...line.words.map(w => w.bbox.x0));
    const y0 = Math.min(...line.words.map(w => w.bbox.y0));
    const x1 = Math.max(...line.words.map(w => w.bbox.x1));
    const y1 = Math.max(...line.words.map(w => w.bbox.y1));
    return { ...line, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }).sort((a, b) => a.y - b.y);
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

async function extractDocx(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
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

  // One pass produces both, so the markup's stamped ranges are guaranteed to
  // be offsets into the text the reader is going to segment.
  const { text, html } = blocksToTextAndHtml(blocks);
  return { text, html: html || undefined };
}

// ─── DOC (legacy Word binary) extraction ──────────────────────────
// The .doc format is a complex binary OLE container. Full parsing would
// require a dedicated library (e.g. antiword or libreoffice). We do a
// best-effort extraction: strip non-printable bytes and OLE overhead,
// then clean up the result. This works for simple documents but may
// produce noise for complex ones. Mammoth does not support .doc.

async function extractDoc(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
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
// RTF is a plain-text format with control words. We strip control words
// and extract the text content. This handles the common cases (fonts,
// colors, paragraphs) without needing a full RTF parser.

async function extractRtf(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
  const rtf = await readTextFile(file);
  const text = stripRtfControlWords(rtf);
  if (!text.trim()) {
    throw new Error('Could not extract text from RTF file (file may be empty or corrupted).');
  }
  return { text: text.trim() };
}

// ─── HTML extraction ──────────────────────────────────────────────

async function extractHtml(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
  const html = await readTextFile(file);
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  // Remove script and style content
  doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  const text = doc.body?.textContent ?? '';
  const cleaned = collapseWhitespace(text);
  if (!cleaned) {
    throw new Error('Could not extract text from HTML file (no body content).');
  }
  return { text: cleaned };
}

// ─── CSV extraction ───────────────────────────────────────────────
// CSV is plain text — we read it and format rows as lines, preserving
// the tabular structure for TTS readability.

async function extractCsv(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
  const csv = await readTextFile(file);
  if (!csv.trim()) {
    throw new Error('CSV file is empty.');
  }
  const rows = parseCsv(csv);
  const lines = rows.map(row => row.join(', '));
  return { text: lines.join('\n') };
}

// ─── XLSX extraction ──────────────────────────────────────────────
// XLSX is a ZIP with XML sheets. We use JSZip (already a dependency) to
// read xl/worksheets/sheet*.xml and extract cell values from the shared
// strings table (xl/sharedStrings.xml).

async function extractXlsx(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
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

  // Find and parse all worksheets
  const sheetFiles = Object.keys(zip.files).filter(path => /^xl\/worksheets\/sheet\d+\.xml$/.test(path));
  if (sheetFiles.length === 0) throw new Error('Invalid XLSX: no worksheets found');

  const parser = new DOMParser();
  const parts: string[] = [];

  for (const sheetPath of sheetFiles.sort()) {
    const sheetXml = await zip.file(sheetPath)?.async('text');
    if (!sheetXml) continue;
    const sheetDoc = parser.parseFromString(sheetXml, 'application/xml');
    const rows = sheetDoc.getElementsByTagName('row');
    for (const row of Array.from(rows)) {
      const cells = row.getElementsByTagName('c');
      const cellTexts: string[] = [];
      for (const cell of Array.from(cells)) {
        const type = cell.getAttribute('t');
        const valueNode = cell.getElementsByTagName('v')[0];
        const value = valueNode?.textContent ?? '';
        if (type === 's') {
          // Shared string reference
          const idx = parseInt(value, 10);
          cellTexts.push(sharedStrings[idx] ?? '');
        } else if (type === 'inlineStr') {
          // Inline string
          const tNode = cell.getElementsByTagName('t')[0];
          cellTexts.push(tNode?.textContent ?? '');
        } else {
          // Number or other
          cellTexts.push(value);
        }
      }
      if (cellTexts.some(t => t.trim())) {
        parts.push(cellTexts.join(', '));
      }
    }
    // Add a blank line between sheets
    if (parts.length) parts.push('');
  }

  const text = parts.join('\n').trim();
  if (!text) throw new Error('XLSX file contains no text data.');
  return { text };
}

// ─── PPTX extraction ──────────────────────────────────────────────
// PPTX is a ZIP with XML slides. We extract text from the <a:t> elements
// in each slide's XML (ppt/slides/slide*.xml).

async function extractPptx(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await readArrayBuffer(file));

  const slideFiles = Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  if (slideFiles.length === 0) throw new Error('Invalid PPTX: no slides found');

  const parser = new DOMParser();
  const parts: string[] = [];

  // Sort slides by number (slide1.xml, slide2.xml, ... slide10.xml)
  slideFiles.sort((a, b) => {
    const numA = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
    const numB = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
    return numA - numB;
  });

  for (const slidePath of slideFiles) {
    const slideXml = await zip.file(slidePath)?.async('text');
    if (!slideXml) continue;
    const slideDoc = parser.parseFromString(slideXml, 'application/xml');
    // Text in PPTX slides is in <a:t> elements (DrawingML run text)
    const textNodes = slideDoc.getElementsByTagName('a:t');
    const texts = Array.from(textNodes).map(t => t.textContent ?? '');
    const slideText = texts.join(' ').trim();
    if (slideText) {
      parts.push(slideText);
    }
  }

  const text = parts.join('\n\n').trim();
  if (!text) throw new Error('PPTX file contains no text data.');
  return { text };
}

// ─── ODT extraction ──────────────────────────────────────────────

async function extractOdt(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await readArrayBuffer(file));
  const xmlText = await zip.file('content.xml')?.async('text');
  if (!xmlText) throw new Error('Invalid ODT: missing content.xml');

  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const paragraphs = xml.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:text:1.0', 'p');
  const out: string[] = [];
  for (const p of Array.from(paragraphs)) {
    const text = p.textContent ?? '';
    if (text.trim()) out.push(text);
  }
  return { text: out.join('\n\n') };
}

// ─── EPUB extraction ─────────────────────────────────────────────

// Minimal subset of epubjs's spine API that we actually consume. The published
// types are incomplete so we narrow to the shape we need.
interface EpubSpineItem {
  load: (fn: (url: string) => Promise<EpubLoaded>) => Promise<EpubLoaded>;
  unload?: () => void;
}
interface EpubBook {
  spine: { spineItems: EpubSpineItem[] };
  load: (url: string) => Promise<EpubLoaded>;
  loaded: { spine: Promise<unknown> };
}

/**
 * What `spineItem.load()` actually resolves to.
 *
 * Every shape here is real, which is the trap: epubjs's `Section.load`
 * resolves `xml.documentElement` — the `<html>` *element*, not the Document it
 * came from — so reading `.body` off it yields `undefined` and an EPUB
 * silently extracts to nothing at all. Reading the element's own `innerHTML`
 * is what works. `string` and `Document` are kept because `Book.load` resolves
 * text for non-XHTML entries, and older epubjs builds resolved a Document.
 */
type EpubLoaded = string | Document | Element;

/**
 * Blocks inside one EPUB spine item (chapter).
 *
 * Block-structured rather than one collapsed string per chapter, which is what
 * this used to produce. Two reasons, and the second is the one that forced it:
 * paragraph breaks are what the sentence segmenter uses to pace a reading, and
 * a stamped range per block is only meaningful if the text it indexes is built
 * from those same blocks. Collapsing a whole chapter to one line first would
 * leave the markup's offsets pointing into a string that no longer exists.
 */
export function epubBlocks(root: EpubLoaded): DocumentBlock[] {
  const host = document.createElement('div');

  // Three shapes, and they are not interchangeable. A Document carries
  // `.body`; an Element — which is what epubjs hands back — does not, so
  // asking an Element for `.body` is how an entire book extracts to zero
  // characters with no error anywhere. Dispatch on nodeType rather than on
  // which properties happen to exist.
  if (typeof root === 'string') {
    host.innerHTML = root;
  } else if (root.nodeType === 9) {
    const doc = root as Document;
    host.innerHTML = doc.body?.innerHTML ?? doc.documentElement?.innerHTML ?? '';
    if (!host.textContent?.trim()) host.textContent = doc.documentElement?.textContent ?? '';
  } else if (root.nodeType === 1) {
    const el = root as Element;
    // The element is normally `<html>`, so take its body: a chapter's
    // `<head><title>` is not part of the book, and it would otherwise show up
    // as the opening line of the chapter that has no block elements.
    const source = el.querySelector('body') ?? el;
    host.innerHTML = source.innerHTML;
    // Serialisation is the second place this can come back empty (a document
    // with no HTML serialiser available). The words are still on the element,
    // so take them from there rather than reporting an empty chapter.
    if (!host.textContent?.trim()) host.textContent = source.textContent ?? '';
  }

  const blocks: DocumentBlock[] = [];
  for (const el of Array.from(host.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,td'))) {
    const text = collapseWhitespace(el.textContent ?? '');
    if (!text) continue;
    const kind: DocumentBlock['kind'] =
      /^H1$/.test(el.tagName) ? 'h1'
        : /^H2$/.test(el.tagName) ? 'h2'
          : /^H[3-6]$/.test(el.tagName) ? 'h3'
            : el.tagName === 'LI' ? 'li'
              : 'p';
    blocks.push({ kind, runs: [{ text }] });
  }

  // A chapter whose markup uses none of those elements still has words in it.
  if (blocks.length === 0) {
    const text = collapseWhitespace(host.textContent ?? '');
    if (text) blocks.push({ kind: 'p', runs: [{ text }] });
  }
  return blocks;
}

async function extractEpub(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
  const ePub = (await import('epubjs')).default as unknown as (data: ArrayBuffer) => EpubBook;
  const arrayBuffer = await readArrayBuffer(file);
  const book = ePub(arrayBuffer);
  await book.loaded.spine;

  // Every chapter's blocks go into ONE list, so blocksToTextAndHtml can stamp
  // globally-correct offsets in a single pass. Stamping per chapter would
  // restart the numbering at zero and every highlight past chapter one would
  // land at the start of the book.
  const all: DocumentBlock[] = [];
  for (const item of book.spine.spineItems) {
    const loaded = await item.load(book.load.bind(book));
    const blocks = epubBlocks(loaded);
    if (blocks.length) {
      blocks[0] = { ...blocks[0], chapterStart: true };
      all.push(...blocks);
    }
    item.unload?.();
  }

  const { text, html } = blocksToTextAndHtml(all);
  return { text, html: html || undefined };
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
