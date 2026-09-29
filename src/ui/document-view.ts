/**
 * Showing the user the actual document, not the text we got out of it.
 *
 * The reader used to render one flat list of extracted sentences, which is
 * the worst possible view of a book: no pages, no headings, no figures, and
 * no way to tell whether the thing you are about to listen to is a novel or
 * a scanned form. This module renders the real pages and draws the
 * read-aloud highlight over the actual layout.
 *
 * ── Why the highlight can follow the text ────────────────────────────────
 * Because extraction now records a `TextAnchor` for every run of text it
 * pulls off a page, in character offsets (see `textItemRect` in
 * document-reader.ts). That index cannot be built after the fact: pdfjs
 * hands back one positioned item at a time, and the moment they are joined
 * into a string the link between "character 4,182" and "rectangle on page 7"
 * is gone. So `rectsForSpan()` is the bridge, and everything here is a
 * consumer of it.
 *
 * ── Why the pages are windowed ──────────────────────────────────────────
 * Rendering every page up front is how this would take the browser down. A
 * 500-page PDF at 24k pixels of canvas each is not a rendering plan, it is a
 * tab-crash plan. Every page gets a correctly-sized placeholder so the
 * scrollbar stays honest, and only a window of pages around the one being
 * read holds a live canvas. The rest are released the moment they leave.
 */

import type { TextAnchor } from '../document-types';
import { rectsForSpan } from '../document-types';
import { parseOffsetAttr, overlappingRanges } from '../document-html';

/** How many pages either side of the current one keep a live canvas. */
const WINDOW_RADIUS = 2;

/** Cap on simultaneously-live canvases, as a backstop on the window. */
const MAX_LIVE_CANVASES = 7;

export interface DocumentView {
  /** Move the highlight onto a character span of the extracted text. */
  highlight(start: number, end: number): void;
  /** Number of pages the view is showing. */
  readonly pageCount: number;
  /** The page the highlight currently sits on, or 0 when there is none. */
  readonly activePage: number;
  /** Scroll a page into view and make it the render window's centre. */
  showPage(page: number): void;
  /** Release every canvas and detach listeners. */
  destroy(): void;
}

/** Everything a mounted page wrapper needs to (re)draw itself. */
interface PageSlot {
  index: number;
  /** Page number in the document, 1-based (what anchors refer to). */
  pageNumber: number;
  /** CSS-pixel size of the page at the current zoom. */
  width: number;
  height: number;
  /** The element that holds the canvas, and the highlight boxes over it. */
  surface: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  boxes: HTMLDivElement;
  /** True while a render is in flight, so it is not started twice. */
  rendering: boolean;
}

export interface PdfViewOptions {
  initialPage?: number;
  scale?: number;
  /**
   * Called with the character offset of a click on a page.
   *
   * The view reports a position in the extracted text rather than a page and a
   * point, because that is what every other part of the reader speaks: the
   * sentence ranges, the highlight, and the session all index into one string.
   */
  onPick?: (offset: number) => void;
  /**
   * Called when a page fails to render.
   *
   * Render failures are otherwise invisible: pdfjs's render promise has been
   * observed to neither resolve nor reject, so a swallow-and-continue turns a
   * blank page into a mystery. The placeholder stays and the rest of the
   * document still opens either way.
   */
  onError?: (error: unknown, pageNumber: number) => void;
}

