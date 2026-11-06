import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindReadingRegions, type ReadingRegionsHandle } from './reading-regions';
import type { AppState } from '../app-state';
import type { TextAnchor } from '../document-types';
import type { DocumentView } from './document-view';
import {
  loadReadingRegions,
  readingRegionsKeyForDocumentKey,
  type ReadingPageBox,
} from '../reading-regions';

// ─── Fixtures ────────────────────────────────────────────────────

const SOURCE = 'Left column first line.\nLeft column second line.\nSidebar note.';
const ANCHORS: TextAnchor[] = [
  { page: 1, x: 10, y: 10, width: 180, height: 16, start: 0, end: 23 },
  { page: 1, x: 10, y: 30, width: 180, height: 16, start: 24, end: 48 },
  { page: 1, x: 240, y: 10, width: 100, height: 16, start: 49, end: SOURCE.length },
];

const PROGRESS_KEY = 'yapper.document-progress.v1:scan.pdf:4096:1700000000000';
const REGIONS_KEY = readingRegionsKeyForDocumentKey(PROGRESS_KEY);

function pageBox(overrides: Partial<ReadingPageBox> = {}): ReadingPageBox {
  return { page: 1, left: 0, top: 0, width: 600, height: 800, scale: 1, ...overrides };
}

interface Fixture {
  state: AppState;
  view: DocumentView;
  setTextAnchors: ReturnType<typeof vi.fn>;
  handle: ReadingRegionsHandle;
  button: HTMLButtonElement;
  panel: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  pageSelect: HTMLSelectElement;
  kindSelect: HTMLSelectElement;
}

function fakeView(anchors: TextAnchor[]): { view: DocumentView; setTextAnchors: ReturnType<typeof vi.fn> } {
  const setTextAnchors = vi.fn();
  const view = {
    highlight: vi.fn(),
    pageCount: 1,
    activePage: 1,
    scale: 1,
    showPage: vi.fn(),
    goToOffset: vi.fn(),
    nextPage: vi.fn(),
    prevPage: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    cycleTheme: vi.fn(),
    getOutline: () => [],
    setAnnotations: vi.fn(),
    textAnchors: () => anchors.map(anchor => ({ ...anchor })),
    setTextAnchors,
    destroy: vi.fn(),
  } as unknown as DocumentView;
  return { view, setTextAnchors };
}

function mount(pages: ReadingPageBox[] = [pageBox()], anchors: TextAnchor[] = ANCHORS): Fixture {
  document.body.innerHTML = `
    <div id="document-view">
      <div class="docview__pages">
        <div class="docview__page"><div class="docview__surface"></div></div>
      </div>
    </div>
    <button id="reading-regions-btn" type="button" aria-pressed="false" aria-expanded="false">Reading regions</button>
    <span id="reading-regions-status"></span>
    <div id="reading-regions-panel" hidden>
      <select id="reading-regions-page"></select>
      <select id="reading-regions-kind"></select>
      <button id="reading-regions-close-btn" type="button">Close</button>
      <button id="reading-regions-clear-page-btn" type="button">Clear page</button>
      <button id="reading-regions-clear-all-btn" type="button">Clear all</button>
      <ol id="reading-regions-list"></ol>
    </div>`;

  const doc = {
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    text: SOURCE,
    anchors: anchors.map(anchor => ({ ...anchor })),
  };
  const state = { extractedDocument: doc } as unknown as AppState;
  const { view, setTextAnchors } = fakeView(anchors);
  const handle = bindReadingRegions({
    state,
    host: document.getElementById('document-view'),
    pages: () => pages,
    view: () => view,
    layer: document.body,
  });
  document.dispatchEvent(new CustomEvent('yapper:reader-document', {
    detail: { key: PROGRESS_KEY, name: 'scan.pdf', offset: 0, text: SOURCE },
  }));
  return {
    state,
    view,
    setTextAnchors,
    handle,
    button: document.getElementById('reading-regions-btn') as HTMLButtonElement,
    panel: document.getElementById('reading-regions-panel')!,
    list: document.getElementById('reading-regions-list')!,
    status: document.getElementById('reading-regions-status')!,
    pageSelect: document.getElementById('reading-regions-page') as HTMLSelectElement,
    kindSelect: document.getElementById('reading-regions-kind') as HTMLSelectElement,
  };
}

