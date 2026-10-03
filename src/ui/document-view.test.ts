import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHtmlView, mountPdfView } from './document-view';

const hosts: HTMLElement[] = [];

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}

afterEach(() => {
  for (const el of hosts.splice(0)) el.remove();
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
  vi.restoreAllMocks();
});

/** jsdom has no range geometry; give every range one visible box. */
function stubRangeRects(): void {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ left: 4, top: 8, width: 20, height: 10 }],
  });
}

function stubCanvasContext(): void {
  const context = {
    fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), transform: vi.fn(),
    clearRect: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
    measureText: vi.fn(() => ({ width: 1 })), setTransform: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    putImageData: vi.fn(), drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context);
}

describe('HTML document view controls', () => {
  it('navigates named sections, changes type size, and reports persisted position', () => {
    const hostEl = host();
    const onNavigate = vi.fn();
    const view = mountHtmlView(hostEl,
      '<h2><span data-off="0:5">First</span></h2><p><span data-off="7:12">Alpha</span></p>'
      + '<h2><span data-off="15:21">Second</span></h2><p><span data-off="23:28">Bravo</span></p>',
      'Notes', {
        sections: [{ title: 'First', start: 0, end: 12 }, { title: 'Second', start: 15, end: 28 }],
        onNavigate,
      });

    const select = hostEl.querySelector<HTMLSelectElement>('.docview__section')!;
    expect(select.options).toHaveLength(2);
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    expect(onNavigate).toHaveBeenCalledWith({ offset: 15, scale: 1 });
    expect(hostEl.querySelector('.dochtml__content [data-off="15:21"]')?.closest('h2'))
      .not.toBeNull();

    hostEl.querySelector<HTMLButtonElement>('[data-role="font-up"]')!.click();
    expect(view.scale).toBeCloseTo(1.1);
    expect(onNavigate).toHaveBeenLastCalledWith({ scale: 1.1 });

    view.goToOffset(23);
    view.destroy();
    expect(hostEl.querySelector('.docview')).toBeNull();
  });

  it('hides chapter navigation when the document has no chapter structure', () => {
    const hostEl = host();
    mountHtmlView(hostEl, '<p><span data-off="0:4">Text</span></p>', 'Plain', {});
    expect(hostEl.querySelector('.docview__section')).toBeNull();
    expect(hostEl.querySelector('[data-role="section-prev"]')).toBeNull();
  });

  it('lists search matches with snippets and jumps from the results panel', async () => {
    const hostEl = host();
    const onNavigate = vi.fn();
    mountHtmlView(hostEl,
      '<p><span data-off="0:5">Alpha</span> <span data-off="6:10">beta</span></p>'
      + '<p><span data-off="12:17">Alpha</span> again</p>',
      'Notes', { text: 'Alpha beta\n\nAlpha again', onNavigate });

    const input = hostEl.querySelector<HTMLInputElement>('.docview__search')!;
    input.value = 'alpha';
    input.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 160));

    const results = hostEl.querySelectorAll<HTMLButtonElement>('.docview__result');
    expect(results).toHaveLength(2);
    expect(hostEl.querySelector('.docview__search-status')?.textContent).toBe('2 matches');
    // Find-as-you-type lands on the first hit immediately.
    expect(onNavigate).toHaveBeenLastCalledWith({ offset: 0, scale: 1 });

    results[1].click();
    expect(onNavigate).toHaveBeenLastCalledWith({ offset: 12, scale: 1 });

    // Whole-word mode narrows a partial query to nothing.
    input.value = 'lph';
    input.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(hostEl.querySelectorAll('.docview__result')).toHaveLength(2);
    hostEl.querySelector<HTMLButtonElement>('[data-role="search-word"]')!.click();
    expect(hostEl.querySelectorAll('.docview__result')).toHaveLength(0);
    expect(hostEl.querySelector('.docview__search-status')?.textContent).toBe('No matches');

    // Escape clears the search and its panel.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(hostEl.querySelector('[data-role="search-panel"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('cycles reading themes and reports the type size', () => {
    const hostEl = host();
    const onNavigate = vi.fn();
    const view = mountHtmlView(hostEl, '<p><span data-off="0:4">Text</span></p>', 'Plain', {
      text: 'Text',
      onNavigate,
    });

    const themeButton = hostEl.querySelector<HTMLButtonElement>('[data-role="theme"]')!;
    expect(hostEl.dataset.docTheme).toBe('light');
    themeButton.click();
    expect(hostEl.dataset.docTheme).toBe('sepia');
    expect(view.theme).toBe('sepia');
    expect(onNavigate).toHaveBeenLastCalledWith({ theme: 'sepia' });
    themeButton.click();
    themeButton.click();
    expect(hostEl.dataset.docTheme).toBe('light');

    const readout = hostEl.querySelector<HTMLElement>('[data-role="zoom-readout"]')!;
    expect(readout.textContent).toBe('100%');
    hostEl.querySelector<HTMLButtonElement>('[data-role="font-up"]')!.click();
    expect(readout.textContent).toBe('110%');
  });
});

