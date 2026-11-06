import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextAnchor } from './document-types';
import { documentProgressKey } from './persistence';
import {
  MIN_REGION_SIZE,
  buildReadingPlan,
  clampRect,
  createRegion,
  isReadableKind,
  isRegionUsable,
  loadReadingRegions,
  moveRegion,
  nextRegionId,
  pageAtPoint,
  pageSizeOf,
  parseStoredRegions,
  pointToPagePoint,
  readingRegionsKey,
  readingRegionsKeyForDocumentKey,
  rectFromPoints,
  regionClientBox,
  regionForAnchor,
  regionPages,
  regionsForPage,
  removeRegion,
  reorderRegion,
  saveReadingRegions,
  serializeRegions,
  setRegionKind,
  type ReadingPageBox,
  type ReadingRegion,
} from './reading-regions';

// ─── Helpers ─────────────────────────────────────────────────────

function anchor(
  page: number,
  x: number,
  y: number,
  width: number,
  height: number,
  start: number,
  end: number,
): TextAnchor {
  return { page, x, y, width, height, start, end };
}

function region(
  id: string,
  page: number,
  kind: ReadingRegion['kind'],
  x: number,
  y: number,
  width: number,
  height: number,
): ReadingRegion {
  return { id, page, kind, x, y, width, height };
}

/** Collapse whitespace: joining anchors may replace a newline with a space. */
function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function pageBox(page: number, left: number, top: number, width: number, height: number, scale: number): ReadingPageBox {
  return { page, left, top, width, height, scale };
}

/**
 * A two-column page: the left column's two lines, then the right sidebar's
 * one line, in the order the OCR engine saw them.
 */
const SOURCE = 'Left column first line.\nLeft column second line.\nSidebar note.';
const LEFT_ONE = { start: 0, end: 23 };
const LEFT_TWO = { start: 24, end: 48 };
const SIDEBAR = { start: 49, end: SOURCE.length };

const PAGE_ONE_ANCHORS: TextAnchor[] = [
  anchor(1, 10, 10, 180, 16, LEFT_ONE.start, LEFT_ONE.end),
  anchor(1, 10, 30, 180, 16, LEFT_TWO.start, LEFT_TWO.end),
  anchor(1, 240, 10, 100, 16, SIDEBAR.start, SIDEBAR.end),
];

const LEFT_BOX = { x: 0, y: 0, width: 200, height: 60 };
const SIDEBAR_BOX = { x: 220, y: 0, width: 140, height: 60 };

// ─── Rectangle maths ─────────────────────────────────────────────

