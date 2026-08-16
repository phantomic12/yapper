import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { getOcrEngine } from './ocr';
import { getLlmOcrEngine } from './engines/llm-ocr';
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
  /** Detected / declared MIME type. */
  mimeType: string;
  /** File name. */
  name: string;
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

  const buffer = await readArrayBuffer(file);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const parts: string[] = [];
  const layoutBlocks: LayoutBlock[] = [];
  const useOcr = options.useOcr ?? false;
  const maxPages = Math.min(pdf.numPages, options.maxPdfPages ?? MAX_PDF_PAGES);
  if (maxPages < pdf.numPages) {
    options.onProgress?.(
      `PDF has ${pdf.numPages} pages; only the first ${maxPages} will be extracted`,
    );
  }

  for (let i = 1; i <= maxPages; i++) {
    options.onProgress?.(`Processing PDF page ${i}/${maxPages}…`);
    const page = await pdf.getPage(i);

    if (useOcr) {
      const blocks = await ocrPage(page, i, options);
      layoutBlocks.push(...blocks);
      parts.push(...blocks.map(b => b.text));
    } else {
      const content = await page.getTextContent({ includeMarkedContent: false });
      let lastY = 0;
      const lineParts: string[] = [];
      for (const item of content.items) {
        const textItem = item as TextItem;
        const txt = textItem.str;
        if (!txt) continue;
        // Heuristic line break: large vertical gaps
        if (lineParts.length && Math.abs(textItem.transform[5] - lastY) > 3) {
          parts.push(lineParts.join(' '));
          lineParts.length = 0;
        }
        lineParts.push(txt);
        lastY = textItem.transform[5];
      }
      if (lineParts.length) parts.push(lineParts.join(' '));
    }
  }

  return {
    text: parts.join('\n\n'),
    layoutBlocks: useOcr && layoutBlocks.length ? layoutBlocks : undefined,
    mimeType: 'application/pdf',
    name: file.name,
  };
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
  const result = await llmEngine.recognize(canvas, {
    onProgress: (p) => {
      if (p.status === 'recognizing text') {
        options.onProgress?.(`OCR page ${pageNumber}: LLM generating…`);
      }
    },
    includeWords: true,
  });

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
  const paragraphs = xml.getElementsByTagName('w:p');
  const out: string[] = [];
  for (const p of Array.from(paragraphs)) {
    const texts = p.getElementsByTagName('w:t');
    const line = Array.from(texts).map(t => t.textContent ?? '').join('');
    if (line.trim()) out.push(line);
  }
  return { text: out.join('\n\n') };
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
  load: (fn: (url: string) => Promise<string | Document>) => Promise<string | Document>;
  unload?: () => void;
}
interface EpubBook {
  spine: { spineItems: EpubSpineItem[] };
  load: (url: string) => Promise<string | Document>;
  loaded: { spine: Promise<unknown> };
}

async function extractEpub(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
  const ePub = (await import('epubjs')).default as unknown as (data: ArrayBuffer) => EpubBook;
  const arrayBuffer = await readArrayBuffer(file);
  const book = ePub(arrayBuffer);
  await book.loaded.spine;

  const parts: string[] = [];
  for (const item of book.spine.spineItems) {
    const doc = await item.load(book.load.bind(book));
    const text = typeof doc === 'string'
      ? stripHtml(doc)
      : (doc as Document).body?.textContent ?? '';
    if (text.trim()) parts.push(collapseWhitespace(text));
    item.unload?.();
  }
  return { text: parts.join('\n\n') };
}

function stripHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent ?? '';
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