describe('HTML document view search powers', () => {
  const html = '<p><span data-off="0:5">Alpha</span> <span data-off="6:10">beta</span></p>'
    + '<p><span data-off="12:17">Alpha</span> again</p>';
  const text = 'Alpha beta\n\nAlpha again';

  it('searches with regular expressions and reports invalid patterns', async () => {
    const hostEl = host();
    mountHtmlView(hostEl, html, 'Notes', { text: 'cat1 cat22 dog\n\nAlpha again' });
    hostEl.querySelector<HTMLButtonElement>('[data-role="search-regex"]')!.click();
    const input = hostEl.querySelector<HTMLInputElement>('.docview__search')!;

    input.value = 'cat\\d+';
    input.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(hostEl.querySelectorAll('.docview__result')).toHaveLength(2);

    input.value = 'cat(';
    input.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(hostEl.querySelector('.docview__search-status')?.textContent).toBe('Invalid pattern');
    expect(hostEl.querySelectorAll('.docview__result')).toHaveLength(0);
  });

  it('paints highlight-all marks that survive jumps, and user annotations', async () => {
    stubRangeRects();
    const hostEl = host();
    const view = mountHtmlView(hostEl, html, 'Notes', { text });
    const input = hostEl.querySelector<HTMLInputElement>('.docview__search')!;
    input.value = 'alpha';
    input.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 160));

    hostEl.querySelector<HTMLButtonElement>('[data-role="search-highlight"]')!.click();
    expect(hostEl.querySelectorAll('.dochtml__hl--all')).toHaveLength(2);
    // The live match box sits alongside the persistent ones.
    expect(hostEl.querySelectorAll('.dochtml__hl').length).toBeGreaterThanOrEqual(3);

    // Annotations are painted in their own colour and outlive a jump.
    view.setAnnotations([{ start: 0, end: 5, color: 'green' }]);
    expect(hostEl.querySelectorAll('.dochtml__hl--green')).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(hostEl.querySelectorAll('.dochtml__hl--green')).toHaveLength(1);
    expect(hostEl.querySelectorAll('.dochtml__hl--all')).toHaveLength(2);
  });

  it('scopes search to the current section when asked', async () => {
    const hostEl = host();
    mountHtmlView(hostEl, html, 'Notes', {
      text,
      sections: [{ title: 'First', start: 0, end: 12 }, { title: 'Second', start: 12, end: 28 }],
    });
    const input = hostEl.querySelector<HTMLInputElement>('.docview__search')!;
    input.value = 'alpha';
    input.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(hostEl.querySelectorAll('.docview__result')).toHaveLength(2);

    hostEl.querySelector<HTMLButtonElement>('[data-role="search-scope"]')!.click();
    expect(hostEl.querySelectorAll('.docview__result')).toHaveLength(1);
    expect(hostEl.querySelector('.docview__search-status')?.textContent).toBe('1 match in this section');
  });
});

