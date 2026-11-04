import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MARGIN_OPTIONS,
  PAGE_NUMBER_KEY,
  detectPageMargins,
  loadHeaderFooterSuppression,
  normaliseMarginLine,
  saveHeaderFooterSuppression,
} from './header-footer';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => { data.clear(); },
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

function hostileStorage(): Storage {
  const fail = (): never => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  };
  return {
    get length(): number { return fail(); },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

/** The pages of a book whose header is `header` and whose body differs. */
function bookPages(count: number, header = 'The Big Book'): string[][] {
  return Array.from({ length: count }, (_, index) => [
    header,
    `Body text for page ${index + 1}.`,
    `More body text for page ${index + 1}.`,
    `Page ${index + 1}`,
  ]);
}

describe('normaliseMarginLine', () => {
  it('collapses whitespace and folds case', () => {
    expect(normaliseMarginLine('  The   BIG\tBook ')).toBe('the big book');
  });

  it('treats every plain page number as the same line', () => {
    for (const line of ['12', 'Page 12', 'Page 12 of 340', '12 of 340', '- 12 -', 'p. 12', '12 / 340']) {
      expect(normaliseMarginLine(line)).toBe(PAGE_NUMBER_KEY);
    }
  });

  it('does not merge headings that merely contain a number', () => {
    expect(normaliseMarginLine('Chapter 3')).toBe('chapter 3');
    expect(normaliseMarginLine('Chapter 4')).toBe('chapter 4');
    expect(normaliseMarginLine('Chapter 3')).not.toBe(normaliseMarginLine('Chapter 4'));
  });

  it('returns an empty key for blank lines', () => {
    expect(normaliseMarginLine('   ')).toBe('');
  });
});

describe('detectPageMargins', () => {
  it('drops a running header from every page after the first', () => {
    const pages = bookPages(5);
    const result = detectPageMargins(pages);
    expect(result.removed).toBe(8);
    expect(result.drop.map(page => page[0])).toEqual([false, true, true, true, true]);
    expect(result.recurring).toContain('the big book');
  });

  it('drops page-number footers even though the number changes every page', () => {
    const result = detectPageMargins(bookPages(5));
    expect(result.drop.map(page => page[3])).toEqual([false, true, true, true, true]);
    expect(result.recurring).toContain(PAGE_NUMBER_KEY);
  });

  it('keeps a line that appears on only two of five pages', () => {
    const pages = bookPages(5);
    // A chapter title appearing on pages 3 and 4 only.
    pages[2][0] = 'Chapter Two';
    pages[3][0] = 'Chapter Two';
    const result = detectPageMargins(pages);
    expect(result.drop[2][0]).toBe(false);
    expect(result.drop[3][0]).toBe(false);
  });

  it('never touches the first page, even when the header repeats everywhere', () => {
    const result = detectPageMargins(bookPages(6));
    expect(result.drop[0].every(value => value === false)).toBe(true);
  });

  it('does nothing at all on a three-page document', () => {
    const result = detectPageMargins(bookPages(3));
    expect(result.removed).toBe(0);
  });

  it('treats a page with one line as untouchable', () => {
    const pages = [
      ['Cover'],
      ['Confidential'],
      ['Confidential'],
      ['Confidential'],
      ['Confidential'],
    ];
    expect(detectPageMargins(pages).removed).toBe(0);
  });

  it('does not merge per-page chapter headings', () => {
    const pages = Array.from({ length: 6 }, (_, index) => [
      `Chapter ${index + 1}`,
      `Body text for page ${index + 1}.`,
      `More text for page ${index + 1}.`,
    ]);
    expect(detectPageMargins(pages).removed).toBe(0);
  });

  it('only removes margin lines, not a repeated line in the body', () => {
    const pages = Array.from({ length: 6 }, (_, index) => [
      'A header',
      `Opening ${index + 1}`,
      'Repeated body line',
      `Closing ${index + 1}`,
      'A footer',
    ]);
    const result = detectPageMargins(pages);
    expect(result.drop[1][2]).toBe(false);
    expect(result.drop[1][0]).toBe(true);
  });

  it('keeps top and bottom evidence separate', () => {
    const pages = Array.from({ length: 6 }, (_, index) => [
      index >= 1 ? 'Shared Words' : 'Title Page',
      `Body ${index + 1}`,
      'Middle line',
      `More ${index + 1}`,
      index === 4 ? 'Shared Words' : `Tail ${index + 1}`,
    ]);
    const result = detectPageMargins(pages);
    // Top occurrences on pages 2–6 qualify; the single bottom occurrence on
    // page 5 does not.
    expect(result.drop[1][0]).toBe(true);
    expect(result.drop[4][0]).toBe(true);
    expect(result.drop[4][4]).toBe(false);
  });

  it('leaves a page intact when every one of its lines looks like furniture', () => {
    const pages = Array.from({ length: 5 }, (_, index) => [
      'Running title',
      `Page ${index + 1}`,
    ]);
    expect(detectPageMargins(pages).removed).toBe(0);
  });

  it('ignores blank lines when measuring the margin band', () => {
    const pages = Array.from({ length: 6 }, (_, index) => [
      '',
      '  ',
      'A header',
      '',
      `Body ${index + 1}`,
      '',
      'Page ' + (index + 1),
      '',
    ]);
    const result = detectPageMargins(pages);
    expect(result.drop[1][2]).toBe(true);
    expect(result.drop[1][4]).toBe(false);
    expect(result.drop[1][6]).toBe(true);
    // Blank lines are never marked.
    expect(result.drop[1][0]).toBe(false);
    expect(result.drop[1][1]).toBe(false);
  });

  it('honours marginLines', () => {
    const pages = Array.from({ length: 6 }, (_, index) => [
      'Header',
      `Line ${index + 1}`,
      'Wider band line',
      `Line B${index + 1}`,
      `Line C${index + 1}`,
    ]);
    const narrow = detectPageMargins(pages);
    // "Wider band line" is the third line, outside the default two-line band.
    expect(narrow.drop[1][2]).toBe(false);

    const wide = detectPageMargins(pages, { marginLines: 3 });
    expect(wide.drop[1][2]).toBe(true);
  });

  it('honours minPageFraction for a document with many pages', () => {
    const pages = bookPages(10);
    // Remove the header from pages 2–5, leaving it on 4 of 9 pages.
    for (const page of pages.slice(5)) page[0] = 'Something else entirely';
    expect(detectPageMargins(pages).drop[1][0]).toBe(false);
    expect(detectPageMargins(pages, { minPageFraction: 0.4 }).drop[1][0]).toBe(true);
  });

  it('requires at least minPages of evidence regardless of fraction', () => {
    const pages = bookPages(6);
    expect(detectPageMargins(pages, { minPages: 6 }).drop[1][0]).toBe(false);
    expect(detectPageMargins(pages, { minPages: 4 }).drop[1][0]).toBe(true);
  });

  it('is case-insensitive about headers', () => {
    const pages = bookPages(6);
    for (const page of pages.slice(1)) page[0] = 'THE BIG BOOK';
    expect(detectPageMargins(pages).drop[1][0]).toBe(true);
  });

  it('returns one drop row per input page, including empty ones', () => {
    const result = detectPageMargins([[], [], [], []]);
    expect(result.drop).toHaveLength(4);
    expect(result.drop.every(row => row.length === 0)).toBe(true);
    expect(result.removed).toBe(0);
  });

  it('exposes conservative defaults', () => {
    expect(DEFAULT_MARGIN_OPTIONS).toEqual({
      marginLines: 2,
      minPageFraction: 0.6,
      minPages: 3,
    });
  });
});

describe('header/footer preference persistence', () => {
  it('defaults to suppression on', () => {
    expect(loadHeaderFooterSuppression(memoryStorage())).toBe(true);
    expect(loadHeaderFooterSuppression(hostileStorage())).toBe(true);
  });

  it('round-trips an explicit off', () => {
    const storage = memoryStorage();
    saveHeaderFooterSuppression(false, storage);
    expect(loadHeaderFooterSuppression(storage)).toBe(false);
    saveHeaderFooterSuppression(true, storage);
    expect(loadHeaderFooterSuppression(storage)).toBe(true);
  });

  it('falls back to on for corrupt records', () => {
    expect(loadHeaderFooterSuppression(memoryStorage({ 'yapper.header-footer.v1': '{oops' })))
      .toBe(true);
    expect(loadHeaderFooterSuppression(memoryStorage({ 'yapper.header-footer.v1': 'null' })))
      .toBe(true);
  });

  it('never throws when storage is unavailable', () => {
    expect(() => saveHeaderFooterSuppression(false, hostileStorage())).not.toThrow();
  });
});