export async function mountPdfView(
  host: HTMLElement,
  file: File,
  anchors: TextAnchor[],
  options: PdfViewOptions = {},
): Promise<DocumentView> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', document.baseURI).href;
  }

  // Read the file again rather than reusing extraction's buffer. A File is
  // re-readable, whereas whether pdfjs detached the ArrayBuffer it was handed
  // is a property of its transfer settings — re-reading is the one answer
  // that is correct under either.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const baseScale = options.scale ?? 1.35;

  host.classList.add('docview');
  host.innerHTML = `
    <div class="docview__bar" role="toolbar" aria-label="Document pages">
      <button class="docview__nav" type="button" data-role="prev" aria-label="Previous page">‹</button>
      <span class="docview__count" role="status" aria-live="polite">Page 1 of ${pageCount}</span>
      <button class="docview__nav" type="button" data-role="next" aria-label="Next page">›</button>
      <span class="docview__spacer"></span>
      <button class="docview__zoom" type="button" data-role="zoom-out" aria-label="Zoom out">−</button>
      <button class="docview__zoom" type="button" data-role="zoom-in" aria-label="Zoom in">+</button>
    </div>
    <div class="docview__pages" tabindex="0" role="region" aria-label="Document pages"></div>
  `;
  const scroller = host.querySelector<HTMLDivElement>('.docview__pages')!;
  const countEl = host.querySelector<HTMLSpanElement>('.docview__count')!;
  host.setAttribute('aria-label', `Pages of ${file.name}`);

  // ── Build a placeholder per page so the scrollbar reflects reality ─────
  const slots: PageSlot[] = [];
  for (let n = 1; n <= pageCount; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: baseScale });
    const wrap = document.createElement('div');
    wrap.className = 'docview__page';
    wrap.dataset.page = String(n);
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;

    const surface = document.createElement('div');
    surface.className = 'docview__surface';
    surface.style.width = `${viewport.width}px`;
    surface.style.height = `${viewport.height}px`;

    const boxes = document.createElement('div');
    boxes.className = 'docview__highlight';
    surface.appendChild(boxes);
    wrap.appendChild(surface);
    scroller.appendChild(wrap);

    slots.push({
      index: n - 1,
      pageNumber: n,
      width: viewport.width,
      height: viewport.height,
      surface,
      canvas: null,
      boxes,
      rendering: false,
    });
    page.cleanup();
  }

  let scale = baseScale;
  let windowCentre = Math.max(0, Math.min(pageCount - 1, (options.initialPage ?? 1) - 1));
  let liveSpan: { start: number; end: number } | null = null;
  let destroyed = false;

  const setCount = (pageNumber: number): void => {
    countEl.textContent = `Page ${pageNumber} of ${pageCount}`;
  };

  // ── Windowed rendering ────────────────────────────────────────────────
  async function renderSlot(slot: PageSlot): Promise<void> {
    if (destroyed || slot.canvas || slot.rendering) return;
    slot.rendering = true;
    try {
      const page = await pdf.getPage(slot.pageNumber);
      const viewport = page.getViewport({ scale });
      // Render at device pixel ratio so the text is not visibly soft on a
      // HiDPI screen; the CSS box stays at logical size and the highlight
      // geometry is in logical pixels too, so nothing needs doubling.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.className = 'docview__canvas';
      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({
        canvasContext: ctx,
        viewport,
        canvas,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      } as Parameters<typeof page.render>[0]).promise;
      if (destroyed) return;
      slot.surface.insertBefore(canvas, slot.boxes);
      slot.canvas = canvas;
    } catch (err) {
      // A page that fails to render must not take the reader down with it;
      // the placeholder stays and the rest of the book still opens.
      options.onError?.(err, slot.pageNumber);
    } finally {
      slot.rendering = false;
    }
  }

  function releaseOutsideWindow(): void {
    let live = 0;
    for (const slot of slots) if (slot.canvas) live++;
    for (const slot of slots) {
      if (!slot.canvas) continue;
      if (Math.abs(slot.index - windowCentre) <= WINDOW_RADIUS) continue;
      if (live <= MAX_LIVE_CANVASES && Math.abs(slot.index - windowCentre) <= WINDOW_RADIUS + 1) {
        continue;
      }
      slot.canvas.remove();
      slot.canvas = null;
      live--;
    }
  }

  function paintWindow(): void {
    for (let i = windowCentre - WINDOW_RADIUS; i <= windowCentre + WINDOW_RADIUS; i++) {
      if (i < 0 || i >= slots.length) continue;
      void renderSlot(slots[i]);
    }
    releaseOutsideWindow();
    paintHighlights();
  }

  // ── The highlight ─────────────────────────────────────────────────────
  function paintHighlights(): void {
    for (const slot of slots) slot.boxes.replaceChildren();
    if (!liveSpan || !anchors.length) return;
    const byPage = rectsForSpan(anchors, liveSpan.start, liveSpan.end);
    for (const slot of slots) {
      const rects = byPage.get(slot.pageNumber);
      if (!rects?.length) continue;
      for (const r of rects) {
        const box = document.createElement('div');
        box.className = 'docview__hl';
        // Anchors are measured at scale 1; the viewport transform is linear
        // in scale, so this multiply is exact rather than an approximation.
        box.style.left = `${r.x * scale}px`;
        box.style.top = `${r.y * scale}px`;
        box.style.width = `${r.width * scale}px`;
        box.style.height = `${r.height * scale}px`;
        slot.boxes.appendChild(box);
      }
    }
  }

  function setWindowCentre(index: number, scroll: boolean): void {
    const next = Math.max(0, Math.min(slots.length - 1, index));
    if (next === windowCentre && !scroll) return;
    windowCentre = next;
    setCount(next + 1);
    if (scroll) {
      const slot = slots[next];
      // Centre it rather than nudging it to the top: the sentence being read
      // is in the middle of a page, and putting the page's top edge under the
      // toolbar hides the part being spoken.
      scroller.scrollTop = slot.surface.offsetTop - (scroller.clientHeight - slot.height) / 2;
    }
    paintWindow();
  }

  /**
   * The character offset under a point, or null when the point is not on text.
   *
   * Resolved against the anchors rather than against the rendered glyphs,
   * which is what makes a click land where the highlight would: both are
   * answering "which characters are at this point on the page".
   */
  function offsetAtPoint(clientX: number, clientY: number): number | null {
    for (const slot of slots) {
      const box = slot.surface.getBoundingClientRect();
      if (clientX < box.left || clientX > box.right) continue;
      if (clientY < box.top || clientY > box.bottom) continue;

      // Anchors are recorded at scale 1, so undo the zoom before comparing.
      const x = (clientX - box.left) / scale;
      const y = (clientY - box.top) / scale;

      for (const a of anchors) {
        if (a.page !== slot.pageNumber) continue;
        if (y < a.y || y > a.y + a.height) continue;
        if (x < a.x - 2 || x > a.x + a.width + 2) continue;
        // Anywhere in the run is close enough to know which sentence was
        // meant, but proportional placement means clicking the last word of a
        // long line does not read from the first.
        const fraction = a.width > 0 ? (x - a.x) / a.width : 0;
        const span = a.end - a.start;
        const within = Math.max(0, Math.min(span - 1, Math.floor(fraction * span)));
        return a.start + within;
      }
      return null;
    }
    return null;
  }

  host.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-role]');
    if (!target) {
      // Not a control, so it is a click on the document itself.
      const offset = options.onPick ? offsetAtPoint(e.clientX, e.clientY) : null;
      if (offset !== null) options.onPick?.(offset);
      return;
    }
    const role = target.dataset.role;
    if (role === 'prev') setWindowCentre(windowCentre - 1, true);
    else if (role === 'next') setWindowCentre(windowCentre + 1, true);
    else if (role === 'zoom-in' || role === 'zoom-out') {
      scale = Math.min(3, Math.max(0.6, scale + (role === 'zoom-in' ? 0.15 : -0.15)));
      for (const slot of slots) {
        if (slot.canvas) { slot.canvas.remove(); slot.canvas = null; }
        slot.boxes.replaceChildren();
      }
      paintWindow();
    }
  });

  setCount(windowCentre + 1);
  paintWindow();

  return {
    get pageCount() { return pageCount; },
    get activePage() { return liveSpan ? firstPageOf(anchors, liveSpan) : 0; },
    highlight(start, end) {
      liveSpan = { start, end };
      paintHighlights();
      const page = firstPageOf(anchors, liveSpan);
      if (page > 0) setWindowCentre(page - 1, true);
    },
    showPage(page) { setWindowCentre(page - 1, true); },
    destroy() {
      destroyed = true;
      for (const slot of slots) slot.canvas?.remove();
      host.replaceChildren();
      host.classList.remove('docview');
      // destroy() hangs off the loading task, not the document proxy.
      void loadingTask.destroy();
    },
  };
}

