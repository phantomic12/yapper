import type { TextAnchor } from '../document-types';
import { rectsForSpan } from '../document-types';
import { escapeHtmlText, parseOffsetAttr, overlappingRanges } from '../document-html';
import { findMatches, matchSnippet, type SearchMatch } from './document-search';
import {
  buildOutline,
  outlineIndexForOffset,
  outlineIndexForPageNear,
  type OutlineItem,
} from './document-outline';
import { paginateIntoPages, type PagePagination } from './pagination';

const WINDOW_RADIUS = 2;
const MAX_LIVE_CANVASES = 7;
const MAX_VISIBLE_PDF_PAGES = 500;
const MAX_SEARCH_RESULTS = 200;

export type DocumentTheme = 'light' | 'sepia' | 'night';
const THEME_ORDER: DocumentTheme[] = ['light', 'sepia', 'night'];
const THEME_LABELS: Record<DocumentTheme, string> = {
  light: 'Light',
  sepia: 'Sepia',
  night: 'Night',
};

function normalizeTheme(value: unknown): DocumentTheme {
  return value === 'sepia' || value === 'night' ? value : 'light';
}

export type DocumentFontFamily = 'serif' | 'sans' | 'mono';
const FONT_FAMILY_ORDER: DocumentFontFamily[] = ['serif', 'sans', 'mono'];
const FONT_FAMILY_LABELS: Record<DocumentFontFamily, string> = {
  serif: 'Serif',
  sans: 'Sans',
  mono: 'Mono',
};
const FONT_FAMILY_STACKS: Record<DocumentFontFamily, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Cascadia Mono", Consolas, "Courier New", monospace',
};

function normalizeFontFamily(value: unknown): DocumentFontFamily {
  return value === 'serif' || value === 'mono' ? value : 'sans';
}

/** A user-made marked range, kept across searches and page turns. */
export interface DocumentAnnotation {
  start: number;
  end: number;
  color: 'yellow' | 'green' | 'blue';
}

/** Search controls exposed for keyboard shortcuts and panels. */
export interface DocumentSearchApi {
  focus(): void;
  next(): void;
  prev(): void;
  /** Paint (or un-paint) every current match in the document body. */
  toggleHighlightAll(): void;
}

export interface DocumentView {
  /**
   * Paint the reader's position. `context` is the surrounding sentence (or
   * note) painted faintly behind the karaoke-bright word span.
   */
  highlight(start: number, end: number, context?: { start: number; end: number }): void;
  readonly pageCount: number;
  readonly activePage: number;
  readonly scale?: number;
  readonly theme?: DocumentTheme;
  readonly fontFamily?: DocumentFontFamily;
  showPage(page: number): void;
  goToOffset(offset: number): void;
  nextPage(): void;
  prevPage(): void;
  zoomIn(): void;
  zoomOut(): void;
  cycleTheme(): void;
  getOutline(): OutlineItem[];
  setAnnotations(annotations: DocumentAnnotation[]): void;
  readonly search?: DocumentSearchApi;
  destroy(): void;
}

interface PageSlot {
  index: number;
  pageNumber: number;
  width: number;
  height: number;
  wrap: HTMLDivElement;
  surface: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  boxes: HTMLDivElement;
  rendering: boolean;
}

interface SectionTarget { title: string; start: number; end: number }
interface NavigationPosition {
  page?: number;
  offset?: number;
  scale?: number;
  theme?: DocumentTheme;
  fontFamily?: DocumentFontFamily;
}

/** Options shared by the search UI of both view kinds. */
interface SearchUiElements {
  input: HTMLInputElement;
  caseButton: HTMLButtonElement;
  wordButton: HTMLButtonElement;
  regexButton: HTMLButtonElement;
  highlightButton: HTMLButtonElement;
  scopeButton: HTMLButtonElement | null;
  previousButton: HTMLButtonElement;
  nextButton: HTMLButtonElement;
  panel: HTMLElement;
  status: HTMLElement;
  results: HTMLElement;
}

function searchToolbarHtml(hasScope = false): string {
  return `
      <label class="docview__search-label" for="docview-search">Find</label>
      <input class="docview__search" id="docview-search" type="search" placeholder="Search document" aria-label="Search document text" />
      <button class="docview__toggle" type="button" data-role="search-regex" aria-pressed="false" aria-label="Treat the query as a regular expression">.*</button>
      <button class="docview__toggle" type="button" data-role="search-case" aria-pressed="false" aria-label="Match case">Aa</button>
      <button class="docview__toggle" type="button" data-role="search-word" aria-pressed="false" aria-label="Match whole words only">W</button>
      <button class="docview__toggle" type="button" data-role="search-highlight" aria-pressed="false" aria-label="Highlight all matches">HL</button>
      ${hasScope ? `<button class="docview__toggle" type="button" data-role="search-scope" aria-pressed="false" aria-label="Limit search to the current section">Scope</button>` : ''}
      <button class="docview__nav" type="button" data-role="search-prev" aria-label="Previous search result">↑</button>
      <button class="docview__nav" type="button" data-role="search-next" aria-label="Next search result">↓</button>`;
}

function searchPanelHtml(): string {
  return `
    <div class="docview__search-panel" data-role="search-panel" hidden>
      <div class="docview__search-status" role="status" aria-live="polite"></div>
      <ul class="docview__results" aria-label="Search results"></ul>
    </div>`;
}

function querySearchElements(host: HTMLElement): SearchUiElements {
  return {
    input: host.querySelector<HTMLInputElement>('.docview__search')!,
    caseButton: host.querySelector<HTMLButtonElement>('[data-role="search-case"]')!,
    wordButton: host.querySelector<HTMLButtonElement>('[data-role="search-word"]')!,
    regexButton: host.querySelector<HTMLButtonElement>('[data-role="search-regex"]')!,
    highlightButton: host.querySelector<HTMLButtonElement>('[data-role="search-highlight"]')!,
    scopeButton: host.querySelector<HTMLButtonElement>('[data-role="search-scope"]'),
    previousButton: host.querySelector<HTMLButtonElement>('[data-role="search-prev"]')!,
    nextButton: host.querySelector<HTMLButtonElement>('[data-role="search-next"]')!,
    panel: host.querySelector<HTMLElement>('[data-role="search-panel"]')!,
    status: host.querySelector<HTMLElement>('.docview__search-status')!,
    results: host.querySelector<HTMLElement>('.docview__results')!,
  };
}

/**
 * The state and rendering of a document search: the match list with
 * one-click jumps, the case/whole-word toggles, and the prev/next cycling
 * both views share. The views only supply where the text comes from and
 * what jumping to a match means.
 */