describe('HTML document view outline, tabs, and layout', () => {
  const html = '<h1 data-off="0:5">Intro</h1><p data-off="6:10">body</p>'
    + '<h2 data-off="12:17">Details</h2><p data-off="18:22">more</p>';

  it('lists headings in the outline panel and jumps on click', () => {
    const hostEl = host();
    const onNavigate = vi.fn();
    mountHtmlView(hostEl, html, 'Notes', {
      text: 'Intro body Details more',
      onNavigate,
    });
    const toggle = hostEl.querySelector<HTMLButtonElement>('[data-role="toggle-outline"]')!;
    toggle.click();
    const items = hostEl.querySelectorAll<HTMLButtonElement>('.docview__outline-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Intro');
    items[1].click();
    expect(onNavigate).toHaveBeenLastCalledWith({ offset: 12, scale: 1 });
  });

  it('renders section tabs and an overview grid', () => {
    const hostEl = host();
    const onNavigate = vi.fn();
    mountHtmlView(hostEl, html, 'Deck', {
      text: 'Intro body Details more',
      sections: [
        { title: 'Slide 1', start: 0, end: 10 },
        { title: 'Slide 2', start: 12, end: 22 },
      ],
      onNavigate,
    });
    const tabs = hostEl.querySelectorAll<HTMLButtonElement>('.docview__tab');
    expect(tabs).toHaveLength(2);
    tabs[1].click();
    expect(onNavigate).toHaveBeenLastCalledWith({ offset: 12, scale: 1 });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');

    hostEl.querySelector<HTMLButtonElement>('[data-role="toggle-overview"]')!.click();
    const cards = hostEl.querySelectorAll<HTMLElement>('.docview__overview-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Slide 1');
    cards[1].click();
    expect(onNavigate).toHaveBeenLastCalledWith({ offset: 12, scale: 1 });
  });

  it('cycles the font family and reports it for persistence', () => {
    const hostEl = host();
    const onNavigate = vi.fn();
    const view = mountHtmlView(hostEl, '<p data-off="0:4">Text</p>', 'Plain', {
      text: 'Text',
      onNavigate,
    });
    hostEl.querySelector<HTMLButtonElement>('[data-role="font-family"]')!.click();
    expect(view.fontFamily).toBe('mono');
    expect(onNavigate).toHaveBeenLastCalledWith({ fontFamily: 'mono' });
    // Flow layout by default: no sheets and no page controls to click.
    expect(hostEl.querySelector('.docpage')).toBeNull();
    expect(hostEl.querySelector('[data-role="page-prev"]')).toBeNull();
    expect(view.pageCount).toBe(0);
    expect(view.activePage).toBe(0);
  });

  it('flows blocks onto page sheets with a page counter and page turns', () => {
    const hostEl = host();
    const view = mountHtmlView(hostEl,
      '<p data-off="0:4">Text</p><p data-off="6:10">more</p>', 'Plain', {
      text: 'Text\n\nmore',
      paginated: true,
    });
    expect(hostEl.classList.contains('docview--pages')).toBe(true);
    // jsdom has no layout, so the whole document fits one sheet — but it is
    // a sheet: the runs sit on it and the counter reads its page.
    const sheets = hostEl.querySelectorAll('.docpage');
    expect(sheets).toHaveLength(1);
    expect(sheets[0].querySelectorAll('[data-off]')).toHaveLength(2);
    expect(sheets[0].getAttribute('aria-label')).toBe('Page 1 of 1');
    expect(view.pageCount).toBe(1);
    expect(view.activePage).toBe(1);
    expect(hostEl.querySelector('.docview__count')?.textContent).toBe('Page 1 of 1');
    // Page turns walk the sheets and clamp at the ends.
    view.nextPage();
    expect(view.activePage).toBe(1);
    view.prevPage();
    expect(view.activePage).toBe(1);
    // The stamped markup survives the flow: runs still resolve to their block.
    expect(hostEl.querySelector('.dochtml__content [data-off="6:10"]')?.closest('p')).not.toBeNull();
  });
});

