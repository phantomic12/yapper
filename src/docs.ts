// ─── Document ingestion ──────────────────────────────────────────
//
// Routes a File (PDF / text / image) into chunks of narration-ready plain text.
// Pure functions where possible; OCR is lazy via getOcrEngine().
//
// Pipeline:
//   PDF  → pdfjs-dist text extraction per page
//          if a page returns empty/short text, OCR-fallback by rendering the
//          page to a canvas and running Tesseract on it
//   TXT  → file read as utf-8, markdown stripped to plain text
//   IMG  → OCR directly via Tesseract
//
// Chunking: sentences/paragraphs packed up to ~CHUNK_MAX_CHARS. The existing
// TTSEngine.enqueue() accepts arbitrary-length text but per-job generation
// gets slow past ~2k chars; chunking keeps each job snappy and lets the user
// skip/cancel individual sections.

import * as pdfjs from 'pdfjs-dist';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite resolves this to a URL string at build time
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getOcrEngine, type OcrProgress } from './ocr';

// pdfjs needs to know where its worker is. Vite handles the bundling via ?url.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Public types ─────────────────────────────────────────────────

export type DocKind = 'pdf' | 'text' | 'image';

export interface ExtractedPage {
  /** 1-based page number (or 1 for single-image / single-blob inputs). */
  page: number;
  text: string;
  /** True when the page was empty and we fell back to OCR. */
  ocr?: boolean;
}

export interface ExtractedDoc {
  kind: DocKind;
  fileName: string;
  pages: ExtractedPage[];
  /** Pages concatenated + chunked for direct enqueueing. */
  chunks: string[];
}

export interface ExtractProgress {
  phase: 'loading' | 'extracting' | 'ocr' | 'chunking' | 'done';
  page: number;
  totalPages: number;
  /** Within-page OCR progress when phase === 'ocr'. */
  ocr?: OcrProgress;
  message?: string;
}

export interface ExtractOptions {
  onProgress?: (p: ExtractProgress) => void;
  /**
   * If true (default), pages with little/no extractable text get OCR'd by
   * rendering to a canvas and running Tesseract. Disable for faster ingest of
   * text-only PDFs.
   */
  ocrFallback?: boolean;
}

// ─── Chunking ─────────────────────────────────────────────────────

const CHUNK_MAX_CHARS = 1500;
const CHUNK_MIN_CHARS = 400;

/** Pack sentences into chunks between CHUNK_MIN and CHUNK_MAX chars. */
export function chunkText(text: string, max = CHUNK_MAX_CHARS, min = CHUNK_MIN_CHARS): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= max) return [cleaned];

  // Split on sentence boundaries. Keep the delimiter on the preceding chunk.
  const sentences = cleaned.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [cleaned];
  const chunks: string[] = [];
  let buf = '';
  for (const s of sentences) {
    const sTrim = s.trim();
    if (!sTrim) continue;
    // If a single sentence is longer than max, hard-split it on word boundaries
    if (sTrim.length > max) {
      if (buf) { chunks.push(buf.trim()); buf = ''; }
      const words = sTrim.split(/\s+/);
      let wbuf = '';
      for (const w of words) {
        if ((wbuf + ' ' + w).trim().length > max) {
          if (wbuf) chunks.push(wbuf.trim());
          wbuf = w;
        } else {
          wbuf = wbuf ? wbuf + ' ' + w : w;
        }
      }
      if (wbuf) buf = wbuf;
      continue;
    }
    if ((buf + ' ' + sTrim).trim().length > max) {
      if (buf.trim().length >= min) {
        chunks.push(buf.trim());
        buf = sTrim;
      } else {
        // buf is small but adding sTrim would overflow — just append anyway.
        buf = (buf + ' ' + sTrim).trim();
      }
    } else {
      buf = buf ? buf + ' ' + sTrim : sTrim;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// ─── PDF text extraction ──────────────────────────────────────────

async function extractPdfPages(file: File, onProgress?: (p: ExtractProgress) => void): Promise<ExtractedPage[]> {
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const total = doc.numPages;
  const pages: ExtractedPage[] = [];

  for (let i = 1; i <= total; i++) {
    onProgress?.({ phase: 'extracting', page: i, totalPages: total });
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // pdfjs returns text items with positions; joining with single spaces
    // gets us 95% of readable PDFs. Newlines between items whose y-coords
    // differ significantly reconstruct paragraph breaks.
    let text = '';
    let lastY: number | null = null;
    for (const item of content.items as Array<{ str: string; transform: number[] }>) {
      if (!('str' in item)) continue;
      const y = item.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
        text += '\n';
      } else if (text && !text.endsWith(' ')) {
        text += ' ';
      }
      text += item.str;
      lastY = y ?? lastY;
    }
    pages.push({ page: i, text: text.trim() });
    page.cleanup();
  }
  // pdfjs v6: PDFDocumentProxy no longer has destroy(); cleanup() releases
  // retained page resources. The document itself is GC'd with the proxy.
  await doc.cleanup();
  return pages;
}

// ─── PDF page → canvas → OCR fallback ─────────────────────────────

async function renderPdfPageToCanvas(page: pdfjs.PDFPageProxy, scale = 2): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for PDF page render');
  // pdfjs v6 RenderParameters requires the canvas element as well as ctx.
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas;
}

