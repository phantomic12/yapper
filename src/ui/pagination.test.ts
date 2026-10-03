import { afterEach, describe, expect, it, vi } from 'vitest';
import { paginateIntoPages, paginatePlan } from './pagination';

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
