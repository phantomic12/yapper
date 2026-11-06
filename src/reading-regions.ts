/**
 * Reading regions — the geometry, ordering and text selection behind
 * "this box is the main column, that one is a sidebar to skip".
 *
 * A scanned page is read by a machine that has no idea what a column is. It
 * hands back words in reading order as *it* saw them, which is very often the
 * wrong order for a page with a sidebar, a pull quote or a figure's caption.
 * A region is a rectangle the reader draws over the rendered page to say what
 * is there: main text, side text, skip, or figure. The regions on a page are
 * read in the order they are listed, and their text is what the reader speaks.
 *
 * Deliberately DOM-free. Three things here break silently when they are wrong,
 * and each is asserted in `reading-regions.test.ts` instead of being discovered
 * on a real scan:
 *
 *   * **Coordinates.** A box is stored in page units at scale 1 — the same
 *     convention as `TextAnchor` in document-types.ts — so a zoom, a fit-width
 *     or a device-pixel-ratio change cannot move it. The UI divides by the
 *     page's current scale on the way in and multiplies on the way out.
 *   * **Which region owns a word.** The centre of the word's box decides,
 *     and the first region in read order that contains it wins. Drawing two
 *     overlapping boxes must not duplicate or lose a word.
 *   * **The order text is spoken in.** Region order, not page coordinates.
 *     A right-hand column listed first is read first, which is the whole
 *     point of the feature.
 *
 * Persistence lives here too, next to the shape it stores. It is best-effort
 * by the same rule as the rest of the app: a full quota, a blocked store or a
 * corrupted record must never interrupt reading, so every storage call is
 * wrapped and a bad record degrades to "no regions".
 */

import type { TextAnchor } from './document-types';
import { documentProgressKey } from './persistence';

// ─── Kinds ───────────────────────────────────────────────────────

/**
 * What a region does to the text under it.
 *
 * `main` and `side` are both spoken, in read order: a side note the reader
 * wants after the body is a matter of ordering, not of exclusion. `skip` and
 * `figure` are never spoken — a skip is a sidebar, an ad or a page of another
 * article, and a figure is a decorative graphic whose caption the reader does
 * not want in the middle of a sentence.
 */
export type RegionKind = 'main' | 'side' | 'skip' | 'figure';

export const REGION_KINDS: readonly RegionKind[] = ['main', 'side', 'skip', 'figure'];

export const REGION_KIND_LABELS: Record<RegionKind, string> = {
  main: 'Main text',
  side: 'Side text',
  skip: 'Skip',
  figure: 'Figure',
};

/** Whether text under a region of this kind reaches the reader. */
export function isReadableKind(kind: RegionKind): boolean {
  return kind === 'main' || kind === 'side';
}

// ─── Geometry ────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One rectangle on one page.
 *
 * `x`/`y`/`width`/`height` are in page units at scale 1 — the coordinate space
 * of `TextAnchor`, i.e. `page.getViewport({ scale: 1 })`, top-left origin. That
 * is what makes a region survive a zoom: the numbers describe the page, not
 * the screen.
 */
export interface ReadingRegion extends Rect {
  id: string;
  /** 1-based page number. */
  page: number;
  kind: RegionKind;
}

/** A rendered page's live box on screen, for drawing over it. */
export interface ReadingPageBox {
  page: number;
  /** Client (viewport) pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** CSS pixels per page unit at scale 1 — the current zoom. */
  scale: number;
}

/** The smallest useful box, in page units. Below this a drag was a click. */
export const MIN_REGION_SIZE = 4;

/** Normalise a drag between two page-space points into a positive rectangle. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Whether a drawn rectangle is big enough to be a region rather than a click. */
export function isRegionUsable(rect: Rect, minimum = MIN_REGION_SIZE): boolean {
  return rect.width >= minimum && rect.height >= minimum;
}

/** Keep a rectangle on the page: no negative origin, no overflow past the edge. */
export function clampRect(rect: Rect, pageSize: { width: number; height: number }): Rect {
  const width = Math.max(0, Math.min(rect.width, pageSize.width));
  const height = Math.max(0, Math.min(rect.height, pageSize.height));
  return {
    x: Math.max(0, Math.min(rect.x, pageSize.width - width)),
    y: Math.max(0, Math.min(rect.y, pageSize.height - height)),
    width,
    height,
  };
}

/** The page under a client point, or null when the point is between pages. */
export function pageAtPoint(
  pages: readonly ReadingPageBox[],
  clientX: number,
  clientY: number,
): ReadingPageBox | null {
  for (const page of pages) {
    if (page.width <= 0 || page.height <= 0) continue;
    if (clientX < page.left || clientX > page.left + page.width) continue;
    if (clientY < page.top || clientY > page.top + page.height) continue;
    return page;
  }
  return null;
}