/**
 * For pages where pdfjs returned very little text (likely a scanned image),
 * render the page to a canvas and OCR it. Returns the recognized text or
 * the original (short) text on OCR failure.
 */
async function ocrPdfPage(
  file: File,
  pageNum: number,
  fallback: string,
  onProgress?: (p: ExtractProgress) => void,
): Promise<{ text: string; ocr: boolean }> {
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const page = await doc.getPage(pageNum);
    const canvas = await renderPdfPageToCanvas(page);
    onProgress?.({ phase: 'ocr', page: pageNum, totalPages: doc.numPages });
    try {
      const text = await getOcrEngine('eng').recognize(canvas, {
        onProgress: (ocr) => onProgress?.({ phase: 'ocr', page: pageNum, totalPages: doc.numPages, ocr }),
      });
      return { text: text.trim() || fallback, ocr: true };
    } catch (err) {
      // OCR failed — keep the (probably empty) original text so the chunker
      // still produces something rather than dropping the page silently.
      console.warn(`OCR failed for PDF page ${pageNum}:`, err);
      return { text: fallback, ocr: false };
    } finally {
      page.cleanup();
    }
  } finally {
    await doc.cleanup();
  }
}

// ─── Plain text ───────────────────────────────────────────────────

/** Read a text file. Strips basic Markdown so TTS doesn't speak "**bold**". */
async function extractTextFile(file: File): Promise<string> {
  const text = await file.text();
  return text
    // Strip markdown emphasis + code spans + links
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip heading hashes / blockquote markers
    .replace(/^[#>\s]+/gm, '')
    // Collapse 3+ newlines to a paragraph break
    .replace(/\n{3,}/g, '\n\n');
}

// ─── Image → OCR ──────────────────────────────────────────────────

async function extractImageFile(file: File, onProgress?: (p: ExtractProgress) => void): Promise<ExtractedPage[]> {
  onProgress?.({ phase: 'ocr', page: 1, totalPages: 1 });
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`Failed to decode image: ${file.name}`));
      i.src = url;
    });
    const text = await getOcrEngine('eng').recognize(img, {
      onProgress: (ocr) => onProgress?.({ phase: 'ocr', page: 1, totalPages: 1, ocr }),
    });
    return [{ page: 1, text: text.trim(), ocr: true }];
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── Router ──────────────────────────────────────────────────────

export function detectDocKind(file: File): DocKind | null {
  // PDF
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'pdf';
  // Images
  if (file.type.startsWith('image/')) return 'image';
  // Text
  if (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    /\.(txt|md|markdown|json|log|csv|tsv)$/i.test(file.name)
  ) {
    return 'text';
  }
  return null;
}

/**
 * Main entry point. Extracts text from a File and returns pages + chunks.
 * For PDFs, pages with < MIN_PAGE_CHARS of extractable text are OCR'd.
 */
export async function extractDocument(file: File, options: ExtractOptions = {}): Promise<ExtractedDoc> {
  const { onProgress, ocrFallback = true } = options;
  const kind = detectDocKind(file);
  if (!kind) {
    throw new Error(`Unsupported file type: ${file.type || file.name}`);
  }
  onProgress?.({ phase: 'loading', page: 0, totalPages: 0 });

  let pages: ExtractedPage[];
  if (kind === 'pdf') {
    pages = await extractPdfPages(file, onProgress);
    if (ocrFallback) {
      const MIN_PAGE_CHARS = 40;
      for (const p of pages) {
        if (p.text.length < MIN_PAGE_CHARS) {
          const ocr = await ocrPdfPage(file, p.page, p.text, onProgress);
          if (ocr.text.length > p.text.length) p.text = ocr.text;
          p.ocr = ocr.ocr;
        }
      }
    }
  } else if (kind === 'text') {
    const text = await extractTextFile(file);
    pages = [{ page: 1, text }];
  } else {
    pages = await extractImageFile(file, onProgress);
  }

  onProgress?.({ phase: 'chunking', page: pages.length, totalPages: pages.length });
  const fullText = pages.map(p => p.text).filter(Boolean).join('\n\n');
  const chunks = chunkText(fullText);
  onProgress?.({ phase: 'done', page: pages.length, totalPages: pages.length });

  return { kind, fileName: file.name, pages, chunks };
}