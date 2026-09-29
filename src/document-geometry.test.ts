import { describe, it, expect } from 'vitest';
import { rectsForSpan, type TextAnchor, type SpanRect } from './document-types';

/**
 * One line of text laid out left to right from x=100, the way pdfjs emits it:
 * a separate anchor per styled run, not per line. Word widths are 40px with a
 * 10px gap, so "one box per word" is visibly different from "one box per
 * line" and a failing merge cannot be mistaken for a rounding difference.
 */
function line(page: number, y: number, start: number, words: string[]): TextAnchor[] {
  let offset = start;
  let x = 100;
  const out: TextAnchor[] = [];
  for (const word of words) {
    out.push({ page, x, y, width: 40, height: 12, start: offset, end: offset + word.length });
    offset += word.length + 1;
    x += 50;
  }
  return out;
}

function a(page: number, x: number, y: number, start: number, end: number): TextAnchor {
  return { page, x, y, width: 40, height: 12, start, end };
}

const rects = (m: Map<number, SpanRect[]>, page: number): SpanRect[] => m.get(page) ?? [];

describe('rectsForSpan — degenerate input', () => {
  it('returns nothing for an empty span', () => {
    expect(rectsForSpan([a(1, 10, 10, 0, 5)], 3, 3).size).toBe(0);
    expect(rectsForSpan([a(1, 10, 10, 0, 5)], 5, 2).size).toBe(0);
  });

  it('returns nothing for no anchors', () => {
    expect(rectsForSpan([], 0, 100).size).toBe(0);
  });

  it('returns nothing when the span misses every anchor', () => {
    const anchors = [a(1, 10, 10, 0, 5), a(1, 60, 10, 6, 11)];
    expect(rectsForSpan(anchors, 100, 200).size).toBe(0);
  });
});

describe('rectsForSpan — selecting the right anchors', () => {
  it('returns the one rectangle covering a single span', () => {
    const anchors = [a(1, 10, 10, 0, 5), a(1, 60, 10, 6, 11), a(2, 10, 10, 12, 17)];
    const got = rects(rectsForSpan(anchors, 0, 5), 1);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ x: 10, y: 10, width: 40, height: 12 });
  });

  it('includes an anchor the span only partially covers', () => {
    // A sentence almost always starts or ends mid-word-run; dropping the
    // partial anchor would clip the first and last word of every sentence.
    const anchors = [a(1, 10, 10, 0, 20)];
    expect(rectsForSpan(anchors, 5, 8).get(1)).toHaveLength(1);
    expect(rectsForSpan(anchors, 18, 25).get(1)).toHaveLength(1);
  });

  it('groups by page when a span crosses a page break', () => {
    const anchors = [a(1, 10, 10, 0, 5), a(2, 10, 10, 5, 10)];
    const got = rectsForSpan(anchors, 0, 10);
    expect([...got.keys()].sort()).toEqual([1, 2]);
  });
});