describe('karaoke word painting', () => {
  it('paints the spoken word bright inside a faint sentence trail', () => {
    stubRangeRects();
    const hostEl = host();
    const onNavigate = vi.fn();
    const view = mountHtmlView(
      hostEl,
      '<p><span data-off="0:19">the quick brown fox</span></p>',
      'Notes',
      { text: 'the quick brown fox', onNavigate },
    );

    // "quick" (4:9) spoken inside the sentence (0:19).
    view.highlight(4, 9, { start: 0, end: 19 });
    expect(hostEl.querySelectorAll('.dochtml__hl--context')).toHaveLength(1);
    expect(hostEl.querySelectorAll('.dochtml__hl:not(.dochtml__hl--context)')).toHaveLength(1);

    // The next word in the same block: repaint, but no lurching scroll and
    // no navigation report.
    view.highlight(10, 15, { start: 0, end: 19 });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(hostEl.querySelectorAll('.dochtml__hl--context')).toHaveLength(1);

    // Without a context, only the bright box is painted.
    view.highlight(4, 9);
    expect(hostEl.querySelectorAll('.dochtml__hl--context')).toHaveLength(0);
  });
});

describe('PDF document view outline and annotations', () => {
  function mockPdf(extra: Record<string, unknown> = {}) {
    const page = {
      getViewport: ({ scale = 1 }: { scale?: number }) => ({ width: 100 * scale, height: 140 * scale }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      cleanup: vi.fn(),
    };
    const pdf = { numPages: 2, getPage: vi.fn(async () => page), ...extra };
    vi.resetModules();
    vi.doMock('pdfjs-dist', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(pdf), destroy: vi.fn() }),
    }));
    return pdf;
  }

  it('resolves the PDF outline to pages and jumps on click', async () => {
    stubCanvasContext();
    mockPdf({
      getOutline: async () => [
        { title: 'Chapter 1', dest: 'ch1', items: [{ title: 'Section 1.1', dest: 's11' }] },
        { title: 'Dangling', dest: 'gone' },
      ],
      getDestination: async (dest: string) => dest === 'gone' ? null : [[{ num: 1, gen: 0 }, 'Fit']],
      getPageIndex: async () => 1,
    });
    const hostEl = host();
    let view: Awaited<ReturnType<typeof mountPdfView>> | undefined;
    try {
      view = await mountPdfView(hostEl, new File(['pdf'], 'reader.pdf'), [
        { page: 1, x: 1, y: 1, width: 10, height: 4, start: 0, end: 5 },
        { page: 2, x: 1, y: 1, width: 10, height: 4, start: 6, end: 11 },
      ], { text: 'Alpha\n\nBravo' });
      const toggle = hostEl.querySelector<HTMLButtonElement>('[data-role="toggle-outline"]')!;
      expect(toggle.hidden).toBe(false);
      toggle.click();
      // The dangling entry is dropped: only jumpable items are listed.
      const items = hostEl.querySelectorAll<HTMLButtonElement>('.docview__outline-item');
      expect([...items].map(item => item.textContent)).toEqual(['Chapter 12', 'Section 1.12']);
      items[0].click();
      expect(view.activePage).toBe(2);
      expect(view.getOutline().map(item => item.title)).toEqual(['Chapter 1', 'Section 1.1']);
    } finally {
      view?.destroy();
      vi.doUnmock('pdfjs-dist');
    }
  });

  it('hides the outline button and paints annotation boxes', async () => {
    stubCanvasContext();
    mockPdf({});
    const hostEl = host();
    let view: Awaited<ReturnType<typeof mountPdfView>> | undefined;
    try {
      view = await mountPdfView(hostEl, new File(['pdf'], 'reader.pdf'), [
        { page: 1, x: 1, y: 1, width: 10, height: 4, start: 0, end: 5 },
        { page: 2, x: 1, y: 1, width: 10, height: 4, start: 6, end: 11 },
      ], { text: 'Alpha\n\nBravo' });
      expect(hostEl.querySelector<HTMLButtonElement>('[data-role="toggle-outline"]')!.hidden).toBe(true);
      view.setAnnotations([{ start: 6, end: 11, color: 'green' }]);
      expect(hostEl.querySelectorAll('.docview__hl--green').length).toBeGreaterThan(0);

      // Karaoke: a word box inside the sentence's trail on its page.
      view.highlight(7, 11, { start: 6, end: 11 });
      expect(hostEl.querySelectorAll('.docview__hl--context').length).toBeGreaterThan(0);
      expect(hostEl.querySelectorAll('.docview__hl:not(.docview__hl--context):not(.docview__hl--green)').length)
        .toBeGreaterThan(0);
    } finally {
      view?.destroy();
      vi.doUnmock('pdfjs-dist');
    }
  });
});