describe('region rectangle maths', () => {
  it('normalises a drag in every direction', () => {
    const downRight = rectFromPoints({ x: 10, y: 20 }, { x: 40, y: 60 });
    const upLeft = rectFromPoints({ x: 40, y: 60 }, { x: 10, y: 20 });
    expect(downRight).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(upLeft).toEqual(downRight);
  });

  it('treats a tiny drag as a click and a real one as a box', () => {
    expect(isRegionUsable({ x: 0, y: 0, width: MIN_REGION_SIZE - 1, height: 40 })).toBe(false);
    expect(isRegionUsable({ x: 0, y: 0, width: 40, height: MIN_REGION_SIZE - 1 })).toBe(false);
    expect(isRegionUsable({ x: 0, y: 0, width: MIN_REGION_SIZE, height: MIN_REGION_SIZE })).toBe(true);
  });

  it('keeps a rectangle on the page', () => {
    expect(clampRect({ x: -20, y: -5, width: 50, height: 30 }, { width: 100, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 50, height: 30 });
    expect(clampRect({ x: 80, y: 90, width: 50, height: 30 }, { width: 100, height: 100 }))
      .toEqual({ x: 50, y: 70, width: 50, height: 30 });
    expect(clampRect({ x: 0, y: 0, width: 500, height: 500 }, { width: 100, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('finds the page under a point and rejects the gaps between pages', () => {
    const pages = [pageBox(1, 0, 0, 100, 200, 1), pageBox(2, 0, 220, 100, 200, 1)];
    expect(pageAtPoint(pages, 50, 100)?.page).toBe(1);
    expect(pageAtPoint(pages, 50, 230)?.page).toBe(2);
    expect(pageAtPoint(pages, 50, 210)).toBeNull();
    expect(pageAtPoint(pages, 500, 100)).toBeNull();
  });

  it('stores the same page-space rectangle at every zoom', () => {
    // The same physical spot on the page, measured at 1x and at 3x.
    const atOne = pageBox(1, 0, 0, 600, 800, 1);
    const atThree = pageBox(1, 0, 0, 1800, 2400, 3);
    const startOne = pointToPagePoint(atOne, 60, 120);
    const endOne = pointToPagePoint(atOne, 360, 240);
    const startThree = pointToPagePoint(atThree, 180, 360);
    const endThree = pointToPagePoint(atThree, 1080, 720);

    expect(rectFromPoints(startThree, endThree)).toEqual(rectFromPoints(startOne, endOne));
    expect(rectFromPoints(startOne, endOne)).toEqual({ x: 60, y: 120, width: 300, height: 120 });
  });

  it('draws a stored region back at the current zoom, offset by the page', () => {
    const stored = region('region-1', 1, 'main', 60, 120, 300, 120);
    const atOne = regionClientBox(stored, pageBox(1, 10, 20, 600, 800, 1));
    const atTwo = regionClientBox(stored, pageBox(1, 10, 20, 1200, 1600, 2));
    expect(atOne).toEqual({ x: 70, y: 140, width: 300, height: 120 });
    expect(atTwo).toEqual({ x: 130, y: 260, width: 600, height: 240 });
    // Page units at scale 1, regardless of the zoom it is painted at.
    expect(pageSizeOf(pageBox(1, 10, 20, 1200, 1600, 2))).toEqual({ width: 600, height: 800 });
  });

  it('guards against a zero scale rather than dividing by zero', () => {
    const broken = pageBox(1, 0, 0, 0, 0, 0);
    expect(pointToPagePoint(broken, 10, 10)).toEqual({ x: 10, y: 10 });
    expect(pageSizeOf(broken)).toEqual({ width: 0, height: 0 });
  });
});

// ─── Kinds ───────────────────────────────────────────────────────

describe('region kinds', () => {
  it('reads main and side text and excludes skip and figure', () => {
    expect(isReadableKind('main')).toBe(true);
    expect(isReadableKind('side')).toBe(true);
    expect(isReadableKind('skip')).toBe(false);
    expect(isReadableKind('figure')).toBe(false);
  });
});

// ─── Ordering and page filtering ─────────────────────────────────

describe('region ordering', () => {
  it('appends new regions to the end of their page, never to the top', () => {
    let regions = createRegion([], 1, 'main', LEFT_BOX);
    regions = createRegion(regions, 1, 'side', SIDEBAR_BOX);
    expect(regions.map(item => item.id)).toEqual(['region-1', 'region-2']);
    expect(regions.map(item => item.kind)).toEqual(['main', 'side']);
  });

  it('keeps ids deterministic across removals', () => {
    const regions = createRegion(createRegion([], 1, 'main', LEFT_BOX), 1, 'skip', SIDEBAR_BOX);
    const afterRemove = removeRegion(regions, 'region-2');
    expect(nextRegionId(afterRemove)).toBe('region-2');
    expect(createRegion(afterRemove, 1, 'side', SIDEBAR_BOX).map(item => item.id))
      .toEqual(['region-1', 'region-2']);
  });

  it('sorts a new region into page order without renumbering', () => {
    const two = createRegion([], 2, 'main', LEFT_BOX);
    const both = createRegion(two, 1, 'main', LEFT_BOX);
    expect(both.map(item => item.page)).toEqual([1, 2]);
    expect(both.map(item => item.id)).toEqual(['region-2', 'region-1']);
  });

  it('filters regions by page, preserving read order', () => {
    const regions = [
      region('region-1', 2, 'main', 0, 0, 10, 10),
      region('region-2', 1, 'main', 0, 0, 10, 10),
      region('region-3', 2, 'side', 0, 0, 10, 10),
    ];
    expect(regionsForPage(regions, 2).map(item => item.id)).toEqual(['region-1', 'region-3']);
    expect(regionsForPage(regions, 3)).toEqual([]);
    expect(regionPages(regions)).toEqual([1, 2]);
    expect(regionPages([])).toEqual([]);
  });

  it('moves a region within its page and refuses to cross a page boundary', () => {
    const regions = [
      region('region-1', 1, 'main', 0, 0, 10, 10),
      region('region-2', 1, 'side', 0, 0, 10, 10),
      region('region-3', 2, 'main', 0, 0, 10, 10),
    ];
    expect(moveRegion(regions, 'region-2', -1).map(item => item.id))
      .toEqual(['region-2', 'region-1', 'region-3']);
    // Already first: unchanged, and page 2 is untouched.
    expect(moveRegion(regions, 'region-1', -1).map(item => item.id))
      .toEqual(['region-1', 'region-2', 'region-3']);
    expect(moveRegion(regions, 'region-3', -1).map(item => item.id))
      .toEqual(['region-1', 'region-2', 'region-3']);
    expect(moveRegion(regions, 'missing', 1).map(item => item.id))
      .toEqual(['region-1', 'region-2', 'region-3']);
  });

  it('reorders by list position without disturbing other pages', () => {
    const regions = [
      region('a', 1, 'main', 0, 0, 10, 10),
      region('b', 1, 'main', 0, 0, 10, 10),
      region('c', 1, 'main', 0, 0, 10, 10),
      region('d', 2, 'main', 0, 0, 10, 10),
    ];
    expect(reorderRegion(regions, 1, 2, 0).map(item => item.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(reorderRegion(regions, 1, 0, 2).map(item => item.id)).toEqual(['b', 'c', 'a', 'd']);
    // Out of range is a no-op, not a throw.
    expect(reorderRegion(regions, 1, 0, 9).map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(reorderRegion(regions, 9, 0, 1).map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('changes a kind without touching anything else', () => {
    const regions = [region('a', 1, 'main', 0, 0, 10, 10)];
    expect(setRegionKind(regions, 'a', 'skip')[0].kind).toBe('skip');
    expect(setRegionKind(regions, 'missing', 'skip')[0].kind).toBe('main');
    expect(regions[0].kind).toBe('main');
  });
});

// ─── Which region owns a word ────────────────────────────────────

describe('region ownership', () => {
  it('uses the centre of the word box', () => {
    const regions = [region('a', 1, 'main', 0, 0, 100, 100)];
    expect(regionForAnchor(regions, { x: 70, y: 90, width: 40, height: 20 })?.id).toBe('a');
    expect(regionForAnchor(regions, { x: 100, y: 0, width: 40, height: 20 })).toBeNull();
  });

  it('gives an overlapping word to the first region in read order', () => {
    const regions = [
      region('first', 1, 'main', 0, 0, 100, 100),
      region('second', 1, 'skip', 0, 0, 200, 200),
    ];
    expect(regionForAnchor(regions, { x: 40, y: 40, width: 10, height: 10 })?.id).toBe('first');
    expect(regionForAnchor([...regions].reverse(), { x: 40, y: 40, width: 10, height: 10 })?.id)
      .toBe('second');
  });
});

// ─── The reading plan ────────────────────────────────────────────

describe('reading plan', () => {
  it('leaves text and anchors untouched when there are no regions', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, []);
    expect(plan.text).toBe(SOURCE);
    expect(plan.anchors).toEqual(PAGE_ONE_ANCHORS);
    expect(plan.runs).toEqual([]);
    expect(plan.skipped).toEqual([]);
    // A copy, so a caller rebasing the view's anchors cannot mutate the input.
    expect(plan.anchors).not.toBe(PAGE_ONE_ANCHORS);
  });

  it('leaves text untouched when there is nothing to anchor it to', () => {
    const plan = buildReadingPlan(SOURCE, [], [region('a', 1, 'skip', 0, 0, 10, 10)]);
    expect(plan.text).toBe(SOURCE);
    expect(plan.skipped).toEqual([]);
  });

  it('drops the text under a skip region', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, [
      region('sidebar', 1, 'skip', SIDEBAR_BOX.x, SIDEBAR_BOX.y, SIDEBAR_BOX.width, SIDEBAR_BOX.height),
    ]);
    expect(plan.text).not.toContain('Sidebar');
    expect(plan.text).toContain('Left column first line.');
    expect(plan.text).toContain('Left column second line.');
    expect(plan.skipped).toEqual([{ start: SIDEBAR.start, end: SIDEBAR.end }]);
  });

  it('drops a figure and keeps a main region on the same page', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, [
      region('main', 1, 'main', 0, 0, 220, 60),
      region('figure', 1, 'figure', 220, 0, 140, 60),
    ]);
    expect(plan.text).not.toContain('Sidebar');
    expect(plan.text).toContain('Left column');
  });

  it('reads regions in list order, not in page position', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, [
      region('sidebar', 1, 'side', 220, 0, 140, 60),
      region('body', 1, 'main', 0, 0, 220, 60),
    ]);
    expect(plan.text.indexOf('Sidebar')).toBeLessThan(plan.text.indexOf('Left column'));
    expect(plan.runs.map(run => run.regionId)).toEqual(['sidebar', 'body']);
  });

  it('reads pages in page order even when the region list is scrambled', () => {
    const source = 'Page one.\nPage two.';
    const anchors = [
      anchor(2, 0, 0, 80, 20, 10, 19),
      anchor(1, 0, 0, 80, 20, 0, 9),
    ];
    const plan = buildReadingPlan(source, anchors, [
      region('two', 2, 'main', 0, 0, 100, 100),
      region('one', 1, 'main', 0, 0, 100, 100),
    ]);
    expect(plan.text).toBe('Page one. Page two.');
    expect(plan.runs.map(run => run.page)).toEqual([1, 2]);
  });

  it('keeps text no region covers after that page’s regions', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, [
      region('body', 1, 'main', 0, 0, 220, 60),
    ]);
    // The sidebar has no region, so it is read — after the covered text.
    expect(squash(plan.text)).toBe(squash(SOURCE));
    expect(plan.runs.map(run => run.regionId)).toEqual(['body', undefined]);
    expect(plan.runs[1].start).toBe(SIDEBAR.start);
  });

  it('reports skipped ranges merged and sorted', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, [
      region('sidebar', 1, 'skip', 220, 0, 140, 60),
      region('body', 1, 'skip', 0, 0, 220, 60),
    ]);
    expect(plan.text).toBe('');
    // The newlines between anchors belong to no anchor, so the three spoken
    // ranges stay distinct rather than being glued across the gaps.
    expect(plan.skipped).toEqual([
      { start: LEFT_ONE.start, end: LEFT_ONE.end },
      { start: LEFT_TWO.start, end: LEFT_TWO.end },
      { start: SIDEBAR.start, end: SIDEBAR.end },
    ]);
  });

  it('rebases every anchor onto the produced text', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, [
      region('sidebar', 1, 'side', 220, 0, 140, 60),
      region('body', 1, 'main', 0, 0, 220, 60),
    ]);
    expect(plan.anchors).toHaveLength(3);
    for (const item of plan.anchors) {
      expect(plan.text.slice(item.start, item.end).trim().length).toBeGreaterThan(0);
      // Page geometry is untouched by the reorder.
      const original = PAGE_ONE_ANCHORS.find(candidate =>
        candidate.page === item.page && candidate.x === item.x && candidate.y === item.y);
      expect(original).toBeDefined();
    }
    expect(plan.anchors[0].start).toBe(0);
    expect(plan.text.slice(plan.anchors[0].start, plan.anchors[0].end)).toBe('Sidebar note.');
    // Anchors stay sorted by start, which the view's binary search relies on.
    const starts = plan.anchors.map(item => item.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('produces runs whose output ranges match the text', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, [
      region('body', 1, 'main', 0, 0, 220, 60),
      region('sidebar', 1, 'skip', 220, 0, 140, 60),
    ]);
    for (const run of plan.runs) {
      expect(squash(plan.text.slice(run.textStart, run.textEnd))).toBe(squash(SOURCE.slice(run.start, run.end)));
    }
  });

  it('clamps anchors that point past the end of the text', () => {
    const plan = buildReadingPlan('Short.', [anchor(1, 0, 0, 10, 10, 0, 999)], [
      region('all', 1, 'main', 0, 0, 50, 50),
    ]);
    expect(plan.text).toBe('Short.');
    expect(plan.anchors[0]).toMatchObject({ start: 0, end: 6 });
  });

  it('does not duplicate a word covered by two regions', () => {
    const plan = buildReadingPlan(SOURCE, PAGE_ONE_ANCHORS, [
      region('a', 1, 'main', 0, 0, 250, 60),
      region('b', 1, 'side', 200, 0, 200, 60),
    ]);
    expect(plan.text.match(/Sidebar/g)).toHaveLength(1);
    expect(plan.text.match(/Left column first line\./g)).toHaveLength(1);
  });
});