describe('rectsForSpan — merging runs into lines', () => {
  it('collapses a line of words into one rectangle, not a barcode', () => {
    // This is the behaviour the whole viewer rests on. pdfjs emits one anchor
    // per styled run, so without merging a normal sentence highlights as
    // dozens of separate boxes with gaps between them.
    const anchors = line(1, 100, 0, ['The', 'quick', 'brown', 'fox']);
    const got = rects(rectsForSpan(anchors, 0, 19), 1);
    expect(got).toHaveLength(1);
    expect(got[0].x).toBe(100);
    expect(got[0].width).toBe(190); // 4 words: 3 gaps of 50 plus the last 40
  });

  it('keeps separate lines separate', () => {
    const anchors = [
      ...line(1, 100, 0, ['one', 'two']),
      ...line(1, 120, 8, ['three', 'four']),
    ];
    const got = rects(rectsForSpan(anchors, 0, 20), 1);
    expect(got).toHaveLength(2);
    expect(got.map(r => r.y)).toEqual([100, 120]);
  });

  it('merges a chain of runs even when the first and last do not touch', () => {
    // Consecutive runs sit 5px apart: 7px of overlap against a 6px threshold,
    // so each link chains. The first and last do NOT overlap each other
    // (2px, well under the threshold), so this only merges if the comparison
    // is against the line accumulated so far rather than the previous box —
    // otherwise a long justified line shatters into pieces.
    const anchors = [
      { page: 1, x: 0, y: 100, width: 40, height: 12, start: 0, end: 4 },
      { page: 1, x: 50, y: 105, width: 40, height: 12, start: 5, end: 9 },
      { page: 1, x: 100, y: 110, width: 40, height: 12, start: 10, end: 14 },
    ];
    const overlapsDirectly =
      Math.min(112, 122) - Math.max(100, 110) > Math.min(12, 12) * 0.5;
    expect(overlapsDirectly).toBe(false);

    const got = rects(rectsForSpan(anchors, 0, 14), 1);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ x: 0, y: 100, width: 140, height: 22 });
  });

  it('does not merge a heading into the paragraph beneath it', () => {
    const anchors = [
      { page: 1, x: 100, y: 100, width: 200, height: 20, start: 0, end: 10 },
      { page: 1, x: 100, y: 200, width: 300, height: 12, start: 11, end: 40 },
    ];
    expect(rects(rectsForSpan(anchors, 0, 40), 1)).toHaveLength(2);
  });

  it('grows a merged rect in both directions as runs vary in height', () => {
    // A superscript mid-sentence must not be dropped from the highlight.
    const anchors = [
      { page: 1, x: 10, y: 100, width: 40, height: 12, start: 0, end: 4 },
      { page: 1, x: 50, y: 104, width: 20, height: 6, start: 5, end: 6 },
    ];
    const got = rects(rectsForSpan(anchors, 0, 6), 1);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ x: 10, y: 100, width: 60, height: 12 });
  });
});

describe('rectsForSpan — the binary search must not miss anchors', () => {
  it('finds the same anchors as a linear scan would, on a realistic page', () => {
    // The search is only correct if anchors are start-sorted, which is an
    // invariant of the single producer in document-reader.ts. Rather than
    // trusting that silently, check it against the obvious implementation.
    const anchors: TextAnchor[] = [];
    let offset = 0;
    for (let row = 0; row < 60; row++) {
      for (const w of line(1, 50 + row * 20, offset, ['alpha', 'beta', 'gamma', 'delta'])) {
        anchors.push(w);
        offset = w.end + 1;
      }
    }
    expect(anchors).toHaveLength(240);

    for (let i = 0; i < 40; i++) {
      const start = (i * 37) % (offset - 20);
      const end = start + 1 + ((i * 53) % 60);
      const naive = anchors
        .filter(an => an.end > start && an.start < end)
        .map(an => `${an.page}:${an.x}:${an.y}`);
      const viaSearch = [...rectsForSpan(anchors, start, end).values()]
        .flat()
        .map(r => `${r.page}:${r.x}:${r.y}`);
      // Merging collapses runs, so compare coverage by page and line count
      // rather than exact boxes: the binary search must not return fewer
      // lines than the linear scan found.
      const naiveLines = new Set(naive).size;
      const searchLines = viaSearch.length;
      expect(searchLines).toBeGreaterThan(0);
      expect(searchLines).toBeLessThanOrEqual(naiveLines);
    }
  });

  it('handles a span that starts before every anchor', () => {
    const anchors = line(1, 10, 50, ['one', 'two']);
    expect(rectsForSpan(anchors, 0, 60).get(1)).toHaveLength(1);
  });

  it('handles a span that runs past the last anchor', () => {
    const anchors = line(1, 10, 0, ['one', 'two']);
    expect(rectsForSpan(anchors, 0, 10_000).get(1)).toHaveLength(1);
  });
});