describe('PDF document view search and navigation', () => {
  it('searches extracted text and reports the matching page and offset', async () => {
    stubCanvasContext();
    const page = {
      getViewport: ({ scale = 1 }: { scale?: number }) => ({ width: 100 * scale, height: 140 * scale }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      cleanup: vi.fn(),
    };
    const pdf = { numPages: 2, getPage: vi.fn(async () => page) };
    vi.resetModules();
    vi.doMock('pdfjs-dist', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(pdf), destroy: vi.fn() }),
    }));

    const onNavigate = vi.fn();
    const hostEl = host();
    let view: Awaited<ReturnType<typeof mountPdfView>> | undefined;
    try {
      view = await mountPdfView(hostEl, new File(['pdf'], 'reader.pdf'), [
        { page: 1, x: 1, y: 1, width: 10, height: 4, start: 0, end: 5 },
        { page: 2, x: 1, y: 1, width: 10, height: 4, start: 6, end: 11 },
      ], {
        text: 'Alpha\n\nBravo',
        onNavigate,
      });
      const input = hostEl.querySelector<HTMLInputElement>('.docview__search')!;
      input.value = 'Bravo';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 160));
      expect(hostEl.querySelector('.docview__count')?.textContent).toContain('Match 1 of 1');
      expect(hostEl.querySelector('.docview__count')?.textContent).toContain('Page 2 of 2');
      expect(onNavigate).toHaveBeenCalledWith({ offset: 7, page: 2, scale: 1.35 });
      expect(hostEl.querySelectorAll('.docview__thumbnail')).toHaveLength(2);
    } finally {
      view?.destroy();
      vi.doUnmock('pdfjs-dist');
    }
  });

  it('indexes a scanned document on demand and searches the OCR text', async () => {
    stubCanvasContext();
    const page = {
      getViewport: ({ scale = 1 }: { scale?: number }) => ({ width: 100 * scale, height: 140 * scale }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      cleanup: vi.fn(),
    };
    const pdf = { numPages: 2, getPage: vi.fn(async () => page) };
    vi.resetModules();
    vi.doMock('pdfjs-dist', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(pdf), destroy: vi.fn() }),
    }));

    const onNavigate = vi.fn();
    const loadSearchText = vi.fn(async (onProgress: (message: string) => void) => {
      onProgress('OCR page 1: 50%');
      return {
        text: 'Scanned words appear here',
        anchors: [{ page: 2, x: 1, y: 1, width: 10, height: 4, start: 19, end: 24 }],
      };
    });
    const hostEl = host();
    let view: Awaited<ReturnType<typeof mountPdfView>> | undefined;
    try {
      // No text and no anchors at mount time: a scanned page set.
      view = await mountPdfView(hostEl, new File(['pdf'], 'scan.pdf'), [], {
        loadSearchText,
        onNavigate,
      });
      const input = hostEl.querySelector<HTMLInputElement>('.docview__search')!;
      input.value = 'words';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));

      expect(loadSearchText).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledWith({ offset: 8, page: 2, scale: 1.35 });
      expect(hostEl.querySelector('.docview__count')?.textContent).toContain('Match 1 of 1');

      input.value = 'nothing here';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(hostEl.querySelector('.docview__search-status')?.textContent).toBe('No matches');
      // The index is reused: OCR runs once per document.
      expect(loadSearchText).toHaveBeenCalledTimes(1);
    } finally {
      view?.destroy();
      vi.doUnmock('pdfjs-dist');
    }
  });
});