// ─── Persistence ─────────────────────────────────────────────────

const FILE = { name: 'scan.pdf', size: 4096, lastModified: 1_700_000_000_000 };

describe('reading-region persistence', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keys a document exactly like its reading progress', () => {
    const key = readingRegionsKey(FILE);
    expect(key.startsWith('yapper.reading-regions.v1:')).toBe(true);
    expect(key).toBe(readingRegionsKeyForDocumentKey(documentProgressKey(FILE)));
    expect(key).toContain(encodeURIComponent(FILE.name));
    expect(readingRegionsKeyForDocumentKey('unprefixed')).toBe('yapper.reading-regions.v1:unprefixed');
  });

  it('round-trips regions per page, in read order', () => {
    const regions = [
      region('region-1', 1, 'main', 10, 20, 100, 40),
      region('region-2', 1, 'skip', 200, 20, 80, 40),
      region('region-3', 2, 'side', 5, 6, 70, 30),
    ];
    const key = readingRegionsKey(FILE);
    saveReadingRegions(key, regions);
    expect(loadReadingRegions(key)).toEqual(regions);
  });

  it('groups pages on disk so one page can be replaced without touching another', () => {
    const stored = serializeRegions([
      region('a', 1, 'main', 0, 0, 10, 10),
      region('b', 2, 'side', 0, 0, 10, 10),
    ]);
    expect(Object.keys(stored.pages)).toEqual(['1', '2']);
    expect(stored.pages['2']).toHaveLength(1);
  });

  it('removes the record when the last region goes', () => {
    const key = readingRegionsKey(FILE);
    saveReadingRegions(key, [region('a', 1, 'main', 0, 0, 10, 10)]);
    expect(localStorage.getItem(key)).not.toBeNull();
    saveReadingRegions(key, []);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('returns no regions for a key that was never written', () => {
    expect(loadReadingRegions(readingRegionsKey(FILE))).toEqual([]);
    expect(loadReadingRegions(null)).toEqual([]);
  });

  it('survives corrupt records instead of throwing', () => {
    const key = readingRegionsKey(FILE);
    for (const raw of ['not json', '[]', '"string"', '{}', '{"pages":null}', '{"pages":[]}', 'null']) {
      localStorage.setItem(key, raw);
      expect(loadReadingRegions(key)).toEqual([]);
    }
  });

  it('drops entries that are not usable regions and keeps the rest', () => {
    const parsed = parseStoredRegions({
      pages: {
        '1': [
          { id: 'ok', kind: 'main', x: 1, y: 2, width: 3, height: 4 },
          { id: 'no-kind', kind: 'sidebar', x: 1, y: 2, width: 3, height: 4 },
          { id: 'nan', kind: 'main', x: Number.NaN, y: 2, width: 3, height: 4 },
          { id: 'infinite', kind: 'main', x: 1, y: Infinity, width: 3, height: 4 },
          { id: 'empty', kind: 'main', x: 1, y: 2, width: 0, height: 4 },
          { id: 'negative', kind: 'main', x: 1, y: 2, width: -3, height: 4 },
          { id: '', kind: 'skip', x: 1, y: 2, width: 3, height: 4 },
          null,
          'region',
        ],
        '0': [{ id: 'bad-page', kind: 'main', x: 1, y: 2, width: 3, height: 4 }],
        '-2': [{ id: 'bad-page-2', kind: 'main', x: 1, y: 2, width: 3, height: 4 }],
        'two': [{ id: 'bad-page-3', kind: 'main', x: 1, y: 2, width: 3, height: 4 }],
        '3': 'not an array',
      },
    });
    expect(parsed.map(item => item.id)).toEqual(['ok', 'region-1-7']);
    expect(parsed[0]).toMatchObject({ page: 1, kind: 'main', x: 1, y: 2, width: 3, height: 4 });
  });

  it('renames duplicate ids so every row is separately editable', () => {
    const parsed = parseStoredRegions({
      pages: {
        '1': [
          { id: 'same', kind: 'main', x: 0, y: 0, width: 10, height: 10 },
          { id: 'same', kind: 'main', x: 20, y: 0, width: 10, height: 10 },
        ],
      },
    });
    expect(parsed.map(item => item.id)).toEqual(['same', 'same-1']);
  });

  it('caps a page rather than trusting a huge record', () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      id: `r-${index}`, kind: 'main', x: 0, y: 0, width: 10, height: 10,
    }));
    expect(parseStoredRegions({ pages: { '1': many } })).toHaveLength(100);
  });

  it('never throws when the store refuses to write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => saveReadingRegions(readingRegionsKey(FILE), [
      region('a', 1, 'main', 0, 0, 10, 10),
    ])).not.toThrow();
  });

  it('never throws when the store refuses to read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(loadReadingRegions(readingRegionsKey(FILE))).toEqual([]);
  });
});
