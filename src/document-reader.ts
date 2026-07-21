import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import Tesseract from 'tesseract.js';
import { getMimeType, getFileExtension, MAX_PDF_PAGES } from './document-types';
export { getMimeType, getFileExtension, MAX_PDF_PAGES } from './document-types';

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
  /** For PDFs only: render pages and run Tesseract.js OCR instead of normal text extraction. */
  useOcr?: boolean;
  /** Language passed to Tesseract. */
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
    case 'application/vnd.oasis.opendocument.text':
      return { ...(await extractOdt(file)), mimeType: mime, name: file.name };
    case 'application/epub+zip':
      return { ...(await extractEpub(file)), mimeType: mime, name: file.name };
    case 'text/plain':
    case 'text/markdown':
      return { text: await readTextFile(file), mimeType: mime, name: file.name };
    default:
      throw new Error(`Unsupported file type: ${file.type || ext}. Supported: PDF, DOCX, ODT, EPUB, TXT, MD.`);
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

  const result = await Tesseract.recognize(canvas, options.ocrLang ?? 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text') options.onProgress?.(`OCR page ${pageNumber}: ${Math.round(m.progress * 100)}%`);
    },
  });

  const resultData = (result as TesseractResult).data;
  const blocks: LayoutBlock[] = [];
  const words: TesseractWord[] = resultData.words ?? [];
  if (words.length) {
    // Group words into rough horizontal lines, then collapse near lines into blocks.
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

// Tesseract's Word type — the public API exposes a richer type but we only
// use the bbox + text. Narrowing here keeps the grouping logic readable.
interface TesseractWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence?: number;
}
interface TesseractPage {
  words?: TesseractWord[];
}
interface TesseractResult {
  data: TesseractPage;
}

interface LineGroup {
  y: number;
  x: number;
  width: number;
  height: number;
  words: TesseractWord[];
}

function groupWordsIntoLines(words: TesseractWord[], yThreshold: number): LineGroup[] {
  const sorted = [...words].sort((a, b) => {
    const ay = Math.min(a.bbox.y0, b.bbox.y0);
    const by = Math.min(a.bbox.y0, b.bbox.y0);
    if (Math.abs(ay - by) > yThreshold) return a.bbox.y0 - b.bbox.y0;
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