/**
 * Show a reflowable document (DOCX, EPUB) as a real document.
 *
 * Highlighting uses the `data-off` stamps rather than searching for the
 * sentence's text. A search is what most readers do and it is quietly wrong the
 * first time a sentence appears twice or contains a typographic quote. Since
 * the offsets are exact, the interesting part is turning "characters 4182–4221
 * of run 96" back into a DOM Range, which is what `locate` is for.
 *
 * The highlight is drawn as an overlay rather than by wrapping the text in a
 * span, because wrapping mutates the DOM and would invalidate the very offset
 * map the next highlight depends on — the reader would highlight correctly
 * once and then drift.
 */
export interface HtmlViewOptions {
  /** Called with the character offset of a click on the text. See PdfViewOptions. */
  onPick?: (offset: number) => void;
  /** Called when the view cannot render the markup at all. */
  onError?: (error: unknown) => void;
}

export function mountHtmlView(
  host: HTMLElement,
  html: string,
  label: string,
  options: HtmlViewOptions = {},
): DocumentView {
  host.classList.add('docview', 'docview--html');
  host.innerHTML = `
    <div class="docview__pages">
      <article class="dochtml" aria-label="${escapeAttr(label)}">
        <div class="dochtml__content"></div>
        <div class="dochtml__overlay" aria-hidden="true"></div>
      </article>
    </div>`;
  const article = host.querySelector<HTMLElement>('.dochtml')!;
  const content = host.querySelector<HTMLElement>('.dochtml__content')!;
  const overlay = host.querySelector<HTMLElement>('.dochtml__overlay')!;

  // The markup is built by blocksToTextAndHtml from the user's own file, and
  // every text-bearing element was escaped on the way in. This assignment is
  // the boundary that escaping exists to protect.
  content.innerHTML = html;

  interface Stamped { el: HTMLElement; start: number; end: number }
  const stamped: Stamped[] = [];
  for (const el of Array.from(content.querySelectorAll<HTMLElement>('[data-off]'))) {
    const range = parseOffsetAttr(el.dataset.off);
    if (range) stamped.push({ el, start: range.start, end: range.end });
  }

  let destroyed = false;
  let active: HTMLElement[] = [];

  /** The text node and in-node offset for a character offset inside `el`. */
  function locate(el: Element, offset: number): { node: Text; offset: number } | null {
    let remaining = offset;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node: node as Text, offset: remaining };
      remaining -= length;
      node = walker.nextNode();
    }
    return null;
  }

  function clear(): void {
    overlay.replaceChildren();
    for (const el of active) el.classList.remove('dochtml-active');
    active = [];
  }

  /**
   * Where a text node's characters sit inside one stamped run.
   *
   * The caret APIs report an offset *within a text node*, and a run's text can
   * be wrapped in `<strong>` or `<em>`, so the two are not the same number.
   * Walking the run's text nodes to find the one that was hit is exact for any
   * nesting, and it reuses the same walk as `locate` in the other direction.
   */
  function offsetWithin(el: Element, node: Node, inNode: number): number | null {
    let seen = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text) {
      if (text === node) return seen + inNode;
      seen += text.textContent?.length ?? 0;
      text = walker.nextNode();
    }
    return null;
  }

  /**
   * The global character offset under a point, or null if it is not over text.
   *
   * The browser's own caret hit-test is preferred because it knows where the
   * glyphs are, so clicking a word gives that word. It is optional in either
   * spelling (`caretRangeFromPoint` in Chrome and Safari,
   * `caretPositionFromPoint` in Firefox), so the element under the point is
   * used as a fallback rather than assuming either exists.
   */
  function offsetAtPoint(clientX: number, clientY: number): number | null {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let inNode = 0;
    const range = doc.caretRangeFromPoint?.(clientX, clientY);
    if (range) {
      node = range.startContainer;
      inNode = range.startOffset;
    } else {
      const position = doc.caretPositionFromPoint?.(clientX, clientY);
      if (position) {
        node = position.offsetNode;
        inNode = position.offset;
      }
    }

    if (node && node.nodeType === Node.TEXT_NODE) {
      const el = node.parentElement?.closest<HTMLElement>('[data-off]');
      const span = el ? parseOffsetAttr(el.dataset.off) : null;
      const within = el && span ? offsetWithin(el, node, inNode) : null;
      if (span && within !== null) {
        return Math.max(span.start, Math.min(span.end - 1, span.start + within));
      }
    }

    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-off]');
    const span = el ? parseOffsetAttr(el.dataset.off) : null;
    if (!el || !span) return null;
    const box = el.getBoundingClientRect();
    const fraction = box.width > 0 ? (clientX - box.left) / box.width : 0;
    const size = span.end - span.start;
    return span.start + Math.max(0, Math.min(size - 1, Math.floor(fraction * size)));
  }

  content.addEventListener('click', (e) => {
    if (!options.onPick) return;
    const offset = offsetAtPoint(e.clientX, e.clientY);
    if (offset !== null) options.onPick(offset);
  });

  return {
    get pageCount() { return 0; },
    get activePage() { return 0; },
    showPage() { host.querySelector('.docview__pages')?.scrollTo({ top: 0 }); },
    highlight(start, end) {
      if (destroyed) return;
      clear();
      if (!(end > start)) return;

      const hits = overlappingRanges(stamped, start, end);
      if (!hits.length) return;

      const articleBox = article.getBoundingClientRect();
      let scrolled = false;
      for (const hit of hits) {
        hit.el.classList.add('dochtml-active');
        active.push(hit.el);

        // Intersect the sentence with this run, then convert both ends to
        // (text node, offset) so a sentence that starts mid-run highlights
        // only its own words rather than the whole run.
        const from = locate(hit.el, Math.max(start, hit.start) - hit.start);
        const to = locate(hit.el, Math.min(end, hit.end) - hit.start);
        if (!from || !to) continue;
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        for (const rect of Array.from(range.getClientRects())) {
          if (!rect.width || !rect.height) continue;
          const box = document.createElement('div');
          box.className = 'dochtml__hl';
          box.style.left = `${rect.left - articleBox.left}px`;
          box.style.top = `${rect.top - articleBox.top}px`;
          box.style.width = `${rect.width}px`;
          box.style.height = `${rect.height}px`;
          overlay.appendChild(box);
        }
        if (!scrolled) {
          scrolled = true;
          hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    },
    destroy() {
      destroyed = true;
      clear();
      host.replaceChildren();
      host.classList.remove('docview', 'docview--html');
    },
  };
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The page a span starts on, or 0 when the span has no geometry. */
function firstPageOf(anchors: TextAnchor[], span: { start: number; end: number }): number {
  if (!anchors.length) return 0;
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].start >= span.start) hi = mid - 1;
    else lo = mid + 1;
  }
  const a = anchors[Math.min(lo, anchors.length - 1)];
  return a.end > span.start ? a.page : 0;
}
