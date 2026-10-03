import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeContinuations,
  paginateFlow,
  paginateIntoPages,
  paginatePlan,
  splitBlockAt,
} from './pagination';

describe('paginatePlan', () => {
  it('keeps blocks that fit on one page together', () => {
    expect(paginatePlan([10, 10, 10], 40)).toEqual([[0, 1, 2]]);
    expect(paginatePlan([], 40)).toEqual([[]]);
  });

  it('starts a new page when the next block would not fit', () => {
    // 30 does not fit after the first two; 10 then fills the second page
    // exactly (30 + 10 = 40).
    expect(paginatePlan([10, 10, 30, 10], 40)).toEqual([[0, 1], [2, 3]]);
    expect(paginatePlan([25, 25], 40)).toEqual([[0], [1]]);
  });

  it('gives an over-budget block a page of its own', () => {
    expect(paginatePlan([5, 100, 5], 40)).toEqual([[0], [1], [2]]);
    // The giant block does not push its neighbours onto the same page.
    expect(paginatePlan([100], 40)).toEqual([[0]]);
  });

  it('packs everything onto one page when the budget cannot be measured', () => {
    expect(paginatePlan([10, 10, 10], 0)).toEqual([[0, 1, 2]]);
    expect(paginatePlan([10, 10, 10], -5)).toEqual([[0, 1, 2]]);
    // Heights of zero (a surface with no layout yet) never split either.
    expect(paginatePlan([0, 0, 0], 40)).toEqual([[0, 1, 2]]);
  });
});

describe('paginateFlow', () => {
  it('keeps unsplittable blocks whole, as the plain packer does', () => {
    expect(paginateFlow([
      { height: 10, text: 'aaaa', splittable: false },
      { height: 35, text: 'bbbb', splittable: false },
    ], 40, 10)).toEqual([[{ index: 0 }], [{ index: 1 }]]);
  });

  it('cuts a paragraph at a word boundary to fill the page', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const pages = paginateFlow([{ height: 100, text, splittable: true }], 60, 10);
    expect(pages).toHaveLength(2);
    const cut = pages[0][0].end;
    expect(cut).toBeGreaterThan(8);
    expect(text[cut]).toMatch(/\s/); // never mid-word
    expect(pages[1]).toEqual([{ index: 0 }]);
  });

  it('spreads a too-tall paragraph over as many sheets as it needs', () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const pages = paginateFlow([{ height: 300, text, splittable: true }], 100, 20);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[pages.length - 1]).toEqual([{ index: 0 }]);
    // Cuts advance monotonically and always land on a word boundary.
    let prev = 0;
    for (const page of pages) {
      for (const piece of page) {
        if (piece.end === undefined) continue;
        expect(piece.end).toBeGreaterThan(prev);
        expect(text[piece.end]).toMatch(/\s/);
        prev = piece.end;
      }
    }
  });

  it('does not strand a sliver of paragraph on the next page', () => {
    const pages = paginateFlow([
      { height: 290, text: 'first block of text.', splittable: true },
      { height: 100, text: 'second block of text.', splittable: true },
    ], 300, 50);
    expect(pages).toEqual([[{ index: 0 }], [{ index: 1 }]]);
  });

  it('falls back to whole-block packing when nothing can be measured', () => {
    expect(paginateFlow([{ height: 0, text: 'some words here', splittable: true }], 0, 50))
      .toEqual([[{ index: 0 }]]);
    expect(paginateFlow([], 400, 50)).toEqual([[]]);
  });
});

