/**
 * Reading regions wiring: a toolbar control, a panel listing the page's
 * regions in read order, and a draw layer over the rendered pages.
 *
 * The interaction model is deliberately the same one the area-read capture
 * uses (src/ui/region-ocr.ts): a button opens a fixed layer over the page
 * scroller, a drag draws a box, Escape cancels, and the status line is a live
 * region. A second, different way of dragging over a page would be two
 * gestures for one idea, and the reader would have to remember which was
 * which.
 *
 * The layer is a sibling of the pages rather than ink drawn into them. The
 * viewer replaces a page's canvas on every zoom and page turn, so anything
 * inside it disappears at the next render; an overlay that re-measures the
 * pages can outlive that, and it keeps this feature out of the viewer's
 * rendering code.
 *
 * Why the read order has to touch the document text: the reader speaks
 * `state.extractedDocument.text`. There is no second speech path for regions,
 * so applying a read order means replacing that text with the planned one and
 * handing the view the matching anchors back. The original is kept here and
 * restored the moment the last region is removed.
 */

import type { AppState } from '../app-state';
import type { TextAnchor } from '../document-types';
import {
  REGION_KINDS,
  REGION_KIND_LABELS,
  buildReadingPlan,
  clampRect,
  createRegion,
  isRegionUsable,
  loadReadingRegions,
  moveRegion,
  pageAtPoint,
  pageSizeOf,
  pointToPagePoint,
  readingRegionsKeyForDocumentKey,
  rectFromPoints,
  regionClientBox,
  regionsForPage,
  removeRegion,
  reorderRegion,
  saveReadingRegions,
  setRegionKind,
  type Point,
  type ReadingPageBox,
  type ReadingRegion,
  type Rect,
  type RegionKind,
} from '../reading-regions';
import { findDocumentView, type DocumentView } from './document-view';

const BUTTON_ID = 'reading-regions-btn';
const STATUS_ID = 'reading-regions-status';
const PANEL_ID = 'reading-regions-panel';
const LIST_ID = 'reading-regions-list';
const PAGE_SELECT_ID = 'reading-regions-page';
const KIND_SELECT_ID = 'reading-regions-kind';
const HOST_ID = 'document-view';

/**
 * Dispatched by `document-panel` when a document opens (and again, debounced,
 * as its reading position is saved). `detail.key` is the file-identity key the
 * progress record uses, which is exactly the identity regions belong to.
 */
const READER_DOCUMENT_EVENT = 'yapper:reader-document';

/** How much of the page one arrow-key step moves or resizes a box. */
const KEYBOARD_STEP = 0.02;

interface ReaderDocumentDetail {
  key: string | null;
  name: string;
  offset: number;
  text: string;
}

export interface ReadingRegionsOptions {
  /** App state, so a read-order change reaches the reader. */
  state?: AppState | null;
  /** Element holding the document view. Defaults to `#document-view`. */
  host?: HTMLElement | null;
  button?: HTMLButtonElement | null;
  status?: HTMLElement | null;
  panel?: HTMLElement | null;
  list?: HTMLElement | null;
  pageSelect?: HTMLSelectElement | null;
  kindSelect?: HTMLSelectElement | null;
  /** Where the draw layer is mounted. Defaults to `document.body`. */
  layer?: HTMLElement | null;
  /** Overrides the rendered-page geometry (tests). */
  pages?: () => ReadingPageBox[];
  /** Overrides the view lookup (tests). */
  view?: () => DocumentView | null;
}

export interface ReadingRegionsHandle {
  destroy(): void;
}

/**
 * Feature-local styles, injected instead of added to src/style.css.
 *
 * They travel with the feature that owns them, and keep this work out of a
 * shared stylesheet several features are editing at once.
 */