function createSearchController(options: {
  ui: SearchUiElements;
  getText: () => string;
  /** Resolve false to skip this search round (e.g. OCR indexing failed). */
  prepare?: () => Promise<boolean>;
  /** Current section bounds, used when scoped search is on. */
  rangeLimit?: () => { start: number; end: number } | null;
  onJump: (match: SearchMatch, index: number, total: number) => void;
  /** Paint every match (or none) when "highlight all" is toggled. */
  onHighlightAll?: (matches: SearchMatch[]) => void;
  onCleared: () => void;
}) {
  const { ui } = options;
  let matches: SearchMatch[] = [];
  let index = -1;
  let caseSensitive = false;
  let wholeWord = false;
  let regex = false;
  let highlightAll = false;
  let scope = false;
  let truncated = false;
  let invalid = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  function renderResults(): void {
    const text = options.getText();
    ui.results.replaceChildren();
    if (!ui.input.value.trim()) {
      ui.panel.hidden = true;
      ui.status.textContent = '';
      return;
    }
    ui.panel.hidden = false;
    if (!matches.length) {
      ui.status.textContent = invalid ? 'Invalid pattern' : 'No matches';
      return;
    }
    const scopeNote = scope ? ' in this section' : '';
    ui.status.textContent = truncated
      ? `Showing first ${matches.length} matches${scopeNote}`
      : `${matches.length} match${matches.length === 1 ? '' : 'es'}${scopeNote}`;
    for (const [i, match] of matches.entries()) {
      const snippet = matchSnippet(text, match);
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `docview__result${i === index ? ' docview__result--current' : ''}`;
      button.dataset.searchIndex = String(i);
      button.innerHTML = `<span class="docview__result-label">${i + 1}.</span> `
        + `${escapeHtmlText(snippet.before)}<strong>${escapeHtmlText(snippet.match)}</strong>`
        + escapeHtmlText(snippet.after);
      item.appendChild(button);
      ui.results.appendChild(item);
    }
  }

  function paintAll(): void {
    options.onHighlightAll?.(highlightAll ? matches : []);
  }

  function refresh(): void {
    const summary = findMatches(
      options.getText(),
      ui.input.value,
      { caseSensitive, wholeWord, regex },
      MAX_SEARCH_RESULTS,
    );
    const range = scope ? options.rangeLimit?.() ?? null : null;
    matches = range
      ? summary.matches.filter(match => match.start >= range.start && match.end <= range.end)
      : summary.matches;
    truncated = summary.truncated;
    invalid = summary.invalid === true;
    // Find-as-you-type: land on the first hit like every document viewer.
    index = matches.length ? 0 : -1;
    renderResults();
    paintAll();
    if (matches.length) options.onJump(matches[0], 0, matches.length);
  }

  function jump(direction: 1 | -1 = 1): void {
    if (!matches.length) return;
    index = (index + direction + matches.length) % matches.length;
    renderResults();
    options.onJump(matches[index], index, matches.length);
  }

  function clear(): void {
    ui.input.value = '';
    matches = [];
    index = -1;
    truncated = false;
    invalid = false;
    renderResults();
    options.onHighlightAll?.([]);
    options.onCleared();
  }

  function toggleCase(): void {
    caseSensitive = !caseSensitive;
    ui.caseButton.setAttribute('aria-pressed', String(caseSensitive));
    refresh();
  }

  function toggleWholeWord(): void {
    wholeWord = !wholeWord;
    ui.wordButton.setAttribute('aria-pressed', String(wholeWord));
    refresh();
  }

  function toggleRegex(): void {
    regex = !regex;
    ui.regexButton.setAttribute('aria-pressed', String(regex));
    refresh();
  }

  function toggleHighlightAll(): void {
    highlightAll = !highlightAll;
    ui.highlightButton.setAttribute('aria-pressed', String(highlightAll));
    paintAll();
  }

  function toggleScope(): void {
    scope = !scope;
    ui.scopeButton?.setAttribute('aria-pressed', String(scope));
    refresh();
  }

  ui.input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void Promise.resolve(options.prepare?.() ?? true).then(ready => {
        if (ready) refresh();
      });
    }, 120);
  });
  ui.input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jump(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      clear();
    }
  });
  ui.results.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-search-index]');
    if (!button) return;
    const next = Number(button.dataset.searchIndex);
    if (!Number.isInteger(next) || !matches[next]) return;
    index = next;
    renderResults();
    options.onJump(matches[index], index, matches.length);
  });

  return {
    refresh,
    jump,
    clear,
    toggleCase,
    toggleWholeWord,
    toggleRegex,
    toggleHighlightAll,
    toggleScope,
    focus: () => {
      ui.input.focus();
      ui.input.select();
    },
    dispose: () => clearTimeout(searchTimer),
    get current(): SearchMatch | null {
      return index >= 0 ? matches[index] : null;
    },
  };
}

export interface PdfViewOptions {
  initialPage?: number;
  scale?: number;
  initialScale?: number;
  initialTheme?: DocumentTheme;
  text?: string;
  sections?: SectionTarget[];
  onNavigate?: (position: NavigationPosition) => void;
  onPick?: (offset: number) => void;
  onError?: (error: unknown, pageNumber: number) => void;
  /**
   * Lazy text for search over documents whose pages have no text layer
   * (scanned PDFs). Called the first time the user searches; returning OCR
   * text plus its anchors turns search, highlights and page jumps on without
   * paying for OCR when nobody searches.
   */
  loadSearchText?: (
    onProgress: (message: string) => void,
  ) => Promise<{ text: string; anchors: TextAnchor[] }>;
}