describe('splitBlockAt and mergeContinuations', () => {
  it('cuts a stamped run at any character and keeps the stamps tiling', () => {
    const p = document.createElement('p');
    const span = document.createElement('span');
    span.dataset.off = '0:38';
    span.textContent = 'the quick brown fox jumps over the dog';
    p.appendChild(span);

    const out = splitBlockAt(p, 19);
    expect(out).not.toBeNull();
    expect(out!.cut).toBe(19);
    expect(p.textContent).toHaveLength(19);
    expect(out!.tail.textContent).toHaveLength(19);
    expect(p.querySelector('span')!.dataset.off).toBe('0:19');
    expect(out!.tail.querySelector('span')!.dataset.off).toBe('19:38');
    expect(p.classList.contains('doc-split-more')).toBe(true);
    expect(out!.tail.classList.contains('doc-split-cont')).toBe(true);
    expect(out!.tail.classList.contains('doc-split-more')).toBe(false);
  });

  it('keeps bold and italic wrappers on both halves', () => {
    const p = document.createElement('p');
    const span = document.createElement('span');
    span.dataset.off = '10:22';
    span.innerHTML = '<strong><em>abcdefghijkl</em></strong>';
    p.appendChild(span);

    const out = splitBlockAt(p, 5)!;
    expect(out.cut).toBe(5);
    expect(p.querySelector('strong em')!.textContent).toBe('abcde');
    expect(out.tail.querySelector('strong em')!.textContent).toBe('fghijkl');
    expect(p.querySelector('span')!.dataset.off).toBe('10:15');
    expect(out.tail.querySelector('span')!.dataset.off).toBe('15:22');
  });

  it('steps back to a child boundary rather than cut a sentence', () => {
    const p = document.createElement('p');
    p.className = 'reader-paragraph';
    const a = document.createElement('span');
    a.className = 'reader-sentence';
    a.textContent = 'One sentence here.';
    const b = document.createElement('span');
    b.className = 'reader-sentence';
    b.textContent = 'Two sentence here.';
    p.append(a, document.createTextNode(' '), b);

    // Inside the first sentence there is nowhere legal to land, and the
    // block must come back untouched.
    expect(splitBlockAt(p, 5)).toBeNull();
    expect(p.childNodes).toHaveLength(3);

    // Inside the second, the cut steps back to before it: whole sentences
    // only, so the reading highlight keeps its identity across sheets.
    const out = splitBlockAt(p, 25)!;
    expect(out.cut).toBe(19);
    expect(out.tail.firstChild).toBe(b);
    expect(p.textContent).toBe('One sentence here. ');
  });

  it('merges continuation pieces back into pristine blocks', () => {
    const container = document.createElement('div');
    const p = document.createElement('p');
    const span = document.createElement('span');
    span.dataset.off = '0:39';
    span.textContent = 'abcdefghij klmnopqrst uvwxyz 0123456789';
    p.appendChild(span);
    container.appendChild(p);

    container.appendChild(splitBlockAt(p, 10)!.tail);
    container.appendChild(splitBlockAt(
      container.querySelector('.doc-split-cont') as HTMLElement, 10)!.tail);
    expect(container.querySelectorAll('p')).toHaveLength(3);

    expect(mergeContinuations(container)).toBe(2);
    expect(container.children).toHaveLength(1);
    expect(p.textContent).toBe('abcdefghij klmnopqrst uvwxyz 0123456789');
    expect(p.classList.contains('doc-split-more')).toBe(false);
    expect(container.querySelector('.doc-split-cont')).toBeNull();
    // The tiling survives the round trip: three runs, one text.
    expect(p.textContent!.length).toBe(39);
  });

  it('merges a continuation that starts the next sheet', () => {
    // A cut always leaves the head last on one sheet and the continuation
    // first on the next, so inside its own body it has no previous sibling:
    // only the flattened reading order knows which block it belongs to.
    const container = document.createElement('div');
    const sheet1 = document.createElement('div');
    sheet1.className = 'docpage';
    const body1 = document.createElement('div');
    body1.className = 'docpage__body';
    const head = document.createElement('p');
    head.className = 'doc-split-more';
    head.textContent = 'head of the paragraph. ';
    body1.appendChild(head);
    sheet1.appendChild(body1);
    const sheet2 = document.createElement('div');
    sheet2.className = 'docpage';
    const body2 = document.createElement('div');
    body2.className = 'docpage__body';
    const cont = document.createElement('p');
    cont.className = 'doc-split-cont';
    cont.textContent = 'tail of the paragraph.';
    body2.appendChild(cont);
    sheet2.appendChild(body2);
    container.append(sheet1, sheet2);

    expect(mergeContinuations(container)).toBe(1);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(head.textContent).toBe('head of the paragraph. tail of the paragraph.');
    expect(head.classList.contains('doc-split-more')).toBe(false);
  });
});

describe('paginateIntoPages', () => {
  const containers: HTMLElement[] = [];
  const handles: Array<{ destroy(): void }> = [];

  function buildContainer(): HTMLElement {
    const container = document.createElement('div');
    container.innerHTML = '<p>one</p><p>two</p><h2>three</h2>';
    document.body.appendChild(container);
    containers.push(container);
    return container;
  }

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.destroy();
    for (const container of containers.splice(0)) container.remove();
    vi.restoreAllMocks();
  });

  it('wraps the blocks into one sheet and reports the page count', () => {
    const container = buildContainer();
    const onPageCount = vi.fn();
    const handle = paginateIntoPages(container, { onPageCount });
    handles.push(handle);

    // jsdom has no layout, so everything lands on a single sheet — but in
    // order, inside a page body, with the sheet labelled.
    expect(handle.pageCount).toBe(1);
    expect(onPageCount).toHaveBeenCalledWith(1);
    const sheet = container.querySelectorAll('.docpage');
    expect(sheet).toHaveLength(1);
    expect(sheet[0].getAttribute('aria-label')).toBe('Page 1 of 1');
    expect([...sheet[0].querySelector('.docpage__body')!.children]
      .map(el => el.tagName)).toEqual(['P', 'P', 'H2']);
    expect(container.querySelectorAll('.docpage p').length).toBe(2);
  });

  it('re-packs from the sheets on repeated layout without losing blocks', () => {
    const container = buildContainer();
    const handle = paginateIntoPages(container);
    handles.push(handle);

    handle.layout();
    handle.layout();
    expect(container.querySelectorAll('.docpage')).toHaveLength(1);
    const texts = [...container.querySelectorAll('.docpage__body > *')].map(el => el.textContent);
    expect(texts).toEqual(['one', 'two', 'three']);
    // No stray blocks left outside the sheets.
    expect([...container.children].every(el => el.classList.contains('docpage'))).toBe(true);
  });

  it('adopts blocks a caller renders after the first layout', () => {
    const container = buildContainer();
    const handle = paginateIntoPages(container);
    handles.push(handle);

    const extra = document.createElement('p');
    extra.textContent = 'four';
    container.appendChild(extra);
    handle.layout();
    expect([...container.querySelectorAll('.docpage__body > *')].map(el => el.textContent))
      .toEqual(['one', 'two', 'three', 'four']);
  });
});