function layer(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.reading-regions__layer');
  if (!element) throw new Error('draw layer is not open');
  return element;
}

function drag(target: Element, from: [number, number], to: [number, number]): void {
  for (const [type, [clientX, clientY]] of [
    ['pointerdown', from],
    ['pointermove', to],
    ['pointerup', to],
  ] as const) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 }));
  }
}

function open(fixture: Fixture): void {
  fixture.button.click();
}

// ─── Tests ───────────────────────────────────────────────────────

describe('bindReadingRegions', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts disabled and enables when a document opens', () => {
    document.body.innerHTML = '';
    const handle = bindReadingRegions({
      state: { extractedDocument: null } as unknown as AppState,
      pages: () => [],
    });
    const button = document.getElementById('reading-regions-btn') as HTMLButtonElement | null;
    // No markup at all is fine — the binder simply has nothing to bind.
    expect(button).toBeNull();

    document.body.innerHTML = `
      <button id="reading-regions-btn" type="button"></button>
      <span id="reading-regions-status"></span>
      <div id="reading-regions-panel" hidden><ol id="reading-regions-list"></ol></div>`;
    const bound = bindReadingRegions({ state: { extractedDocument: null } as unknown as AppState, pages: () => [] });
    const realButton = document.getElementById('reading-regions-btn') as HTMLButtonElement;
    expect(realButton.disabled).toBe(true);
    document.dispatchEvent(new CustomEvent('yapper:reader-document', {
      detail: { key: PROGRESS_KEY, name: 'scan.pdf', offset: 0, text: SOURCE },
    }));
    expect(realButton.disabled).toBe(false);
    handle.destroy();
    bound.destroy();
  });

  it('draws a region, stores it per page, and speaks the read order', () => {
    const fixture = mount();
    open(fixture);
    expect(fixture.panel.hidden).toBe(false);
    expect(fixture.pageSelect.options).toHaveLength(1);
    expect(fixture.button.getAttribute('aria-pressed')).toBe('true');

    fixture.kindSelect.value = 'skip';
    fixture.kindSelect.dispatchEvent(new Event('change'));

    // Drag over the right-hand column only.
    drag(layer(), [240, 10], [340, 26]);

    const stored = loadReadingRegions(REGIONS_KEY);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ page: 1, kind: 'skip', x: 240, y: 10, width: 100, height: 16 });

    // The reader's text no longer carries the skipped column.
    const doc = fixture.state.extractedDocument!;
    expect(doc.text).not.toContain('Sidebar');
    expect(doc.text).toContain('Left column first line.');
    // The view is handed anchors for the new text, not the old offsets.
    expect(fixture.setTextAnchors).toHaveBeenCalled();
    const painted = fixture.setTextAnchors.mock.calls.at(-1)![0] as TextAnchor[];
    expect(painted).toHaveLength(2);

    // One row in the read order list, numbered.
    expect(fixture.list.querySelectorAll('.reading-regions__item')).toHaveLength(1);
    expect(fixture.list.textContent).toContain('Skip');
    expect(fixture.status.textContent).toContain('region 1 added on page 1');
  });

  it('stores page-space coordinates, so a zoom does not change them', () => {
    // The same spot on the page, drawn at 2x: the box is twice as wide on
    // screen, and must still be stored as the same page-space rectangle.
    const fixture = mount([pageBox({ width: 1200, height: 1600, scale: 2 })]);
    open(fixture);
    drag(layer(), [480, 20], [680, 52]);
    const [region] = loadReadingRegions(REGIONS_KEY);
    expect(region).toMatchObject({ x: 240, y: 10, width: 100, height: 16 });
    fixture.handle.destroy();
  });

  it('is not mouse-only: arrow keys start a box, Enter adds it, Escape exits', () => {
    const fixture = mount();
    open(fixture);
    const target = layer();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const stored = loadReadingRegions(REGIONS_KEY);
    expect(stored).toHaveLength(1);
    expect(stored[0].kind).toBe('main');
    // The first arrow starts the box at 10% of a 600×800 page; the next one
    // moves or resizes it, one 2% step at a time.
    expect(stored[0].x).toBeCloseTo(60, 5);
    expect(stored[0].width).toBeCloseTo(180, 5);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.reading-regions__layer')).toBeNull();
    expect(fixture.panel.hidden).toBe(true);
    expect(fixture.status.textContent).toContain('closed');
  });

  it('ignores a click that is not a box and stays in draw mode', () => {
    const fixture = mount();
    open(fixture);
    drag(layer(), [100, 100], [101, 101]);
    expect(loadReadingRegions(REGIONS_KEY)).toEqual([]);
    expect(document.querySelector('.reading-regions__layer')).not.toBeNull();
    expect(fixture.status.textContent).toContain('click, not a box');
  });

  it('reorders the read order with the list buttons and persists it', () => {
    const fixture = mount();
    open(fixture);
    // Two boxes: body then sidebar.
    drag(layer(), [10, 10], [190, 50]);
    drag(layer(), [240, 10], [340, 26]);
    let stored = loadReadingRegions(REGIONS_KEY);
    expect(stored.map(region => region.x)).toEqual([10, 240]);

    // Move the second region earlier: read the sidebar first.
    const rows = fixture.list.querySelectorAll<HTMLElement>('.reading-regions__item');
    rows[1].querySelector<HTMLButtonElement>('[aria-label="Read region 2 earlier"]')!.click();
    stored = loadReadingRegions(REGIONS_KEY);
    expect(stored.map(region => region.x)).toEqual([240, 10]);

    const doc = fixture.state.extractedDocument!;
    expect(doc.text.indexOf('Sidebar')).toBeLessThan(doc.text.indexOf('Left column'));
  });

  it('reorders by dragging a row onto another', () => {
    const fixture = mount();
    open(fixture);
    drag(layer(), [10, 10], [190, 50]);
    drag(layer(), [240, 10], [340, 26]);
    const rows = fixture.list.querySelectorAll<HTMLElement>('.reading-regions__item');

    rows[0].dispatchEvent(new Event('dragstart', { bubbles: true }));
    rows[1].dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    rows[1].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    expect(loadReadingRegions(REGIONS_KEY).map(region => region.x)).toEqual([240, 10]);
  });

  it('changes a region kind from its row and persists it', () => {
    const fixture = mount();
    open(fixture);
    drag(layer(), [240, 10], [340, 26]);
    const row = fixture.list.querySelector<HTMLElement>('.reading-regions__item')!;
    const select = row.querySelector<HTMLSelectElement>('.reading-regions__row-kind')!;
    select.value = 'figure';
    select.dispatchEvent(new Event('change'));
    expect(loadReadingRegions(REGIONS_KEY)[0].kind).toBe('figure');
    expect(fixture.state.extractedDocument!.text).not.toContain('Sidebar');
  });

  it('deletes a region and restores the original text when the last one goes', () => {
    const fixture = mount();
    open(fixture);
    fixture.kindSelect.value = 'skip';
    fixture.kindSelect.dispatchEvent(new Event('change'));
    drag(layer(), [240, 10], [340, 26]);
    expect(fixture.state.extractedDocument!.text).not.toContain('Sidebar');

    fixture.list.querySelector<HTMLButtonElement>('[aria-label="Delete region 1"]')!.click();
    expect(loadReadingRegions(REGIONS_KEY)).toEqual([]);
    // Byte-for-byte back to what the document opened with.
    expect(fixture.state.extractedDocument!.text).toBe(SOURCE);
    expect(fixture.setTextAnchors.mock.calls.at(-1)![0]).toEqual(ANCHORS);
  });

  it('clears one page without touching another', () => {
    const fixture = mount([
      pageBox({ page: 1 }),
      pageBox({ page: 2, top: 820 }),
    ]);
    open(fixture);
    drag(layer(), [240, 10], [340, 26]);

    fixture.pageSelect.value = '2';
    fixture.pageSelect.dispatchEvent(new Event('change'));
    drag(layer(), [10, 830], [190, 870]);
    expect(loadReadingRegions(REGIONS_KEY).filter(region => region.page === 2)).toHaveLength(1);

    document.getElementById('reading-regions-clear-page-btn')!.click();
    const stored = loadReadingRegions(REGIONS_KEY);
    expect(stored).toHaveLength(1);
    expect(stored[0].page).toBe(1);
  });

  it('survives a corrupt saved record and still opens', () => {
    localStorage.setItem(REGIONS_KEY, '{"pages":{"1":["nope"]');
    const fixture = mount();
    open(fixture);
    expect(document.querySelector('.reading-regions__layer')).not.toBeNull();
    expect(loadReadingRegions(REGIONS_KEY)).toEqual([]);
    expect(fixture.state.extractedDocument!.text).toBe(SOURCE);
  });

  it('applies saved regions as soon as their document opens', () => {
    const stored = {
      pages: {
        '1': [
          { id: 'sidebar', kind: 'skip', x: 240, y: 0, width: 140, height: 60 },
          { id: 'body', kind: 'main', x: 0, y: 0, width: 220, height: 60 },
        ],
      },
    };
    localStorage.setItem(REGIONS_KEY, JSON.stringify(stored));
    const fixture = mount();
    expect(fixture.state.extractedDocument!.text).not.toContain('Sidebar');
    // Nothing has been drawn yet; opening the editor just shows the saved rows.
    open(fixture);
    expect(fixture.list.querySelectorAll('.reading-regions__item')).toHaveLength(2);
  });

  it('says so when a document has no recognised text to anchor boxes to', () => {
    const fixture = mount([pageBox()], []);
    open(fixture);
    drag(layer(), [240, 10], [340, 26]);
    expect(loadReadingRegions(REGIONS_KEY)).toHaveLength(1);
    expect(fixture.status.textContent).toContain('no recognised text');
  });

  it('announces that there is nothing to draw on outside a rendered PDF', () => {
    const fixture = mount([]);
    open(fixture);
    expect(document.querySelector('.reading-regions__layer')).toBeNull();
    expect(fixture.status.textContent).toContain('rendered pages of a PDF');
  });

  it('hands a view that mounts after the document event the current anchors', async () => {
    localStorage.setItem(REGIONS_KEY, JSON.stringify({
      pages: { '1': [{ id: 'sidebar', kind: 'skip', x: 240, y: 0, width: 140, height: 60 }] },
    }));
    document.body.innerHTML = `
      <div id="document-view"></div>
      <button id="reading-regions-btn" type="button"></button>
      <span id="reading-regions-status"></span>
      <div id="reading-regions-panel" hidden>
        <select id="reading-regions-page"></select>
        <select id="reading-regions-kind"></select>
        <ol id="reading-regions-list"></ol>
      </div>`;
    const doc = {
      name: 'scan.pdf', mimeType: 'application/pdf', text: SOURCE,
      anchors: ANCHORS.map(anchor => ({ ...anchor })),
    };
    const state = { extractedDocument: doc } as unknown as AppState;
    let currentView: DocumentView | null = null;
    const { view, setTextAnchors } = fakeView(ANCHORS);
    const handle = bindReadingRegions({
      state,
      host: document.getElementById('document-view'),
      pages: () => [pageBox()],
      view: () => currentView,
    });

    document.dispatchEvent(new CustomEvent('yapper:reader-document', {
      detail: { key: PROGRESS_KEY, name: 'scan.pdf', offset: 0, text: SOURCE },
    }));
    // Text is reordered straight away — reading is correct even if the editor
    // is never opened. The view has not mounted yet, so it has no anchors.
    expect(doc.text).not.toContain('Sidebar');
    expect(setTextAnchors).not.toHaveBeenCalled();

    // The reader mounts its view a moment later; the observer hands it the
    // rebased anchors as soon as it appears.
    currentView = view;
    document.getElementById('document-view')!.appendChild(document.createElement('div'));
    await Promise.resolve();
    expect(setTextAnchors).toHaveBeenCalled();
    const painted = setTextAnchors.mock.calls.at(-1)![0] as TextAnchor[];
    expect(painted).toHaveLength(2);
    expect(painted[0].start).toBe(0);
    handle.destroy();
  });

  it('restores the document text when torn down mid-edit', () => {
    const fixture = mount();
    open(fixture);
    fixture.kindSelect.value = 'skip';
    fixture.kindSelect.dispatchEvent(new Event('change'));
    drag(layer(), [240, 10], [340, 26]);
    expect(fixture.state.extractedDocument!.text).not.toContain('Sidebar');
    fixture.handle.destroy();
    expect(fixture.state.extractedDocument!.text).toBe(SOURCE);
  });
});