/** Client pixels → page units at scale 1. */
export function pointToPagePoint(page: ReadingPageBox, clientX: number, clientY: number): Point {
  const scale = page.scale > 0 ? page.scale : 1;
  return { x: (clientX - page.left) / scale, y: (clientY - page.top) / scale };
}

/** The page's size in page units at scale 1, derived from its rendered box. */
export function pageSizeOf(page: ReadingPageBox): { width: number; height: number } {
  const scale = page.scale > 0 ? page.scale : 1;
  return { width: page.width / scale, height: page.height / scale };
}

/** A region's box in client pixels, ready to position an element with. */
export function regionClientBox(region: ReadingRegion, page: ReadingPageBox): Rect {
  const scale = page.scale > 0 ? page.scale : 1;
  return {
    x: page.left + region.x * scale,
    y: page.top + region.y * scale,
    width: region.width * scale,
    height: region.height * scale,
  };
}

/** Region ids are deterministic — `region-1`, `region-2` — never random. */
export function nextRegionId(regions: readonly ReadingRegion[]): string {
  let highest = 0;
  for (const region of regions) {
    const match = /^region-(\d+)$/.exec(region.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `region-${highest + 1}`;
}

// ─── Ordering and page filtering ─────────────────────────────────

const byPageThenOrder = (a: ReadingRegion, b: ReadingRegion): number => a.page - b.page;

/** Regions on one page, in read order. Broken records are filtered upstream. */
export function regionsForPage(
  regions: readonly ReadingRegion[],
  page: number,
): ReadingRegion[] {
  return regions.filter(region => region.page === page);
}

/** The page numbers that carry at least one region, ascending. */
export function regionPages(regions: readonly ReadingRegion[]): number[] {
  return [...new Set(regions.map(region => region.page))].sort((a, b) => a - b);
}

/**
 * Append a region at the end of its page's read order.
 *
 * New boxes go last deliberately: the reader has just drawn a box, and
 * re-sorting by position would silently overrule the order they can see.
 */
export function createRegion(
  regions: readonly ReadingRegion[],
  page: number,
  kind: RegionKind,
  rect: Rect,
): ReadingRegion[] {
  const region: ReadingRegion = {
    id: nextRegionId(regions),
    page: Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1,
    kind,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
  // Page-major: a region added to page 1 sorts before one already on page 2,
  // and ids are never renumbered by the sort.
  return [...regions, region].sort(byPageThenOrder);
}

export function setRegionKind(
  regions: readonly ReadingRegion[],
  id: string,
  kind: RegionKind,
): ReadingRegion[] {
  let changed = false;
  const next = regions.map(region => {
    if (region.id !== id || region.kind === kind) return region;
    changed = true;
    return { ...region, kind };
  });
  return changed ? next : [...regions];
}

export function removeRegion(regions: readonly ReadingRegion[], id: string): ReadingRegion[] {
  const next = regions.filter(region => region.id !== id);
  return next.length === regions.length ? [...regions] : next;
}

/**
 * Move a region one place up or down **within its page**.
 *
 * Read order is page-major: page 2 is always read after page 1. A region
 * cannot be dragged past a page boundary because that would either renumber
 * pages or claim a page is read out of order, and neither is true. Returns the
 * same order when the move would leave the page.
 */
export function moveRegion(
  regions: readonly ReadingRegion[],
  id: string,
  delta: -1 | 1,
): ReadingRegion[] {
  const region = regions.find(item => item.id === id);
  if (!region) return [...regions];
  const page = regionsForPage(regions, region.page);
  const from = page.findIndex(item => item.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= page.length) return [...regions];
  return reorderRegion(regions, region.page, from, to);
}

/**
 * Move the region at `from` to `to` within one page's list.
 *
 * The page's slots in the global array are filled with the reordered list, so
 * other pages keep their own order and no region changes page. Indices are
 * positions within `regionsForPage`, which is what the list UI renders.
 */
export function reorderRegion(
  regions: readonly ReadingRegion[],
  page: number,
  from: number,
  to: number,
): ReadingRegion[] {
  const pageRegions = regionsForPage(regions, page);
  if (from === to || from < 0 || to < 0 || from >= pageRegions.length || to >= pageRegions.length) {
    return [...regions];
  }
  const reordered = pageRegions.slice();
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);

  let cursor = 0;
  return regions.map(region => (region.page === page ? reordered[cursor++] : region));
}

// ─── Which region owns which text ────────────────────────────────

/**
 * The first region in read order whose rectangle contains the anchor's centre.
 *
 * The centre rather than the whole box: a line of body text often overhangs a
 * hand-drawn sidebar box by a pixel or two, and requiring total containment
 * would leave that line in the page tail instead of where the reader meant it.
 */
export function regionForAnchor(
  regions: readonly ReadingRegion[],
  anchor: Pick<TextAnchor, 'x' | 'y' | 'width' | 'height'>,
): ReadingRegion | null {
  const cx = anchor.x + anchor.width / 2;
  const cy = anchor.y + anchor.height / 2;
  for (const region of regions) {
    if (cx < region.x || cx > region.x + region.width) continue;
    if (cy < region.y || cy > region.y + region.height) continue;
    return region;
  }
  return null;
}

/** A run of spoken text, and where it came from. */
export interface ReadingRun {
  page: number;
  /** Absent for text no region covers — the page's leftover text. */
  regionId?: string;
  kind?: RegionKind;
  /** Range in the source text. */
  start: number;
  end: number;
  /** Range in `ReadingPlan.text`. */
  textStart: number;
  textEnd: number;
}

export interface ReadingPlan {
  /** What the reader should speak, in read order. */
  text: string;
  /**
   * The anchors rebased onto `text`.
   *
   * Handing these back with the text is what keeps highlighting honest: a
   * highlight is drawn from character offsets, so reordered text with the old
   * offsets points at the wrong words. Each anchor keeps its page geometry and
   * gets the range its words now occupy.
   */
  anchors: TextAnchor[];
  runs: ReadingRun[];
  /** Source ranges left out because a skip or figure region covered them. */
  skipped: Array<{ start: number; end: number }>;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Turn a document plus its regions into the text the reader should speak.
 *
 * With no regions the source text and anchors come back untouched — that is
 * the overwhelmingly common case and it must stay byte-identical, or every
 * document without regions would pay for this feature with drifting offsets.
 *
 * With regions, pages are processed in page order (a reader cannot read page
 * two before page one) and, within a page, regions in list order. Text no
 * region covers follows that page's regions in its natural order: drawing one
 * box over a sidebar must not silently drop the rest of the page.
 */
export function buildReadingPlan(
  source: string,
  anchors: readonly TextAnchor[],
  regions: readonly ReadingRegion[],
): ReadingPlan {
  const untouched: ReadingPlan = {
    text: source,
    anchors: anchors.map(anchor => ({ ...anchor })),
    runs: [],
    skipped: [],
  };
  if (!source || regions.length === 0 || anchors.length === 0) return untouched;

  const pages = [...new Set([
    ...anchors.map(anchor => anchor.page),
  ])].sort((a, b) => a - b);

  const ordered: Array<{ anchor: TextAnchor; region: ReadingRegion | null }> = [];
  const skipped: Array<{ start: number; end: number }> = [];

  for (const page of pages) {
    const pageAnchors = anchors
      .filter(anchor => anchor.page === page)
      // Anchors arrive in document order, but a caller assembling a document
      // by hand may not have sorted them; within a region, source order is the
      // only defensible order.
      .sort((a, b) => a.start - b.start);
    const pageRegions = regionsForPage(regions, page);
    if (pageRegions.length === 0) {
      for (const anchor of pageAnchors) ordered.push({ anchor, region: null });
      continue;
    }

    const claimed = new Map<TextAnchor, ReadingRegion | null>();
    for (const anchor of pageAnchors) claimed.set(anchor, regionForAnchor(pageRegions, anchor));

    for (const region of pageRegions) {
      const inside = pageAnchors.filter(anchor => claimed.get(anchor) === region);
      if (!isReadableKind(region.kind)) {
        for (const anchor of inside) skipped.push({ start: anchor.start, end: anchor.end });
        continue;
      }
      for (const anchor of inside) ordered.push({ anchor, region });
    }
    for (const anchor of pageAnchors) {
      if (!claimed.get(anchor)) ordered.push({ anchor, region: null });
    }
  }

  let text = '';
  const rebased: TextAnchor[] = [];
  const runs: ReadingRun[] = [];
  for (const { anchor, region } of ordered) {
    const start = Math.max(0, Math.min(anchor.start, source.length));
    const end = Math.max(start, Math.min(anchor.end, source.length));
    const slice = source.slice(start, end);
    if (!slice) continue;
    if (text && !/\s$/.test(text) && !/^\s/.test(slice)) text += ' ';
    const textStart = text.length;
    text += slice;
    rebased.push({ ...anchor, start: textStart, end: text.length });

    const last = runs[runs.length - 1];
    const sameRun = last
      && last.page === anchor.page
      && last.regionId === region?.id;
    if (sameRun) {
      last.end = end;
      last.textEnd = text.length;
    } else {
      runs.push({
        page: anchor.page,
        ...(region ? { regionId: region.id, kind: region.kind } : {}),
        start,
        end,
        textStart,
        textEnd: text.length,
      });
    }
  }

  return { text, anchors: rebased, runs, skipped: mergeRanges(skipped) };
}

// ─── Persistence ─────────────────────────────────────────────────

/**
 * Regions are stored per document, keyed exactly like reading progress:
 * file identity, never content. The suffix is shared with
 * `documentProgressKey` so the two records can never disagree about which
 * file they belong to.
 */
const READING_REGIONS_PREFIX = 'yapper.reading-regions.v1:';

export function readingRegionsKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  const progress = documentProgressKey(file);
  return `${READING_REGIONS_PREFIX}${progress.slice(progress.indexOf(':') + 1)}`;
}

/** The same key, derived from a `yapper:reader-document` event's key. */
export function readingRegionsKeyForDocumentKey(documentKey: string): string {
  const separator = documentKey.indexOf(':');
  return `${READING_REGIONS_PREFIX}${separator === -1 ? documentKey : documentKey.slice(separator + 1)}`;
}

/** On-disk shape: page number → that page's regions, in read order. */
export interface StoredReadingRegions {
  pages: Record<string, ReadingRegion[]>;
}

const MAX_REGIONS_PER_PAGE = 100;
const MAX_REGIONS = 2000;

export function serializeRegions(regions: readonly ReadingRegion[]): StoredReadingRegions {
  const pages: Record<string, ReadingRegion[]> = {};
  for (const region of regions) {
    const key = String(region.page);
    (pages[key] ??= []).push({
      id: region.id,
      page: region.page,
      kind: region.kind,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    });
  }
  return { pages };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRegion(value: unknown, page: number, fallbackId: string): ReadingRegion | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<ReadingRegion>;
  if (!finite(entry.x) || !finite(entry.y) || !finite(entry.width) || !finite(entry.height)) return null;
  if (entry.width <= 0 || entry.height <= 0) return null;
  const kind = REGION_KINDS.includes(entry.kind as RegionKind)
    ? entry.kind as RegionKind
    : null;
  if (!kind) return null;
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : fallbackId,
    page,
    kind,
    x: Math.max(0, entry.x),
    y: Math.max(0, entry.y),
    width: entry.width,
    height: entry.height,
  };
}

/**
 * Parse a stored record, discarding anything that is not a region.
 *
 * A record written by a future version, a half-finished write or a user poking
 * at devtools must not take the editor (or the reader) down with it: every
 * field is checked, bad pages are skipped, and duplicate ids are renamed so
 * the list has one key per row.
 */
export function parseStoredRegions(raw: unknown): ReadingRegion[] {
  if (!raw || typeof raw !== 'object') return [];
  const pages = (raw as Partial<StoredReadingRegions>).pages;
  if (!pages || typeof pages !== 'object') return [];

  const regions: ReadingRegion[] = [];
  const seenIds = new Set<string>();
  const entries = Object.entries(pages as Record<string, unknown>)
    .map(([key, value]) => ({ page: Number(key), value }))
    .filter(entry => Number.isInteger(entry.page) && entry.page > 0)
    .sort((a, b) => a.page - b.page);

  for (const { page, value } of entries) {
    if (!Array.isArray(value)) continue;
    let taken = 0;
    for (const [index, item] of value.entries()) {
      if (taken >= MAX_REGIONS_PER_PAGE || regions.length >= MAX_REGIONS) break;
      const region = normalizeRegion(item, page, `region-${page}-${index + 1}`);
      if (!region) continue;
      // Ids are the row key in the list and the handle every edit uses; two
      // rows with one id would edit each other.
      let id = region.id;
      let suffix = 1;
      while (seenIds.has(id)) id = `${region.id}-${suffix++}`;
      seenIds.add(id);
      regions.push({ ...region, id });
      taken++;
    }
    if (regions.length >= MAX_REGIONS) break;
  }
  return regions;
}

/** Best-effort load: a blocked store, bad JSON or a wrong shape all mean "none". */
export function loadReadingRegions(key: string | null): ReadingRegion[] {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return parseStoredRegions(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Best-effort save. Quota, private mode and a disabled store are swallowed. */
export function saveReadingRegions(key: string | null, regions: readonly ReadingRegion[]): void {
  if (!key) return;
  try {
    if (regions.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(serializeRegions(regions)));
  } catch {
    // Persistence is a convenience; a full quota must not stop the reader.
  }
}
