import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import Tesseract from 'tesseract.js';

// PDF.js worker must be told where its worker script is. In Vite we copy the
// worker to public/ and point the path at runtime.
const PDFJS_WORKER_PATH = '/pdf.worker.mjs';

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
}

export async function extractDocument(file: File, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = getMimeType(ext, file.type);
  options.onProgress?.(`Reading ${ext.toUpperCase()} file…`);

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

function getMimeType(ext: string, fallback: string): string {
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'odt') return 'application/vnd.oasis.opendocument.text';
  if (ext === 'epub') return 'application/epub+zip';
  if (['txt', 'md', 'markdown'].includes(ext)) return ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain';
  return fallback;
}

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
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;
  }

  const buffer = await readArrayBuffer(file);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const parts: string[] = [];
  const layoutBlocks: LayoutBlock[] = [];
  const useOcr = options.useOcr ?? false;

  for (let i = 1; i <= pdf.numPages; i++) {
    options.onProgress?.(`Processing PDF page ${i}/${pdf.numPages}…`);
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

  const resultData = result.data as any;
  const blocks: LayoutBlock[] = [];
  const words: any[] = resultData.words ?? [];
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

interface LineGroup {
  y: number;
  x: number;
  width: number;
  height: number;
  words: any[];
}

function groupWordsIntoLines(words: any[], yThreshold: number): LineGroup[] {
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

async function extractEpub(file: File): Promise<Omit<ExtractedDocument, 'mimeType' | 'name'>> {
  const ePub = (await import('epubjs')).default;
  const arrayBuffer = await readArrayBuffer(file);
  const book = ePub(arrayBuffer);
  await book.loaded.spine;

  const parts: string[] = [];
  const spine = (book.spine as any).spineItems as Array<{ load: (fn: (url: string) => Promise<string | Document>) => Promise<string | Document>; unload?: () => void }>;
  for (const item of spine) {
    const doc = await item.load(book.load.bind(book) as any);
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