/** Mount an accessible, window-rendered PDF surface. */
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
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  const totalPageCount = pdf.numPages;
  const pageCount = Math.min(totalPageCount, MAX_VISIBLE_PDF_PAGES);
  const baseScale = Math.min(3, Math.max(0.6, options.initialScale ?? options.scale ?? 1.35));
  const pageCountLabel = pageCount < totalPageCount
    ? `${pageCount} (first ${pageCount} of ${totalPageCount})`
    : String(pageCount);

  host.classList.add('docview');
  host.innerHTML = `
    <div class="docview__bar" role="toolbar" aria-label="Document pages">
      <button class="docview__nav" type="button" data-role="prev" aria-label="Previous page">‹</button>
      <span class="docview__count" role="status" aria-live="polite">Page 1 of ${pageCountLabel}</span>
      <button class="docview__nav" type="button" data-role="next" aria-label="Next page">›</button>
      ${(options.sections?.length ?? 0) > 1 ? `
        <label class="visually-hidden" for="docview-section">Navigate chapters</label>
        <select class="docview__section" id="docview-section" aria-label="Navigate chapters">
          ${options.sections!.map((section, index) => `<option value="${index}">${escapeHtmlText(section.title)}</option>`).join('')}
        </select>` : ''}
      <button class="docview__nav" type="button" data-role="toggle-thumbnails" aria-expanded="false">Thumbnails</button>
      <button class="docview__nav" type="button" data-role="toggle-outline" aria-expanded="false">Outline</button>
      ${searchToolbarHtml((options.sections?.length ?? 0) > 1)}
      <span class="docview__spacer"></span>
      <button class="docview__zoom" type="button" data-role="zoom-out" aria-label="Zoom out">−</button>
      <span class="docview__zoom-readout" data-role="zoom-readout" aria-live="off">${Math.round(baseScale * 100)}%</span>
      <button class="docview__zoom" type="button" data-role="zoom-in" aria-label="Zoom in">+</button>
      <button class="docview__nav" type="button" data-role="fit-width" aria-label="Fit page width">Fit width</button>
      <button class="docview__nav" type="button" data-role="fit-page" aria-label="Fit whole page">Fit page</button>
      <button class="docview__theme" type="button" data-role="theme" aria-label="Reading theme: ${THEME_LABELS[normalizeTheme(options.initialTheme)]}. Click to change.">${THEME_LABELS[normalizeTheme(options.initialTheme)]}</button>
    </div>
    ${searchPanelHtml()}
    <div class="docview__body">
      <nav class="docview__outline" aria-label="Document outline" hidden></nav>
      <nav class="docview__thumbnails" aria-label="Page thumbnails" hidden></nav>
      <div class="docview__pages" tabindex="0" role="region" aria-label="Document pages"></div>
    </div>`;

  const scroller = host.querySelector<HTMLDivElement>('.docview__pages')!;
  const countEl = host.querySelector<HTMLSpanElement>('.docview__count')!;
  const previousButton = host.querySelector<HTMLButtonElement>('[data-role="prev"]')!;
  const nextButton = host.querySelector<HTMLButtonElement>('[data-role="next"]')!;
  const thumbnails = host.querySelector<HTMLElement>('.docview__thumbnails')!;
  const outlinePanel = host.querySelector<HTMLElement>('.docview__outline')!;
  const sectionSelect = host.querySelector<HTMLSelectElement>('.docview__section');
  const themeButton = host.querySelector<HTMLButtonElement>('[data-role="theme"]')!;
  const zoomReadout = host.querySelector<HTMLElement>('[data-role="zoom-readout"]')!;
  const searchUi = querySearchElements(host);
  const slots: PageSlot[] = [];
  const eventController = new AbortController();
  const { signal } = eventController;
  let searchSpan: { start: number; end: number } | null = null;
  let contextSpan: { start: number; end: number } | null = null;
  let allMatches: SearchMatch[] = [];
  let annotations: DocumentAnnotation[] = [];
  let outlineItems: OutlineItem[] = [];
  let notifyScrollTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressScrollNotification = false;
  let sectionIndex = 0;
  let scale = baseScale;
  let theme = normalizeTheme(options.initialTheme);
  let windowCentre = Math.max(0, Math.min(pageCount - 1, (options.initialPage ?? 1) - 1));
  let liveSpan: { start: number; end: number } | null = null;
  let destroyed = false;

  // Searchable text and its anchors: swapped in when OCR indexing finishes
  // for a scanned document, after which search and highlights work normally.
  let searchText = options.text ?? '';
  let searchAnchors = anchors;
  let searchIndexing = false;
  let searchIndexError: string | null = null;

  host.setAttribute('aria-label', `Pages of ${file.name}`);
  host.dataset.docTheme = theme;
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: baseScale });
      const wrap = document.createElement('div');
      wrap.className = 'docview__page';
      wrap.dataset.page = String(pageNumber);
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', `Page ${pageNumber} of ${pageCountLabel}`);
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
      slots.push({ index: pageNumber - 1, pageNumber, width: viewport.width, height: viewport.height,
        wrap, surface, canvas: null, boxes, rendering: false });

      const thumbnail = document.createElement('button');
      thumbnail.type = 'button';
      thumbnail.className = 'docview__thumbnail';
      thumbnail.dataset.page = String(pageNumber);
      thumbnail.setAttribute('aria-label', `Go to page ${pageNumber}`);
      thumbnail.innerHTML = `<span class="docview__thumbnail-page">${pageNumber}</span><span class="docview__thumbnail-preview" aria-hidden="true"></span>`;
      thumbnails.appendChild(thumbnail);
      page.cleanup();
    }
  } catch (error) {
    eventController.abort();
    host.replaceChildren();
    host.classList.remove('docview');
    await loadingTask.destroy();
    throw error;
  }

  // The file's own outline (PDF bookmarks), resolved to pages and rendered
  // as the side panel both views share. Hidden entirely when empty rather
  // than offering a panel with nothing in it.
  outlineItems = await resolvePdfOutline(pdf);
  renderOutlineList(outlinePanel, outlineItems, item => {
    if (item.page) setWindowCentre(item.page - 1, true);
  });
  const outlineButton = host.querySelector<HTMLButtonElement>('[data-role="toggle-outline"]');
  if (outlineButton && !outlineItems.length) outlineButton.hidden = true;

  const thumbObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const button = entry.target as HTMLButtonElement;
      thumbObserver?.unobserve(button);
      void renderThumbnail(Number(button.dataset.page), button);
    }
  }, { root: thumbnails, rootMargin: '120px' });
  thumbnails.querySelectorAll<HTMLButtonElement>('.docview__thumbnail').forEach(button => {
    if (thumbObserver) thumbObserver.observe(button);
    else void renderThumbnail(Number(button.dataset.page), button);
  });

  async function renderThumbnail(pageNumber: number, button: HTMLButtonElement): Promise<void> {
    try {
      const page = await pdf.getPage(pageNumber);
      const thumbScale = Math.min(0.13, 76 / page.getViewport({ scale: 1 }).width);
      const viewport = page.getViewport({ scale: thumbScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.className = 'docview__thumbnail-canvas';
      const context = canvas.getContext('2d');
      if (!context) return;
      await page.render({ canvasContext: context, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
      if (!destroyed && button.isConnected) {
        button.querySelector('.docview__thumbnail-preview')?.replaceChildren(canvas);
      }
      page.cleanup();
    } catch (error) {
      options.onError?.(error, pageNumber);
    }
  }

  function currentOffset(): number | undefined {
    return searchAnchors.find(anchor => anchor.page === windowCentre + 1)?.start
      ?? liveSpan?.start ?? searchSpan?.start;
  }

  function setCount(pageNumber: number, notify = false): void {
    countEl.textContent = `Page ${pageNumber} of ${pageCountLabel}`;
    previousButton.disabled = pageNumber <= 1;
    nextButton.disabled = pageNumber >= pageCount;
    const offset = searchAnchors.find(anchor => anchor.page === pageNumber)?.start;
    if (notify) options.onNavigate?.({ page: pageNumber, offset, scale });
    const section = (options.sections ?? []).findIndex(item => offset !== undefined
      && offset >= item.start && offset < item.end);
    if (section >= 0) {
      sectionIndex = section;
      if (sectionSelect) sectionSelect.value = String(section);
    }
    const outlineAt = outlineIndexForPageNear(outlineItems, pageNumber);
    if (outlineAt >= 0) markOutlineCurrent(outlinePanel, outlineAt);
    thumbnails.querySelectorAll<HTMLButtonElement>('.docview__thumbnail').forEach(button => {
      button.setAttribute('aria-current', Number(button.dataset.page) === pageNumber ? 'page' : 'false');
    });
  }

  async function renderSlot(slot: PageSlot): Promise<void> {
    if (destroyed || slot.canvas || slot.rendering) return;
    slot.rendering = true;
    const renderScale = scale;
    try {
      const page = await pdf.getPage(slot.pageNumber);
      const viewport = page.getViewport({ scale: renderScale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.className = 'docview__canvas';
      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      await page.render({
        canvasContext: context,
        viewport,
        canvas,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      } as Parameters<typeof page.render>[0]).promise;
      if (destroyed || renderScale !== scale) return;
      slot.surface.insertBefore(canvas, slot.boxes);
      slot.canvas = canvas;
    } catch (error) {
      options.onError?.(error, slot.pageNumber);
    } finally {
      slot.rendering = false;
      if (!destroyed && renderScale !== scale && Math.abs(slot.index - windowCentre) <= WINDOW_RADIUS) {
        void renderSlot(slot);
      }
    }
  }

  function releaseOutsideWindow(): void {
    let live = slots.reduce((total, slot) => total + (slot.canvas ? 1 : 0), 0);
    for (const slot of slots) {
      if (!slot.canvas || Math.abs(slot.index - windowCentre) <= WINDOW_RADIUS) continue;
      if (live <= MAX_LIVE_CANVASES && Math.abs(slot.index - windowCentre) <= WINDOW_RADIUS + 1) continue;
      slot.canvas.remove();
      slot.canvas = null;
      live--;
    }
  }

  function paintSpan(span: { start: number; end: number }, extraClass = ''): void {
    if (!searchAnchors.length) return;
    const byPage = rectsForSpan(searchAnchors, span.start, span.end);
    for (const slot of slots) {
      for (const rect of byPage.get(slot.pageNumber) ?? []) {
        const box = document.createElement('div');
        box.className = `docview__hl${extraClass}`;
        box.style.left = `${rect.x * scale}px`;
        box.style.top = `${rect.y * scale}px`;
        box.style.width = `${rect.width * scale}px`;
        box.style.height = `${rect.height * scale}px`;
        slot.boxes.appendChild(box);
      }
    }
  }

  function paintHighlights(): void {
    for (const slot of slots) slot.boxes.replaceChildren();
    for (const match of allMatches) paintSpan(match, ' docview__hl--all');
    for (const annotation of annotations) paintSpan(annotation, ` docview__hl--${annotation.color}`);
    if (contextSpan) paintSpan(contextSpan, ' docview__hl--context');
    if (liveSpan) paintSpan(liveSpan);
  }

  function paintWindow(): void {
    const ratio = scale / baseScale;
    for (const slot of slots) {
      slot.wrap.style.width = `${slot.width * ratio}px`;
      slot.wrap.style.height = `${slot.height * ratio}px`;
      slot.surface.style.width = `${slot.width * ratio}px`;
      slot.surface.style.height = `${slot.height * ratio}px`;
    }
    for (let index = windowCentre - WINDOW_RADIUS; index <= windowCentre + WINDOW_RADIUS; index++) {
      if (index >= 0 && index < slots.length) void renderSlot(slots[index]);
    }
    releaseOutsideWindow();
    paintHighlights();
  }

  function setWindowCentre(index: number, scroll: boolean, notify = true): void {
    const next = Math.max(0, Math.min(slots.length - 1, index));
    if (next === windowCentre && !scroll) return;
    windowCentre = next;
    setCount(next + 1);
    if (scroll) {
      const slot = slots[next];
      suppressScrollNotification = true;
      const scaledHeight = slot.height * scale / baseScale;
      scroller.scrollTop = slot.wrap.offsetTop - (scroller.clientHeight - scaledHeight) / 2;
      clearTimeout(notifyScrollTimer);
      notifyScrollTimer = setTimeout(() => { suppressScrollNotification = false; }, 250);
    }
    paintWindow();
    if (notify) options.onNavigate?.({
      page: next + 1,
      offset: searchAnchors.find(anchor => anchor.page === next + 1)?.start ?? liveSpan?.start,
      scale,
    });
  }

  function applyScale(next: number, notify = true): void {
    scale = Math.min(3, Math.max(0.6, next));
    for (const slot of slots) { slot.canvas?.remove(); slot.canvas = null; }
    paintWindow();
    zoomReadout.textContent = `${Math.round(scale * 100)}%`;
    if (notify) options.onNavigate?.({ page: windowCentre + 1, offset: currentOffset(), scale });
  }

  function fitScale(mode: 'width' | 'page'): number {
    const slot = slots[windowCentre];
    const naturalWidth = slot.width / baseScale;
    const naturalHeight = slot.height / baseScale;
    const availableWidth = Math.max(80, scroller.clientWidth - 32);
    const byWidth = availableWidth / naturalWidth;
    return mode === 'width'
      ? byWidth
      : Math.min(byWidth, Math.max(80, scroller.clientHeight - 32) / naturalHeight);
  }

  function applyTheme(next: DocumentTheme, notify = true): void {
    theme = next;
    host.dataset.docTheme = next;
    themeButton.textContent = THEME_LABELS[next];
    themeButton.setAttribute('aria-label', `Reading theme: ${THEME_LABELS[next]}. Click to change.`);
    if (notify) options.onNavigate?.({ theme: next });
  }

  async function ensureSearchText(): Promise<boolean> {
    if (searchText.trim()) return true;
    if (!options.loadSearchText) return true;
    if (searchIndexError || searchIndexing) return false;
    searchIndexing = true;
    searchUi.status.textContent = 'Indexing scanned pages for search…';
    try {
      const indexed = await options.loadSearchText(message => {
        searchUi.status.textContent = message;
      });
      searchText = indexed.text;
      searchAnchors = indexed.anchors;
      paintHighlights();
    } catch (error) {
      searchIndexError = error instanceof Error ? error.message : String(error);
      searchUi.status.textContent = `Search unavailable: ${searchIndexError}`;
    } finally {
      searchIndexing = false;
    }
    return !!searchText.trim();
  }

  const search = createSearchController({
    ui: searchUi,
    getText: () => searchText,
    prepare: ensureSearchText,
    rangeLimit: () => {
      const section = options.sections?.[sectionIndex];
      return section ? { start: section.start, end: section.end } : null;
    },
    onHighlightAll: list => {
      allMatches = list;
      paintHighlights();
    },
    onJump: (match, matchIndex, total) => {
      const page = firstPageOf(searchAnchors, match);
      if (page) setWindowCentre(page - 1, true, false);
      searchSpan = match;
      liveSpan = match;
      paintHighlights();
      options.onNavigate?.({ offset: match.start, page: page || undefined, scale });
      countEl.textContent = page
        ? `Match ${matchIndex + 1} of ${total} · Page ${page} of ${pageCountLabel}`
        : `Match ${matchIndex + 1} of ${total}`;
    },
    onCleared: () => {
      searchSpan = null;
      liveSpan = null;
      contextSpan = null;
      paintHighlights();
      setCount(windowCentre + 1);
    },
  });

  host.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-role]');
    if (!target) {
      const offset = options.onPick ? offsetAtPoint(event.clientX, event.clientY) : null;
      if (offset !== null) options.onPick?.(offset);
      return;
    }
    const role = target.dataset.role;
    if (role === 'prev') setWindowCentre(windowCentre - 1, true);
    else if (role === 'next') setWindowCentre(windowCentre + 1, true);
    else if (role === 'zoom-in') applyScale(scale + 0.15);
    else if (role === 'zoom-out') applyScale(scale - 0.15);
    else if (role === 'fit-width') applyScale(fitScale('width'));
    else if (role === 'fit-page') applyScale(fitScale('page'));
    else if (role === 'theme') {
      const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
      applyTheme(next);
    } else if (role === 'toggle-thumbnails') {
      thumbnails.hidden = !thumbnails.hidden;
      target.setAttribute('aria-expanded', String(!thumbnails.hidden));
      if (!thumbnails.hidden) thumbnails.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    } else if (role === 'toggle-outline') {
      outlinePanel.hidden = !outlinePanel.hidden;
      target.setAttribute('aria-expanded', String(!outlinePanel.hidden));
      if (!outlinePanel.hidden) outlinePanel.querySelector<HTMLButtonElement>('.docview__outline-item')?.focus();
    } else if (role === 'search-prev') search.jump(-1);
    else if (role === 'search-next') search.jump(1);
    else if (role === 'search-case') search.toggleCase();
    else if (role === 'search-word') search.toggleWholeWord();
    else if (role === 'search-regex') search.toggleRegex();
    else if (role === 'search-highlight') search.toggleHighlightAll();
    else if (role === 'search-scope') search.toggleScope();
  }, { signal });

  sectionSelect?.addEventListener('change', () => {
    const sections = options.sections ?? [];
    if (!sections.length) return;
    sectionIndex = Math.max(0, Math.min(sections.length - 1, Number(sectionSelect.value)));
    goToOffset(sections[sectionIndex].start);
  }, { signal });

  thumbnails.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.docview__thumbnail');
    if (button) setWindowCentre(Number(button.dataset.page) - 1, true);
  }, { signal });
  scroller.addEventListener('keydown', event => {
    if (event.target !== scroller) return;
    if (event.key === 'ArrowDown' || event.key === 'PageDown') {
      event.preventDefault();
      setWindowCentre(windowCentre + 1, true);
    } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault();
      setWindowCentre(windowCentre - 1, true);
    } else if (event.key === '+' || event.key === '=') {
      applyScale(scale + 0.15);
    } else if (event.key === '-') {
      applyScale(scale - 0.15);
    }
  }, { signal });
  scroller.addEventListener('scroll', () => {
    if (destroyed || suppressScrollNotification) return;
    const centre = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    let nearest = windowCentre;
    let distance = Infinity;
    for (const slot of slots) {
      const slotRect = slot.wrap.getBoundingClientRect();
      const delta = Math.abs(slotRect.top + slotRect.height / 2 - centre);
      if (delta < distance) { distance = delta; nearest = slot.index; }
    }
    if (nearest !== windowCentre) setWindowCentre(nearest, false);
  }, { passive: true, signal });

  setCount(windowCentre + 1);
  paintWindow();
  if (options.initialPage && options.initialPage > 1) setWindowCentre(windowCentre, true, false);
  return {
    get pageCount() { return pageCount; },
    get activePage() { return windowCentre + 1; },
    get scale() { return scale; },
    get theme() { return theme; },
    highlight(start, end, context) {
      if (!searchSpan) {
        liveSpan = { start, end };
        contextSpan = context ?? null;
      }
      paintHighlights();
      const page = firstPageOf(searchAnchors, liveSpan ?? { start, end });
      if (page > 0) setWindowCentre(page - 1, true, false);
    },
    showPage(page) { setWindowCentre(page - 1, true); },
    goToOffset,
    nextPage() { setWindowCentre(windowCentre + 1, true); },
    prevPage() { setWindowCentre(windowCentre - 1, true); },
    zoomIn() { applyScale(scale + 0.15); },
    zoomOut() { applyScale(scale - 0.15); },
    cycleTheme() {
      applyTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]);
    },
    getOutline: () => outlineItems.slice(),
    setAnnotations(next) {
      annotations = next.slice();
      paintHighlights();
    },
    search: {
      focus: () => search.focus(),
      next: () => search.jump(1),
      prev: () => search.jump(-1),
      toggleHighlightAll: () => search.toggleHighlightAll(),
    },
    destroy() {
      destroyed = true;
      search.dispose();
      clearTimeout(notifyScrollTimer);
      thumbObserver?.disconnect();
      eventController.abort();
      for (const slot of slots) slot.canvas?.remove();
      host.replaceChildren();
      host.classList.remove('docview');
      void loadingTask.destroy();
    },
  };

  function goToOffset(offset: number): void {
    const page = firstPageOf(searchAnchors, { start: offset, end: offset + 1 });
    if (page > 0) setWindowCentre(page - 1, true);
  }

  function offsetAtPoint(clientX: number, clientY: number): number | null {
    for (const slot of slots) {
      const box = slot.surface.getBoundingClientRect();
      if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) continue;
      const x = (clientX - box.left) / scale;
      const y = (clientY - box.top) / scale;
      for (const anchor of searchAnchors) {
        if (anchor.page !== slot.pageNumber || y < anchor.y || y > anchor.y + anchor.height
          || x < anchor.x - 2 || x > anchor.x + anchor.width + 2) continue;
        const fraction = anchor.width > 0 ? (x - anchor.x) / anchor.width : 0;
        return anchor.start + Math.max(0, Math.min(anchor.end - anchor.start - 1,
          Math.floor(fraction * (anchor.end - anchor.start))));
      }
      return null;
    }
    return null;
  }
}