function ensureStyles(): void {
  if (document.querySelector('style[data-reading-regions]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-reading-regions', '');
  style.textContent = `
.reading-regions { margin: 6px 0 10px; }
.reading-regions__bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.reading-regions__status {
  flex: 0 1 auto; min-width: 0; max-width: 100%;
  font-size: 0.78rem; line-height: 1.3; color: var(--text-muted, #5b5b6b);
}
.reading-regions__status:empty { display: none; }
.reading-regions__panel {
  margin-top: 8px; padding: 10px 12px;
  border: 1px solid var(--border, #d8d8e0); border-radius: 10px;
  background: var(--bg-surface, rgba(127, 127, 140, 0.06));
}
.reading-regions__head, .reading-regions__tools {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.reading-regions__label { font-size: 0.78rem; color: var(--text-muted, #5b5b6b); }
.reading-regions__page, .reading-regions__kind, .reading-regions__row-kind {
  font: inherit; font-size: 0.8rem; padding: 3px 6px;
  border: 1px solid var(--border, #d8d8e0); border-radius: 6px;
  background: var(--bg, #fff); color: inherit;
}
.reading-regions__hint {
  margin: 6px 0; font-size: 0.78rem; line-height: 1.35; color: var(--text-muted, #5b5b6b);
}
.reading-regions__hint kbd {
  padding: 1px 5px; border: 1px solid var(--border, #d8d8e0); border-radius: 4px; font: inherit;
}
.reading-regions__list {
  list-style: none; margin: 6px 0 0; padding: 0;
  display: flex; flex-direction: column; gap: 6px;
}
.reading-regions__empty { font-size: 0.8rem; color: var(--text-muted, #5b5b6b); }
.reading-regions__item {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 6px 8px; border: 1px solid var(--border, #d8d8e0); border-radius: 8px;
  background: var(--bg, #fff);
}
.reading-regions__item--dragging { opacity: 0.45; }
.reading-regions__item[data-kind="skip"] { border-style: dashed; }
.reading-regions__item[data-kind="figure"] { border-style: dotted; }
.reading-regions__handle {
  cursor: grab; color: var(--text-muted, #5b5b6b); font-size: 0.9rem; letter-spacing: -2px;
}
.reading-regions__num {
  min-width: 1.4em; font-weight: 700; font-variant-numeric: tabular-nums;
}
.reading-regions__kind-label { font-size: 0.8rem; }
.reading-regions__row-btn {
  font: inherit; font-size: 0.78rem; padding: 2px 7px; cursor: pointer;
  border: 1px solid var(--border, #d8d8e0); border-radius: 6px;
  background: var(--bg-elevated, #f6f6f9); color: inherit;
}
.reading-regions__row-btn:disabled { opacity: 0.4; cursor: default; }
.reading-regions__row-btn--delete { color: var(--danger, #b91c1c); }
.reading-regions__layer {
  position: fixed; z-index: 60; box-sizing: border-box;
  cursor: crosshair; user-select: none; -webkit-user-select: none; touch-action: none;
  background: rgba(10, 10, 20, 0.08);
  outline: 2px solid var(--accent, #6366f1); outline-offset: -2px;
}
.reading-regions__layer:focus-visible { outline-offset: -4px; }
.reading-regions__hintbar {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  z-index: 2; margin: 0; max-width: min(680px, calc(100% - 150px));
  padding: 7px 14px; border-radius: 999px;
  background: rgba(8, 8, 16, 0.88); color: #fff;
  font-size: 0.82rem; line-height: 1.35; text-align: center; pointer-events: none;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
}
.reading-regions__hintbar kbd {
  padding: 1px 5px; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 4px; font: inherit;
}
.reading-regions__exit {
  position: absolute; top: 10px; right: 10px; z-index: 2;
  padding: 6px 12px; border: 1px solid rgba(255, 255, 255, 0.45); border-radius: 999px;
  background: rgba(8, 8, 16, 0.88); color: #fff; font: inherit; font-size: 0.8rem;
  font-weight: 600; cursor: pointer;
}
.reading-regions__exit:hover { background: rgba(30, 30, 50, 0.95); }
.reading-regions__box {
  position: absolute; box-sizing: border-box; pointer-events: none;
  border: 2px solid var(--accent, #6366f1); border-radius: 3px;
  background: rgba(99, 102, 241, 0.14);
}
.reading-regions__box[data-kind="side"] {
  border-color: #0ea5e9; background: rgba(14, 165, 233, 0.14);
}
.reading-regions__box[data-kind="skip"] {
  border-color: #ef4444; border-style: dashed; background: rgba(239, 68, 68, 0.12);
}
.reading-regions__box[data-kind="figure"] {
  border-color: #f59e0b; border-style: dotted; background: rgba(245, 158, 11, 0.12);
}
.reading-regions__box-label {
  position: absolute; top: -9px; left: -2px;
  padding: 2px 5px; border-radius: 4px;
  background: #111827; color: #fff;
  font: 600 10px/1.2 system-ui, sans-serif; white-space: nowrap;
}
.reading-regions__draft {
  position: absolute; display: none; box-sizing: border-box; pointer-events: none;
  border: 2px dashed var(--accent, #6366f1); background: rgba(99, 102, 241, 0.18);
}
.reading-regions__draft[data-keyboard="true"] { border-style: solid; }
`;
  document.head.appendChild(style);
}

/**
 * Bind the regions control. Called once at boot; the handle exists for
 * teardown (tests). Everything it needs about the document arrives through
 * the reader's own document event, so no other module has to know it exists.
 */
export function bindReadingRegions(options: ReadingRegionsOptions = {}): ReadingRegionsHandle {
  ensureStyles();

  const state = options.state ?? null;
  const button = options.button ?? document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  const status = options.status ?? document.getElementById(STATUS_ID);
  const panel = options.panel ?? document.getElementById(PANEL_ID);
  const list = options.list ?? document.getElementById(LIST_ID);
  const pageSelect = options.pageSelect ?? document.getElementById(PAGE_SELECT_ID) as HTMLSelectElement | null;
  const kindSelect = options.kindSelect ?? document.getElementById(KIND_SELECT_ID) as HTMLSelectElement | null;

  if (status) {
    if (!status.hasAttribute('aria-live')) status.setAttribute('aria-live', 'polite');
    if (!status.hasAttribute('role')) status.setAttribute('role', 'status');
  }

  const host = (): HTMLElement | null => options.host ?? document.getElementById(HOST_ID);
  const view = (): DocumentView | null =>
    (options.view ?? (() => findDocumentView(host())))();

  let regions: ReadingRegion[] = [];
  /**
   * Bumped on every edit. Used to decide whether the view already has the
   * anchors for this read order — cheaply, since a document can mutate its DOM
   * hundreds of times a minute while it is being read.
   */
  let revision = 0;
  let syncedRevision = -1;
  let syncedView: DocumentView | null = null;
  let hostObserver: MutationObserver | null = null;
  let documentKey: string | null = null;
  /** The document text as it was before a read order replaced it. */
  let baseline: { key: string; text: string; anchors: TextAnchor[] } | null = null;
  /** Set once a plan has been written into the document, null when not. */
  let appliedKey: string | null = null;

  let open = false;
  let currentPage = 1;
  let newKind: RegionKind = 'main';
  let overlay: HTMLDivElement | null = null;
  let layerHost: HTMLElement | null = null;
  let dragStart: Point | null = null;
  let dragPage: ReadingPageBox | null = null;
  let keyboardRect: Rect | null = null;
  let draggingId: string | null = null;
  let destroyed = false;
  let resizeObserver: ResizeObserver | null = null;

  const announce = (message: string): void => {
    if (status) status.textContent = message;
  };

  /** Replace the region list; every edit goes through here so it is noticed. */
  function commitRegions(next: ReadingRegion[]): void {
    regions = next;
    revision += 1;
  }

  // ── Pages and the document's identity ─────────────────────────

  function pages(): ReadingPageBox[] {
    if (options.pages) return options.pages();
    return view()?.pageSurfaces?.() ?? [];
  }

  function pageBox(page: number): ReadingPageBox | null {
    return pages().find(box => box.page === page) ?? null;
  }

  /**
   * The document's text as it was at open, plus the anchors those offsets
   * belong to. Captured once and kept: every recomputation must start from
   * the original, never from a text this feature already reordered.
   */
  function ensureBaseline(): { key: string; text: string; anchors: TextAnchor[] } | null {
    const doc = state?.extractedDocument;
    if (!doc || !documentKey) return null;
    if (!baseline || baseline.key !== documentKey) {
      const anchors = view()?.textAnchors?.() ?? doc.anchors ?? [];
      baseline = { key: documentKey, text: doc.text, anchors: [...anchors] };
    } else if (baseline.anchors.length === 0) {
      // A scanned page can gain anchors after the document opens (search runs
      // OCR on demand). Adopt them once, before anything is reordered.
      const live = view()?.textAnchors?.() ?? [];
      if (live.length) {
        baseline = { ...baseline, anchors: live };
        // New anchors mean the plan can do something it could not before.
        revision += 1;
      }
    }
    return baseline;
  }

  /**
   * Write the current regions' read order into the document the reader
   * speaks, and hand the view anchors rebased onto that text. With no
   * regions, put the original back — untouched, byte for byte.
   */
  function applyPlan(): void {
    const doc = state?.extractedDocument;
    const base = ensureBaseline();
    if (!doc || !base) return;
    const currentView = view();

    if (!regions.length) {
      if (appliedKey === base.key) {
        doc.text = base.text;
        doc.anchors = [...base.anchors];
        currentView?.setTextAnchors?.([...base.anchors]);
        appliedKey = null;
      }
      syncedRevision = revision;
      syncedView = currentView;
      return;
    }

    if (syncedRevision === revision && syncedView === currentView) return;

    const plan = buildReadingPlan(base.text, base.anchors, regions);
    doc.text = plan.text;
    doc.anchors = plan.anchors;
    currentView?.setTextAnchors?.(plan.anchors);
    appliedKey = base.key;
    syncedRevision = revision;
    syncedView = currentView;
  }

  function persist(): void {
    saveReadingRegions(documentKey, regions);
  }

  function restore(): void {
    const doc = state?.extractedDocument;
    if (!doc || !appliedKey || !baseline || baseline.key !== appliedKey) return;
    doc.text = baseline.text;
    doc.anchors = [...baseline.anchors];
    view()?.setTextAnchors?.([...baseline.anchors]);
    appliedKey = null;
  }

  // ── Panel state ───────────────────────────────────────────────

  function currentPageRegions(): ReadingRegion[] {
    return regionsForPage(regions, currentPage);
  }

  function choosePage(): void {
    const boxes = pages();
    if (!boxes.length) {
      currentPage = 1;
      return;
    }
    if (boxes.some(box => box.page === currentPage)) return;
    const active = view()?.activePage ?? 0;
    currentPage = boxes.some(box => box.page === active) ? active : boxes[0].page;
  }

  function setButtonState(): void {
    if (!button) return;
    // Enabled as soon as a document is open, not as soon as a page is painted:
    // mounting a PDF is asynchronous and its pages arrive after the document
    // event, so a disabled button would stay dead until the user opened
    // another file. The click explains itself when there is nothing to draw on.
    button.disabled = !documentKey;
    button.setAttribute('aria-pressed', String(open));
    button.setAttribute('aria-expanded', String(open));
    button.title = 'Draw boxes over a page to choose what is read, skip a sidebar or figure, and set the read order';
  }

  function renderPageSelect(): void {
    if (!pageSelect) return;
    const boxes = pages();
    pageSelect.replaceChildren();
    if (!boxes.length) {
      const option = document.createElement('option');
      option.textContent = 'No pages';
      option.value = '';
      pageSelect.appendChild(option);
      pageSelect.disabled = true;
      return;
    }
    pageSelect.disabled = false;
    for (const box of boxes) {
      const option = document.createElement('option');
      option.value = String(box.page);
      option.textContent = `Page ${box.page}`;
      pageSelect.appendChild(option);
    }
    pageSelect.value = String(currentPage);
  }

  function kindSelectValue(): RegionKind {
    const value = kindSelect?.value;
    return REGION_KINDS.includes(value as RegionKind) ? value as RegionKind : 'main';
  }

  function renderKindSelect(): void {
    if (!kindSelect || kindSelect.options.length) return;
    for (const kind of REGION_KINDS) {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = REGION_KIND_LABELS[kind];
      kindSelect.appendChild(option);
    }
    kindSelect.value = newKind;
  }

  function rowButton(label: string, action: string, extraClass = ''): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `reading-regions__row-btn${extraClass}`;
    element.dataset.action = action;
    element.textContent = label;
    return element;
  }

  function renderList(): void {
    if (!list) return;
    // Re-rendering replaces the row the user is standing on. Remember which
    // control had focus so a keyboard user does not land back on the page
    // after every move or delete.
    const previous = document.activeElement as HTMLElement | null;
    const previousId = previous?.closest<HTMLElement>('[data-region-id]')?.dataset.regionId ?? null;
    const previousAction = previous?.dataset.action ?? null;

    const pageRegions = currentPageRegions();
    list.replaceChildren();
    if (!pageRegions.length) {
      const empty = document.createElement('li');
      empty.className = 'reading-regions__empty';
      empty.textContent = `No regions on page ${currentPage}. Draw a box over part of the page.`;
      list.appendChild(empty);
      return;
    }
    pageRegions.forEach((region, index) => {
      const item = document.createElement('li');
      item.className = 'reading-regions__item';
      item.dataset.kind = region.kind;
      item.dataset.regionId = region.id;
      item.setAttribute('draggable', 'true');

      const handle = document.createElement('span');
      handle.className = 'reading-regions__handle';
      handle.setAttribute('aria-hidden', 'true');
      handle.textContent = '⠿';

      const num = document.createElement('span');
      num.className = 'reading-regions__num';
      num.textContent = String(index + 1);

      const label = document.createElement('span');
      label.className = 'reading-regions__kind-label';
      label.textContent = REGION_KIND_LABELS[region.kind];

      const kind = document.createElement('select');
      kind.className = 'reading-regions__row-kind';
      kind.dataset.action = 'kind';
      kind.setAttribute('aria-label', `Kind of region ${index + 1}`);
      for (const value of REGION_KINDS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = REGION_KIND_LABELS[value];
        kind.appendChild(option);
      }
      kind.value = region.kind;
      kind.addEventListener('change', () => {
        const next = REGION_KINDS.includes(kind.value as RegionKind)
          ? kind.value as RegionKind
          : region.kind;
        commitRegions(setRegionKind(regions, region.id, next));
        changed(`${REGION_KIND_LABELS[next]} — region ${index + 1}.`);
      });

      const up = rowButton('↑', 'up');
      up.setAttribute('aria-label', `Read region ${index + 1} earlier`);
      up.disabled = index === 0;
      up.addEventListener('click', () => {
        commitRegions(moveRegion(regions, region.id, -1));
        changed(`Region ${index + 1} moved earlier.`);
      });

      const down = rowButton('↓', 'down');
      down.setAttribute('aria-label', `Read region ${index + 1} later`);
      down.disabled = index === pageRegions.length - 1;
      down.addEventListener('click', () => {
        commitRegions(moveRegion(regions, region.id, 1));
        changed(`Region ${index + 1} moved later.`);
      });

      const remove = rowButton('Delete', 'delete', ' reading-regions__row-btn--delete');
      remove.setAttribute('aria-label', `Delete region ${index + 1}`);
      remove.addEventListener('click', () => {
        commitRegions(removeRegion(regions, region.id));
        changed(`Region ${index + 1} deleted.`);
      });

      item.append(handle, num, label, kind, up, down, remove);
      item.addEventListener('keydown', event => {
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        if ((event.target as HTMLElement | null)?.tagName === 'SELECT') return;
        event.preventDefault();
        commitRegions(removeRegion(regions, region.id));
        changed(`Region ${index + 1} deleted.`);
      });
      list.appendChild(item);
    });

    if (previousId && previousAction) {
      const restored = list.querySelector<HTMLElement>(
        `[data-region-id="${previousId}"] [data-action="${previousAction}"]`);
      if (restored && !(restored as HTMLButtonElement).disabled) {
        restored.focus();
      } else {
        // The row is gone (deleted) or cannot take focus any more: the list
        // itself becomes the focus holder rather than the document body.
        list.focus();
      }
    }
  }

  /** One place to save, re-apply and repaint after any edit. */
  function changed(message: string): void {
    persist();
    applyPlan();
    renderAll();
    announce(message);
  }

  function renderAll(): void {
    choosePage();
    renderPageSelect();
    renderList();
    paint();
  }

  // ── Overlay ───────────────────────────────────────────────────

  function scroller(): HTMLElement | null {
    return host()?.querySelector<HTMLElement>('.docview__pages') ?? null;
  }

  function paint(): void {
    if (!overlay) return;
    overlay.querySelectorAll<HTMLElement>('.reading-regions__box').forEach(box => box.remove());
    const place = overlay.getBoundingClientRect();
    const boxes = pages();
    for (const region of regions) {
      const box = boxes.find(candidate => candidate.page === region.page);
      if (!box) continue;
      const client = regionClientBox(region, box);
      const element = document.createElement('div');
      element.className = 'reading-regions__box';
      element.dataset.kind = region.kind;
      element.style.left = `${client.x - place.left}px`;
      element.style.top = `${client.y - place.top}px`;
      element.style.width = `${Math.max(1, client.width)}px`;
      element.style.height = `${Math.max(1, client.height)}px`;
      const label = document.createElement('span');
      label.className = 'reading-regions__box-label';
      const index = regionsForPage(regions, region.page).indexOf(region);
      label.textContent = `${index + 1} ${REGION_KIND_LABELS[region.kind]}`;
      element.appendChild(label);
      overlay.appendChild(element);
    }
    paintDraft(place);
  }

  function paintDraft(place?: DOMRect): void {
    if (!overlay) return;
    const draft = overlay.querySelector<HTMLElement>('.reading-regions__draft');
    if (!draft) return;
    const rect = keyboardRect;
    const box = pageBox(currentPage);
    if (!rect || !box) {
      draft.style.display = 'none';
      return;
    }
    const origin = place ?? overlay.getBoundingClientRect();
    const client = regionClientBox({ ...rect, id: '', page: box.page, kind: newKind }, box);
    draft.style.display = 'block';
    draft.dataset.keyboard = 'true';
    draft.style.left = `${client.x - origin.left}px`;
    draft.style.top = `${client.y - origin.top}px`;
    draft.style.width = `${Math.max(1, client.width)}px`;
    draft.style.height = `${Math.max(1, client.height)}px`;
  }

  function reposition(): void {
    if (!overlay) return;
    const place = scroller();
    if (!place) {
      closePanel('The document view closed.');
      return;
    }
    const box = place.getBoundingClientRect();
    overlay.style.left = `${box.left}px`;
    overlay.style.top = `${box.top}px`;
    overlay.style.width = `${box.width}px`;
    overlay.style.height = `${box.height}px`;
    paint();
  }

  function closePanel(message?: string): void {
    if (!open && !overlay) return;
    open = false;
    keyboardRect = null;
    dragStart = null;
    dragPage = null;
    draggingId = null;
    overlay?.remove();
    overlay = null;
    layerHost?.removeEventListener('scroll', paint);
    layerHost = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    document.removeEventListener('keydown', onEscape, true);
    window.removeEventListener('resize', reposition);
    if (panel) panel.hidden = true;
    setButtonState();
    if (message) announce(message);
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // Capture phase: Escape must close the editor even when the reader's own
    // single-key shortcuts would otherwise claim it.
    event.preventDefault();
    event.stopPropagation();
    closePanel('Reading regions closed.');
  }

  function commitKeyboardRect(): void {
    if (!keyboardRect) return;
    addRegion(currentPage, keyboardRect, 'keyboard');
    keyboardRect = null;
    paint();
  }

  function stepKeyboardRect(key: string, resize: boolean): boolean {
    const box = pageBox(currentPage);
    if (!box) return false;
    const size = pageSizeOf(box);
    const dx = size.width * KEYBOARD_STEP;
    const dy = size.height * KEYBOARD_STEP;
    if (!keyboardRect) {
      keyboardRect = {
        x: size.width * 0.1,
        y: size.height * 0.1,
        width: size.width * 0.3,
        height: Math.max(8, size.height * 0.05),
      };
      return true;
    }
    let { x, y, width, height } = keyboardRect;
    if (resize) {
      if (key === 'ArrowLeft') width -= dx;
      if (key === 'ArrowRight') width += dx;
      if (key === 'ArrowUp') height -= dy;
      if (key === 'ArrowDown') height += dy;
    } else {
      if (key === 'ArrowLeft') x -= dx;
      if (key === 'ArrowRight') x += dx;
      if (key === 'ArrowUp') y -= dy;
      if (key === 'ArrowDown') y += dy;
    }
    width = Math.max(8, width);
    height = Math.max(8, height);
    keyboardRect = clampRect({ x, y, width, height }, size);
    return true;
  }

  function addRegion(page: number, rect: Rect, source: 'pointer' | 'keyboard'): void {
    const box = pageBox(page);
    const sane = box
      ? clampRect(rect, pageSizeOf(box))
      : rect;
    if (!isRegionUsable(sane)) {
      announce('That box is too small to be a region. Draw a larger one, or use the arrow keys to size it.');
      return;
    }
    const kind = kindSelectValue();
    commitRegions(createRegion(regions, page, kind, sane));
    persist();
    applyPlan();
    currentPage = page;
    renderAll();
    const count = currentPageRegions().length;
    const emptyAnchors = (ensureBaseline()?.anchors.length ?? 0) === 0;
    announce(emptyAnchors
      ? `${REGION_KIND_LABELS[kind]} region ${count} added on page ${page}. This document has no recognised text yet, so it will change reading once it does.`
      : `${REGION_KIND_LABELS[kind]} region ${count} added on page ${page}. ${source === 'keyboard' ? 'Arrows move the next box.' : ''}`.trim());
  }

  function openPanel(): void {
    if (open) return;
    if (!documentKey) {
      announce('Open a document first — regions are kept per document.');
      return;
    }
    const boxes = pages();
    if (!boxes.length) {
      announce('Reading regions work on the rendered pages of a PDF. Switch to Document view and try again.');
      return;
    }
    open = true;
    // The view mounts asynchronously after the document event; by the time the
    // panel opens it is there, so this is the moment its anchors can be
    // trusted to be the current plan's.
    applyPlan();
    choosePage();
    renderKindSelect();
    if (panel) panel.hidden = false;

    const place = scroller();
    const layer = document.createElement('div');
    layer.className = 'reading-regions__layer';
    layer.tabIndex = -1;
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-label', 'Draw reading regions');
    layer.setAttribute('aria-describedby', 'reading-regions-layer-hint');
    layer.setAttribute('aria-keyshortcuts', 'Escape Enter ArrowLeft ArrowRight ArrowUp ArrowDown');
    const rect = place?.getBoundingClientRect();
    layer.style.left = `${rect?.left ?? 0}px`;
    layer.style.top = `${rect?.top ?? 0}px`;
    layer.style.width = `${rect?.width || (typeof window === 'undefined' ? 800 : window.innerWidth)}px`;
    layer.style.height = `${rect?.height || (typeof window === 'undefined' ? 600 : window.innerHeight)}px`;
    layer.innerHTML = `
      <p class="reading-regions__hintbar" id="reading-regions-layer-hint">
        Drag a box over the page. Or press an arrow key to start a box, move and resize it,
        then <kbd>Enter</kbd> to add it. <kbd>Esc</kbd> exits.
      </p>
      <button class="reading-regions__exit" type="button" data-role="reading-regions-exit">Close</button>
      <div class="reading-regions__draft" aria-hidden="true"></div>`;

    layer.querySelector<HTMLButtonElement>('[data-role="reading-regions-exit"]')
      ?.addEventListener('click', () => closePanel('Reading regions closed.'));
    layer.addEventListener('pointerdown', onPointerDown);
    layer.addEventListener('pointermove', onPointerMove);
    layer.addEventListener('pointerup', onPointerUp);
    layer.addEventListener('pointercancel', () => {
      dragStart = null;
      dragPage = null;
    });
    layer.addEventListener('keydown', onLayerKeyDown);

    (options.layer ?? document.body).appendChild(layer);
    overlay = layer;
    layerHost = place;
    document.addEventListener('keydown', onEscape, true);
    layerHost?.addEventListener('scroll', paint, { passive: true });
    window.addEventListener('resize', reposition);
    if (typeof ResizeObserver !== 'undefined' && layerHost) {
      resizeObserver = new ResizeObserver(() => reposition());
      layerHost.querySelectorAll<HTMLElement>('.docview__page').forEach(page => resizeObserver?.observe(page));
    }

    renderAll();
    setButtonState();
    layer.focus({ preventScroll: true });
    announce(`Reading regions on. ${regions.length
      ? `${regionsForPage(regions, currentPage).length} region(s) on page ${currentPage}.`
      : 'No regions yet.'} Drag a box, or press an arrow key, then Escape to exit.`);
  }

  function onLayerKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitKeyboardRect();
      return;
    }
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    if (stepKeyboardRect(event.key, event.shiftKey)) {
      paint();
      if (keyboardRect) {
        const box = pageBox(currentPage);
        const size = box ? pageSizeOf(box) : { width: 1, height: 1 };
        announce(
          `Box on page ${currentPage}: ${Math.round((keyboardRect.x / Math.max(1, size.width)) * 100)}% from the left, `
          + `${Math.round((keyboardRect.y / Math.max(1, size.height)) * 100)}% from the top, `
          + `${Math.round((keyboardRect.width / Math.max(1, size.width)) * 100)}% wide, `
          + `${Math.round((keyboardRect.height / Math.max(1, size.height)) * 100)}% high. Enter to add.`,
        );
      }
    }
  }

  function onPointerDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest('button')) return;
    const page = pageAtPoint(pages(), event.clientX, event.clientY);
    if (!page) {
      announce('Drag inside a page. The gap between pages is not part of either.');
      return;
    }
    event.preventDefault();
    dragPage = page;
    dragStart = pointToPagePoint(page, event.clientX, event.clientY);
    keyboardRect = null;
    if (overlay && typeof overlay.setPointerCapture === 'function'
      && typeof (event as PointerEvent).pointerId === 'number') {
      try {
        overlay.setPointerCapture((event as PointerEvent).pointerId);
      } catch {
        // Capture is a convenience; pointerup still arrives inside the layer.
      }
    }
  }

  function onPointerMove(event: MouseEvent): void {
    if (!dragStart || !dragPage) return;
    const current = pointToPagePoint(dragPage, event.clientX, event.clientY);
    const rect = clampRect(rectFromPoints(dragStart, current), pageSizeOf(dragPage));
    const draft = overlay?.querySelector<HTMLElement>('.reading-regions__draft');
    if (!draft || !overlay) return;
    const place = overlay.getBoundingClientRect();
    const client = regionClientBox({ ...rect, id: '', page: dragPage.page, kind: newKind }, dragPage);
    draft.style.display = 'block';
    draft.dataset.keyboard = 'false';
    draft.style.left = `${client.x - place.left}px`;
    draft.style.top = `${client.y - place.top}px`;
    draft.style.width = `${Math.max(1, client.width)}px`;
    draft.style.height = `${Math.max(1, client.height)}px`;
  }

  function onPointerUp(event: MouseEvent): void {
    if (!dragStart || !dragPage) return;
    const page = dragPage;
    const current = pointToPagePoint(page, event.clientX, event.clientY);
    const rect = clampRect(rectFromPoints(dragStart, current), pageSizeOf(page));
    dragStart = null;
    dragPage = null;
    const draft = overlay?.querySelector<HTMLElement>('.reading-regions__draft');
    if (draft) draft.style.display = 'none';
    if (!isRegionUsable(rect)) {
      // Arguably a mis-click: stay in draw mode so the reader can try again
      // without hunting for the button.
      announce('That was a click, not a box. Drag across part of the page.');
      return;
    }
    addRegion(page.page, rect, 'pointer');
  }

  // ── List interactions ─────────────────────────────────────────

  function onListKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // Let the document-level capture handler own Escape; this branch exists so
    // a stray stopPropagation inside a row cannot trap the key.
    closePanel('Reading regions closed.');
  }

  function onDragStart(event: DragEvent): void {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-region-id]');
    if (!item) return;
    draggingId = item.dataset.regionId ?? null;
    item.classList.add('reading-regions__item--dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', draggingId ?? ''); } catch { /* private mode */ }
    }
  }

  function onDragOver(event: DragEvent): void {
    if (!draggingId) return;
    if (!(event.target as HTMLElement | null)?.closest('[data-region-id]')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  function onDrop(event: DragEvent): void {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-region-id]');
    if (!item || !draggingId) return;
    event.preventDefault();
    const targetId = item.dataset.regionId;
    const pageRegions = currentPageRegions();
    const from = pageRegions.findIndex(region => region.id === draggingId);
    const to = pageRegions.findIndex(region => region.id === targetId);
    const moved = draggingId;
    draggingId = null;
    if (from < 0 || to < 0) return;
    commitRegions(reorderRegion(regions, currentPage, from, to));
    changed(`Region ${from + 1} moved to position ${to + 1} (${moved === targetId ? 'no change' : 'read order updated'}).`);
  }

  function onDragEnd(): void {
    draggingId = null;
    list?.querySelectorAll('.reading-regions__item--dragging')
      .forEach(item => item.classList.remove('reading-regions__item--dragging'));
  }

  // ── Wiring ────────────────────────────────────────────────────

  const onButtonClick = (): void => {
    if (open) closePanel('Reading regions closed.');
    else openPanel();
  };
  button?.addEventListener('click', onButtonClick);

  pageSelect?.addEventListener('change', () => {
    currentPage = Number(pageSelect.value) || currentPage;
    keyboardRect = null;
    view()?.showPage?.(currentPage);
    renderList();
    paint();
  });

  kindSelect?.addEventListener('change', () => {
    newKind = kindSelectValue();
  });

  document.getElementById('reading-regions-clear-page-btn')?.addEventListener('click', () => {
    const remaining = regions.filter(region => region.page !== currentPage);
    const removed = regions.length - remaining.length;
    if (!removed) {
      announce(`No regions to clear on page ${currentPage}.`);
      return;
    }
    commitRegions(remaining);
    changed(`Cleared ${removed} region(s) from page ${currentPage}.`);
  });

  document.getElementById('reading-regions-close-btn')?.addEventListener('click', () => {
    closePanel('Reading regions closed.');
  });

  document.getElementById('reading-regions-clear-all-btn')?.addEventListener('click', () => {
    if (!regions.length) {
      announce('No regions to clear.');
      return;
    }
    const removed = regions.length;
    commitRegions([]);
    changed(`Cleared all ${removed} region(s). The document reads in its original order again.`);
  });

  const onReaderDocument = (event: Event): void => {
    if (destroyed) return;
    const detail = (event as CustomEvent<ReaderDocumentDetail>).detail;
    if (!detail) return;
    const key = detail.key ? readingRegionsKeyForDocumentKey(detail.key) : null;
    if (key === documentKey) return; // progress saves re-fire this event
    documentKey = key;
    commitRegions(key ? loadReadingRegions(key) : []);
    syncedRevision = -1;
    syncedView = null;
    baseline = key
      ? { key, text: typeof detail.text === 'string' ? detail.text : '', anchors: [...(state?.extractedDocument?.anchors ?? [])] }
      : null;
    appliedKey = null;
    applyPlan();
    if (open) {
      if (!key) closePanel();
      else renderAll();
    }
    setButtonState();
  };
  document.addEventListener(READER_DOCUMENT_EVENT, onReaderDocument);

  list?.addEventListener('keydown', onListKeyDown);
  list?.addEventListener('dragstart', onDragStart);
  list?.addEventListener('dragover', onDragOver);
  list?.addEventListener('drop', onDrop);
  list?.addEventListener('dragend', onDragEnd);

  // A document view is mounted after the document event that announced it, so
  // the anchors it is born with can predate a saved read order. When it
  // appears, hand it the current ones. applyPlan is a no-op once the view and
  // the plan agree, which keeps this observer from reacting to its own work.
  if (typeof MutationObserver !== 'undefined' && host()) {
    hostObserver = new MutationObserver(() => {
      if (!destroyed && documentKey && regions.length) applyPlan();
    });
    hostObserver.observe(host()!, { childList: true, subtree: true });
  }

  renderKindSelect();
  // A place for focus to land when the row it was on is deleted.
  if (list && !list.hasAttribute('tabindex')) list.tabIndex = -1;
  if (panel) panel.hidden = true;
  setButtonState();

  return {
    destroy(): void {
      destroyed = true;
      restore();
      closePanel();
      hostObserver?.disconnect();
      hostObserver = null;
      document.removeEventListener(READER_DOCUMENT_EVENT, onReaderDocument);
      button?.removeEventListener('click', onButtonClick);
      list?.removeEventListener('dragstart', onDragStart);
      list?.removeEventListener('dragover', onDragOver);
      list?.removeEventListener('drop', onDrop);
      list?.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('resize', reposition);
    },
  };
}