export interface HtmlViewOptions {
  onPick?: (offset: number) => void;
  initialScale?: number;
  initialTheme?: DocumentTheme;
  fontFamily?: DocumentFontFamily;
  /**
   * Flow the blocks onto A4-style page sheets — the PDF-reader look — instead
   * of one continuous article. Off for formats whose own layout is the
   * document (sheets, slides, grids), where a grid cannot reflow onto pages.
   */
  paginated?: boolean;
  /** Extracted text, so the view can search the same string the reader speaks. */
  text?: string;
  sections?: SectionTarget[];
  onNavigate?: (position: {
    page?: number;
    offset?: number;
    scale?: number;
    theme?: DocumentTheme;
    fontFamily?: DocumentFontFamily;
  }) => void;
  onError?: (error: unknown) => void;
}

function sectionTabsHtml(sections: SectionTarget[]): string {
  return `<div class="docview__tabs" role="tablist" aria-label="Document sections">
      ${sections.map((section, index) => `<button class="docview__tab${index === 0 ? ' docview__tab--active' : ''}" type="button" role="tab" data-section-index="${index}" aria-selected="${index === 0}">${escapeHtmlText(section.title)}</button>`).join('')}
    </div>`;
}

/** Show a reflowable document using stamped character ranges for navigation/highlights. */
export function mountHtmlView(
  host: HTMLElement,
  html: string,
  label: string,
  options: HtmlViewOptions = {},
): DocumentView {
  const paginated = options.paginated === true;
  host.classList.add('docview', 'docview--html');
  if (paginated) host.classList.add('docview--pages');
  const sections = options.sections ?? [];
  const theme = normalizeTheme(options.initialTheme);
  const initialFontFamily = normalizeFontFamily(options.fontFamily);
  const outline = buildOutline(html, sections);
  const hasSearch = !!options.text && !!options.text.trim();
  const showTabs = sections.length > 1 && sections.length <= 24;
  host.innerHTML = `
    <div class="docview__bar" role="toolbar" aria-label="Document navigation">
      ${paginated ? `
        <button class="docview__nav" type="button" data-role="page-prev" aria-label="Previous page">‹</button>
        <span class="docview__count" role="status" aria-live="polite">Page 1</span>
        <button class="docview__nav" type="button" data-role="page-next" aria-label="Next page">›</button>
        <button class="docview__nav" type="button" data-role="toggle-thumbnails" aria-expanded="false">Thumbnails</button>` : ''}
      ${sections.length > 1 ? `
        <button class="docview__nav" type="button" data-role="section-prev" aria-label="Previous section">‹</button>
        <label class="visually-hidden" for="docview-section">Navigate chapters, sheets, or slides</label>
        <select class="docview__section" id="docview-section" aria-label="Navigate chapters, sheets, or slides">
          ${sections.map((section, index) => `<option value="${index}">${escapeHtmlText(section.title)}</option>`).join('')}
        </select>
        <button class="docview__nav" type="button" data-role="section-next" aria-label="Next section">›</button>` : ''}
      ${outline.length ? `<button class="docview__nav" type="button" data-role="toggle-outline" aria-expanded="false">Outline</button>` : ''}
      ${sections.length > 1 ? `<button class="docview__nav" type="button" data-role="toggle-overview" aria-expanded="false">Overview</button>` : ''}
      ${hasSearch ? searchToolbarHtml(sections.length > 1) : ''}
      <span class="docview__spacer"></span>
      <button class="docview__zoom" type="button" data-role="font-down" aria-label="Decrease document text size">A−</button>
      <span class="docview__zoom-readout" data-role="zoom-readout" aria-live="off">100%</span>
      <button class="docview__zoom" type="button" data-role="font-up" aria-label="Increase document text size">A+</button>
      <button class="docview__toggle" type="button" data-role="font-family" aria-label="Change document font family">${FONT_FAMILY_LABELS[initialFontFamily]}</button>
      <button class="docview__theme" type="button" data-role="theme" aria-label="Reading theme: ${THEME_LABELS[theme]}. Click to change.">${THEME_LABELS[theme]}</button>
    </div>
    ${hasSearch ? searchPanelHtml() : ''}
    ${showTabs ? sectionTabsHtml(sections) : ''}
    <nav class="docview__outline" aria-label="Document outline" hidden></nav>
    <nav class="docview__overview" aria-label="Section overview" hidden></nav>
    <div class="docview__body">
      ${paginated ? '<nav class="docview__thumbnails" aria-label="Page thumbnails" hidden></nav>' : ''}
      <div class="docview__pages" tabindex="0" role="region" aria-label="${escapeAttr(label)}">
        <article class="dochtml" aria-label="${escapeAttr(label)}">
          <div class="dochtml__content"></div>
          <div class="dochtml__overlay" aria-hidden="true"></div>
        </article>
      </div>
    </div>`;
  const article = host.querySelector<HTMLElement>('.dochtml')!;
  const content = host.querySelector<HTMLElement>('.dochtml__content')!;
  const overlay = host.querySelector<HTMLElement>('.dochtml__overlay')!;
  const pageScroller = host.querySelector<HTMLElement>('.docview__pages')!;
  const thumbnails = host.querySelector<HTMLElement>('.docview__thumbnails');
  const sectionSelect = host.querySelector<HTMLSelectElement>('.docview__section');
  const themeButton = host.querySelector<HTMLButtonElement>('[data-role="theme"]')!;
  const zoomReadout = host.querySelector<HTMLElement>('[data-role="zoom-readout"]')!;
  const outlinePanel = host.querySelector<HTMLElement>('.docview__outline')!;
  const overviewPanel = host.querySelector<HTMLElement>('.docview__overview')!;
  const tabsRow = host.querySelector<HTMLElement>('.docview__tabs');
  const eventController = new AbortController();
  const { signal } = eventController;
  content.innerHTML = html;
  host.dataset.docTheme = theme;

  // Very long documents mount tens of thousands of blocks; the browser can
  // skip laying out and painting the ones far from the viewport, with an
  // intrinsic size standing in until they scroll into view. Highlighting
  // forces the hit blocks visible first so their ranges have real boxes.
  const virtual = content.children.length > 400;
  if (virtual) content.classList.add('dochtml__content--virtual');

  const collectStamped = (): Array<{ el: HTMLElement; start: number; end: number }> =>
    Array.from(content.querySelectorAll<HTMLElement>('[data-off]')).flatMap(el => {
      const range = parseOffsetAttr(el.dataset.off);
      return range ? [{ el, ...range }] : [];
    });
  // Re-collected after every repack: cutting a paragraph across sheets
  // rewrites the stamps on the pieces it lands on.
  let stamped = collectStamped();
  let destroyed = false;
  let active: HTMLElement[] = [];
  let sectionIndex = 0;
  let fontScale = Math.min(1.8, Math.max(0.75, options.initialScale ?? 1));
  let themeState = theme;
  let fontFamilyState = initialFontFamily;
  /** The page-sheet flow, when this document is shown as pages. */
  let pagination: PagePagination | null = null;
  /** Fills thumbnails as they scroll into the rail. */
  let thumbObserver: IntersectionObserver | null = null;
  /** While a programmatic page turn is animating, the scroll handler stands
   *  down so intermediate positions do not rewrite the active page. */
  let suppressScrollUntil = 0;
  /** The sheet the reader is on, for the counter and the page turns. */
  let activePageState = 1;
  let annotations: DocumentAnnotation[] = [];
  let allMatchRanges: SearchMatch[] = [];
  /** Boxes that outlive a single highlight: annotations and highlight-all. */
  let persistentBoxes: HTMLElement[] = [];
  /** Last block scrolled to, so per-word karaoke does not scroll per word. */
  let lastScrolledEl: Element | null = null;
  article.style.fontSize = `${fontScale}rem`;
  zoomReadout.textContent = `${Math.round(fontScale * 100)}%`;

  const searchUi = hasSearch ? querySearchElements(host) : null;
  const search = searchUi ? createSearchController({
    ui: searchUi,
    getText: () => options.text ?? '',
    rangeLimit: () => {
      const section = sections[sectionIndex];
      return section ? { start: section.start, end: section.end } : null;
    },
    onHighlightAll: list => {
      allMatchRanges = list;
      repaintPersistent();
    },
    onJump: match => highlightRange(match.start, match.end),
    onCleared: () => {
      clear();
      // Clearing the search keeps the toolbar quiet: nothing to report.
      if (searchUi) searchUi.status.textContent = '';
    },
  }) : null;

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
    for (const element of active) {
      element.classList.remove('dochtml-active');
      if (virtual) element.style.contentVisibility = '';
    }
    active = [];
    // Persistent boxes (annotations, highlight-all) survive a clear: they
    // are the document's marks, not the reader's cursor.
    overlay.append(...persistentBoxes);
  }

  function offsetWithin(el: Element, node: Node, inNode: number): number | null {
    let seen = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      if (current === node) return seen + inNode;
      seen += current.textContent?.length ?? 0;
      current = walker.nextNode();
    }
    return null;
  }

  function offsetAtPoint(clientX: number, clientY: number): number | null {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const range = doc.caretRangeFromPoint?.(clientX, clientY);
    const position = range
      ? { node: range.startContainer, offset: range.startOffset }
      : (() => {
          const caret = doc.caretPositionFromPoint?.(clientX, clientY);
          return caret ? { node: caret.offsetNode, offset: caret.offset } : null;
        })();
    if (position?.node.nodeType === Node.TEXT_NODE) {
      const el = position.node.parentElement?.closest<HTMLElement>('[data-off]');
      const stamp = el ? parseOffsetAttr(el.dataset.off) : null;
      const within = el && stamp ? offsetWithin(el, position.node, position.offset) : null;
      if (stamp && within !== null) return Math.max(stamp.start, Math.min(stamp.end - 1, stamp.start + within));
    }
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-off]');
    const stamp = element ? parseOffsetAttr(element.dataset.off) : null;
    if (!element || !stamp) return null;
    const box = element.getBoundingClientRect();
    const fraction = box.width > 0 ? (clientX - box.left) / box.width : 0;
    return stamp.start + Math.max(0, Math.min(stamp.end - stamp.start - 1,
      Math.floor(fraction * (stamp.end - stamp.start))));
  }

  function goToOffset(offset: number, notify = true): void {
    const target = stamped.find(item => item.start <= offset && item.end > offset)?.el;
    target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    const selected = sections.findIndex(section => offset >= section.start && offset < section.end);
    if (selected >= 0) {
      sectionIndex = selected;
      if (sectionSelect) sectionSelect.value = String(selected);
      updateActiveTab();
    }
    const outlineAt = outlineIndexForOffset(outline, offset);
    if (outlineAt >= 0) markOutlineCurrent(outlinePanel, outlineAt);
    if (notify) options.onNavigate?.({ offset, scale: fontScale });
  }

  function updateActiveTab(): void {
    tabsRow?.querySelectorAll<HTMLButtonElement>('.docview__tab').forEach(button => {
      const on = Number(button.dataset.sectionIndex) === sectionIndex;
      button.setAttribute('aria-selected', String(on));
      button.classList.toggle('docview__tab--active', on);
    });
  }

  /** First words of a section, for the overview cards. */
  function sectionSnippet(section: SectionTarget): string {
    const parts: string[] = [];
    for (const item of stamped) {
      if (item.end <= section.start || item.start >= section.end) continue;
      const text = (item.el.textContent ?? '').trim();
      if (text) parts.push(text);
      if (parts.join(' ').length > 140) break;
    }
    return parts.join(' ').slice(0, 140);
  }

  /** Slide/sheet cards, built once the first time the overview opens. */
  function renderOverview(): void {
    if (overviewPanel.childElementCount) return;
    for (const [index, section] of sections.entries()) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'docview__overview-card';
      card.dataset.sectionIndex = String(index);
      const title = document.createElement('span');
      title.className = 'docview__overview-title';
      title.textContent = section.title;
      const snippet = document.createElement('span');
      snippet.className = 'docview__overview-snippet';
      snippet.textContent = sectionSnippet(section);
      card.append(title, snippet);
      overviewPanel.appendChild(card);
    }
  }

  function stepPage(direction: 1 | -1): void {
    if (paginated) {
      goToSheet(activePageState + direction);
      return;
    }
    if (sections.length > 1) {
      sectionIndex = Math.max(0, Math.min(sections.length - 1, sectionIndex + direction));
      goToOffset(sections[sectionIndex].start);
      return;
    }
    pageScroller.scrollBy({ top: direction * pageScroller.clientHeight * 0.9, behavior: 'smooth' });
  }

  function applyLayout(notify = true): void {
    article.style.fontFamily = FONT_FAMILY_STACKS[fontFamilyState];
    host.querySelector<HTMLButtonElement>('[data-role="font-family"]')
      ?.replaceChildren(FONT_FAMILY_LABELS[fontFamilyState]);
    if (notify) {
      // A new family changes glyph widths, so the sheets must be packed
      // against the font that is actually rendering — the width itself
      // does not change, so the ResizeObserver never fires for this.
      relayoutPages();
      options.onNavigate?.({ fontFamily: fontFamilyState });
    }
  }

  /** The page sheets, when this document is laid out as pages. */
  function pageSheets(): HTMLElement[] {
    return Array.from(content.querySelectorAll<HTMLElement>('.docpage'));
  }

  /** Keep the page counter and the turn buttons in step with the sheets. */
  function updatePageLabel(): void {
    const sheets = pageSheets();
    activePageState = Math.max(1, Math.min(sheets.length || 1, activePageState));
    const label = host.querySelector('.docview__count');
    if (label) label.textContent = `Page ${activePageState} of ${Math.max(1, sheets.length)}`;
    const prev = host.querySelector<HTMLButtonElement>('[data-role="page-prev"]');
    const next = host.querySelector<HTMLButtonElement>('[data-role="page-next"]');
    if (prev) prev.disabled = activePageState <= 1;
    if (next) next.disabled = activePageState >= sheets.length;
    thumbnails?.querySelectorAll<HTMLButtonElement>('.docview__thumbnail').forEach(button => {
      button.setAttribute('aria-current',
        Number(button.dataset.page) === activePageState ? 'page' : 'false');
    });
  }

  function goToSheet(page: number): void {
    const sheets = pageSheets();
    const target = Math.max(1, Math.min(sheets.length, page));
    sheets[target - 1]?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    // Claim the page now rather than when the smooth scroll settles: two
    // quick turns should land two pages ahead, not both re-target the same
    // one. A manual scroll past this page still corrects and reports.
    if (target === activePageState) return;
    activePageState = target;
    updatePageLabel();
    suppressScrollUntil = Date.now() + 400;
    const first = sheets[target - 1]?.querySelector<HTMLElement>('[data-off]');
    const stamp = first ? parseOffsetAttr(first.dataset.off) : null;
    options.onNavigate?.({ page: target, offset: stamp?.start });
  }

  /**
   * Rebuild the thumbnail rail: one shell per sheet, each filled from the
   * real page when it scrolls into view — the same laziness the PDF view
   * gives its rasterised pages, so a long book does not pay for miniatures
   * nobody looks at. Shells are only built while the rail is open.
   */
  function rebuildThumbnails(): void {
    if (!thumbnails || thumbnails.hidden) return;
    thumbnails.replaceChildren();
    thumbObserver?.disconnect();
    thumbObserver = null;
    pageSheets().forEach((_, index) => {
      const page = index + 1;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'docview__thumbnail docview__thumbnail--sheet';
      button.dataset.page = String(page);
      button.setAttribute('aria-label', `Go to page ${page}`);
      if (page === activePageState) button.setAttribute('aria-current', 'page');
      button.innerHTML = `<span class="docview__thumbnail-page">${page}</span>`
        + '<span class="docview__thumbnail-preview"></span>';
      thumbnails.appendChild(button);
    });
    const shells = Array.from(
      thumbnails.querySelectorAll<HTMLButtonElement>('.docview__thumbnail'));
    if (typeof IntersectionObserver === 'undefined') {
      shells.forEach(button => fillThumbnail(button, Number(button.dataset.page)));
      return;
    }
    thumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const button = entry.target as HTMLButtonElement;
        thumbObserver?.unobserve(button);
        fillThumbnail(button, Number(button.dataset.page));
      }
    }, { root: thumbnails, rootMargin: '160px' });
    shells.forEach(button => thumbObserver!.observe(button));
  }

  /**
   * Clone the sheet into its thumbnail and scale it down: a real miniature
   * of the page's own text and headings rather than a placeholder box.
   */
  function fillThumbnail(button: HTMLButtonElement, page: number): void {
    const sheet = pageSheets()[page - 1];
    const preview = button.querySelector<HTMLElement>('.docview__thumbnail-preview');
    if (!sheet || !preview) return;
    const width = sheet.offsetWidth;
    const clone = sheet.cloneNode(true) as HTMLElement;
    clone.style.width = `${width}px`;
    // The miniature reuses the document's own block styles and type size,
    // so it carries the article's class even though it leaves the article.
    const scaler = document.createElement('span');
    scaler.className = 'dochtml docview__thumbnail-scale';
    scaler.style.width = `${width}px`;
    scaler.style.fontSize = article.style.fontSize;
    scaler.appendChild(clone);
    preview.replaceChildren(scaler);
    if (width > 0 && preview.clientWidth > 0) {
      scaler.style.transform = `scale(${preview.clientWidth / width})`;
    }
  }

  /**
   * Re-pack the sheets after something changed the text flow (type size,
   * font family), keeping the block the reader was looking at in view.
   */
  function relayoutPages(): void {
    if (!pagination) return;
    const top = pageScroller.getBoundingClientRect().top;
    let anchor: HTMLElement | null = null;
    for (const item of stamped) {
      if (item.el.getBoundingClientRect().bottom > top) {
        anchor = item.el;
        break;
      }
    }
    pagination.layout();
    anchor?.scrollIntoView?.({ block: 'start' });
    updatePageLabel();
  }

  /**
   * Article-relative boxes covering `[start, end)`.
   *
   * getClientRects is missing on some engines' Range (and in jsdom);
   * without geometry a highlight degrades to the block marker.
   */
  function rangeRects(start: number, end: number): Array<{
    left: number;
    top: number;
    width: number;
    height: number;
  }> {
    const out: Array<{ left: number; top: number; width: number; height: number }> = [];
    const articleBox = article.getBoundingClientRect();
    for (const hit of overlappingRanges(stamped, start, end)) {
      const from = locate(hit.el, Math.max(start, hit.start) - hit.start);
      const to = locate(hit.el, Math.min(end, hit.end) - hit.start);
      if (!from || !to) continue;
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      const rects = typeof range.getClientRects === 'function'
        ? Array.from(range.getClientRects())
        : [];
      for (const rect of rects) {
        if (!rect.width || !rect.height) continue;
        out.push({
          left: rect.left - articleBox.left,
          top: rect.top - articleBox.top,
          width: rect.width,
          height: rect.height,
        });
      }
    }
    return out;
  }

  function boxRange(start: number, end: number, className: string): HTMLElement[] {
    return rangeRects(start, end).map(rect => {
      const box = document.createElement('div');
      box.className = className;
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      return box;
    });
  }

  /** Rebuild the annotation / highlight-all boxes without disturbing the live one. */
  function repaintPersistent(): void {
    for (const box of persistentBoxes) box.remove();
    persistentBoxes = [
      ...allMatchRanges.flatMap(match => boxRange(match.start, match.end, 'dochtml__hl dochtml__hl--all')),
      ...annotations.flatMap(annotation =>
        boxRange(annotation.start, annotation.end, `dochtml__hl dochtml__hl--${annotation.color}`)),
    ];
    overlay.append(...persistentBoxes);
  }

  function highlightRange(
    start: number,
    end: number,
    context?: { start: number; end: number },
  ): void {
    if (destroyed || !(end > start)) return;
    clear();
    const paintStart = context ? Math.min(start, context.start) : start;
    const paintEnd = context ? Math.max(end, context.end) : end;
    const hits = overlappingRanges(stamped, paintStart, paintEnd);
    if (!hits.length) return;
    for (const hit of hits) {
      hit.el.classList.add('dochtml-active');
      if (virtual) hit.el.style.contentVisibility = 'visible';
      active.push(hit.el);
    }
    // Karaoke repaints every word, so scrolling and navigation reports only
    // happen when the spoken word crosses into another block — otherwise the
    // page lurches after every syllable.
    const anchorEl = hits[0].el;
    if (anchorEl !== lastScrolledEl) {
      lastScrolledEl = anchorEl;
      anchorEl.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      options.onNavigate?.({ offset: start, scale: fontScale });
    }
    for (const box of [
      ...(context ? boxRange(context.start, context.end, 'dochtml__hl dochtml__hl--context') : []),
      ...boxRange(start, end, 'dochtml__hl'),
    ]) {
      overlay.appendChild(box);
    }
    const selected = sections.findIndex(section => start >= section.start && start < section.end);
    if (selected >= 0) {
      sectionIndex = selected;
      if (sectionSelect) sectionSelect.value = String(selected);
      updateActiveTab();
    }
    const outlineAt = outlineIndexForOffset(outline, start);
    if (outlineAt >= 0) markOutlineCurrent(outlinePanel, outlineAt);
  }

  function applyFontScale(next: number, notify = true): void {
    fontScale = Math.min(1.8, Math.max(0.75, next));
    article.style.fontSize = `${fontScale}rem`;
    zoomReadout.textContent = `${Math.round(fontScale * 100)}%`;
    relayoutPages();
    if (notify) options.onNavigate?.({ scale: fontScale });
  }

  function applyTheme(next: DocumentTheme, notify = true): void {
    themeState = next;
    host.dataset.docTheme = next;
    themeButton.textContent = THEME_LABELS[next];
    themeButton.setAttribute('aria-label', `Reading theme: ${THEME_LABELS[next]}. Click to change.`);
    if (notify) options.onNavigate?.({ theme: next });
  }

  content.addEventListener('click', event => {
    const offset = options.onPick ? offsetAtPoint(event.clientX, event.clientY) : null;
    if (offset !== null) options.onPick?.(offset);
  }, { signal });

  host.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-role]');
    if (!button) return;
    const role = button.dataset.role;
    if (role === 'page-prev' || role === 'page-next') {
      goToSheet(activePageState + (role === 'page-next' ? 1 : -1));
    } else if (role === 'toggle-thumbnails') {
      if (!thumbnails) return;
      thumbnails.hidden = !thumbnails.hidden;
      button.setAttribute('aria-expanded', String(!thumbnails.hidden));
      if (thumbnails.hidden) {
        thumbObserver?.disconnect();
        thumbObserver = null;
        thumbnails.replaceChildren();
      } else {
        rebuildThumbnails();
      }
    } else if (role === 'section-prev' || role === 'section-next') {
      if (!sections.length) return;
      const direction = role === 'section-next' ? 1 : -1;
      sectionIndex = (sectionIndex + direction + sections.length) % sections.length;
      goToOffset(sections[sectionIndex].start);
    } else if (role === 'font-up') {
      applyFontScale(fontScale + 0.1);
    } else if (role === 'font-down') {
      applyFontScale(fontScale - 0.1);
    } else if (role === 'font-family') {
      fontFamilyState = FONT_FAMILY_ORDER[(FONT_FAMILY_ORDER.indexOf(fontFamilyState) + 1) % FONT_FAMILY_ORDER.length];
      applyLayout();
    } else if (role === 'theme') {
      applyTheme(THEME_ORDER[(THEME_ORDER.indexOf(themeState) + 1) % THEME_ORDER.length]);
    } else if (role === 'toggle-outline') {
      outlinePanel.hidden = !outlinePanel.hidden;
      target2Expanded(button, !outlinePanel.hidden);
      if (!outlinePanel.hidden) outlinePanel.querySelector<HTMLButtonElement>('.docview__outline-item')?.focus();
    } else if (role === 'toggle-overview') {
      overviewPanel.hidden = !overviewPanel.hidden;
      target2Expanded(button, !overviewPanel.hidden);
      if (!overviewPanel.hidden) renderOverview();
    } else if (role === 'search-prev') {
      search?.jump(-1);
    } else if (role === 'search-next') {
      search?.jump(1);
    } else if (role === 'search-case') {
      search?.toggleCase();
    } else if (role === 'search-word') {
      search?.toggleWholeWord();
    } else if (role === 'search-regex') {
      search?.toggleRegex();
    } else if (role === 'search-highlight') {
      search?.toggleHighlightAll();
    } else if (role === 'search-scope') {
      search?.toggleScope();
    }
  }, { signal });

  tabsRow?.addEventListener('click', event => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[data-section-index]');
    if (!tab) return;
    goToOffset(sections[Number(tab.dataset.sectionIndex)]?.start ?? 0);
  }, { signal });

  thumbnails?.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.docview__thumbnail');
    if (target) goToSheet(Number(target.dataset.page));
  }, { signal });

  overviewPanel.addEventListener('click', event => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-section-index]');
    if (!card) return;
    goToOffset(sections[Number(card.dataset.sectionIndex)]?.start ?? 0);
    overviewPanel.hidden = true;
    const toggle = host.querySelector<HTMLButtonElement>('[data-role="toggle-overview"]');
    if (toggle) target2Expanded(toggle, false);
  }, { signal });
  sectionSelect?.addEventListener('change', () => goToOffset(sections[Number(sectionSelect.value)]?.start ?? 0), { signal });

  const sectionObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    const first = entries.filter(entry => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!first) return;
    const offset = Number((first.target as HTMLElement).dataset.sectionStart);
    const index = sections.findIndex(section => section.start <= offset && section.end > offset);
    if (index < 0 || index === sectionIndex) return;
    sectionIndex = index;
    if (sectionSelect) sectionSelect.value = String(index);
    updateActiveTab();
    const outlineAt = outlineIndexForOffset(outline, offset);
    if (outlineAt >= 0) markOutlineCurrent(outlinePanel, outlineAt);
    options.onNavigate?.({ offset, scale: fontScale });
  }, { root: pageScroller, rootMargin: '0px 0px -75% 0px' });
  sections.forEach(section => {
    const target = stamped.find(item => item.start <= section.start && item.end > section.start)?.el;
    if (target) {
      target.dataset.sectionStart = String(section.start);
      sectionObserver?.observe(target);
    }
  });

  // Page tracking: the sheet nearest the middle of the scroller is the page
  // the reader is on, the same contract the PDF view reports.
  pageScroller.addEventListener('scroll', () => {
    if (!paginated || destroyed) return;
    if (Date.now() < suppressScrollUntil) return;
    const sheets = pageSheets();
    if (!sheets.length) return;
    const mid = pageScroller.getBoundingClientRect().top + pageScroller.clientHeight / 2;
    let nearest = activePageState;
    let best = Infinity;
    sheets.forEach((sheet, index) => {
      const rect = sheet.getBoundingClientRect();
      const delta = Math.abs(rect.top + rect.height / 2 - mid);
      if (delta < best) {
        best = delta;
        nearest = index + 1;
      }
    });
    if (nearest === activePageState) return;
    activePageState = nearest;
    updatePageLabel();
    const first = sheets[nearest - 1]?.querySelector<HTMLElement>('[data-off]');
    const stamp = first ? parseOffsetAttr(first.dataset.off) : null;
    options.onNavigate?.({ page: nearest, offset: stamp?.start });
  }, { passive: true, signal });

  renderOutlineList(outlinePanel, outline, item => {
    if (item.start !== undefined) goToOffset(item.start);
  });
  applyLayout(false);
  if (paginated) {
    pagination = paginateIntoPages(content, {
      onPageCount: () => {
        // A repack may have cut paragraphs: refresh the offset bookkeeping
        // and drop boxes and block markers positioned against the old
        // layout. Annotations repaint here; the live reading cursor is
        // repainted by the next highlight tick.
        stamped = collectStamped();
        clear();
        repaintPersistent();
        updatePageLabel();
        rebuildThumbnails();
      },
    });
  }
  updatePageLabel();

  return {
    get pageCount() { return paginated ? Math.max(1, pagination?.pageCount ?? 1) : 0; },
    get activePage() { return paginated ? activePageState : 0; },
    get scale() { return fontScale; },
    get theme() { return themeState; },
    get fontFamily() { return fontFamilyState; },
    showPage(page) { if (paginated) goToSheet(page); else pageScroller.scrollTo({ top: 0 }); },
    goToOffset(offset) { goToOffset(offset, false); },
    highlight: highlightRange,
    nextPage() { stepPage(1); },
    prevPage() { stepPage(-1); },
    zoomIn() { applyFontScale(fontScale + 0.1); },
    zoomOut() { applyFontScale(fontScale - 0.1); },
    cycleTheme() {
      applyTheme(THEME_ORDER[(THEME_ORDER.indexOf(themeState) + 1) % THEME_ORDER.length]);
    },
    getOutline: () => outline.slice(),
    setAnnotations(next) {
      annotations = next.slice();
      repaintPersistent();
    },
    search: search ? {
      focus: () => search.focus(),
      next: () => search.jump(1),
      prev: () => search.jump(-1),
      toggleHighlightAll: () => search.toggleHighlightAll(),
    } : undefined,
    destroy() {
      destroyed = true;
      search?.dispose();
      pagination?.destroy();
      pagination = null;
      thumbObserver?.disconnect();
      thumbObserver = null;
      sectionObserver?.disconnect();
      eventController.abort();
      clear();
      host.replaceChildren();
      host.classList.remove('docview', 'docview--html', 'docview--pages');
    },
  };
}

// ─── Outline plumbing shared by both views ────────────────────────

interface PdfOutlineNode {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineNode[];
}

interface PdfOutlineSource {
  getOutline(): Promise<PdfOutlineNode[] | null>;
  getDestination(dest: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

/**
 * Resolve a PDF's embedded outline to page numbers.
 *
 * Every step can fail on a malformed file — a dangling destination, a ref
 * pdfjs cannot resolve — so items that cannot be jumped to are dropped and a
 * broken outline degrades to no panel instead of a broken view.
 */
async function resolvePdfOutline(pdf: PdfOutlineSource): Promise<OutlineItem[]> {
  let raw: PdfOutlineNode[] | null;
  try {
    raw = await pdf.getOutline();
  } catch {
    return [];
  }
  if (!raw?.length) return [];
  const out: OutlineItem[] = [];
  const walk = async (nodes: PdfOutlineNode[], level: number, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const node of nodes) {
      let page: number | undefined;
      try {
        const dest = typeof node.dest === 'string'
          ? await pdf.getDestination(node.dest)
          : (node.dest as unknown[] | undefined);
        if (Array.isArray(dest) && dest.length) {
          const index = await pdf.getPageIndex(dest[0]);
          if (Number.isInteger(index)) page = index + 1;
        }
      } catch {
        page = undefined;
      }
      const title = (node.title ?? '').trim();
      if (title && page !== undefined) out.push({ title, level, page });
      if (node.items?.length) await walk(node.items, level + 1, depth + 1);
    }
  };
  await walk(raw, 0, 0);
  return out;
}

function renderOutlineList(
  panel: HTMLElement,
  outline: OutlineItem[],
  onPick: (item: OutlineItem, index: number) => void,
): void {
  panel.replaceChildren();
  outline.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'docview__outline-item';
    button.dataset.outlineIndex = String(index);
    button.style.marginLeft = `${Math.min(6, item.level) * 12}px`;
    button.textContent = item.title;
    if (item.page) {
      const page = document.createElement('span');
      page.className = 'docview__outline-page';
      page.textContent = String(item.page);
      button.appendChild(page);
    }
    button.addEventListener('click', () => onPick(item, index));
    panel.appendChild(button);
  });
}

function target2Expanded(button: HTMLElement, expanded: boolean): void {
  button.setAttribute('aria-expanded', String(expanded));
}

function markOutlineCurrent(panel: HTMLElement, index: number): void {
  panel.querySelectorAll<HTMLButtonElement>('.docview__outline-item').forEach(button => {
    button.setAttribute('aria-current', Number(button.dataset.outlineIndex) === index ? 'true' : 'false');
  });
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function firstPageOf(anchors: TextAnchor[], span: { start: number; end: number }): number {
  if (!anchors.length) return 0;
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].start >= span.start) hi = mid - 1;
    else lo = mid + 1;
  }
  const anchor = anchors[Math.min(lo, anchors.length - 1)];
  return anchor.end > span.start ? anchor.page : 0;
}
