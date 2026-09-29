/**
 * Outline extraction for the document side panel.
 *
 * Two sources feed the same shape: named sections (EPUB chapters, slides,
 * sheets) and real headings inside stamped markup. Both carry character
 * offsets already — `data-off` stamps and section ranges are produced during
 * extraction — so "jump to outline item" is a `goToOffset`, never a re-parse.
 */

export interface OutlineItem {
  title: string;
  /** 0 for sections, 1–6 for h1–h6 headings. */
  level: number;
  /** Character offset into the extracted text, when known. */
  start?: number;
  /** 1-based page number, when known (PDFs). */
  page?: number;
}

/** Named sections (chapters, slides, sheets) as flat top-level items. */
export function outlineFromSections(
  sections: Array<{ title: string; start: number; end: number }>,
): OutlineItem[] {
  return sections.map(section => ({
    title: section.title,
    level: 0,
    start: section.start,
  }));
}

/**
 * Headings from stamped markup, keeping their nesting level.
 *
 * A heading without a `data-off` stamp cannot be jumped to and is skipped
 * rather than rendered as a dead entry in a panel whose whole job is jumping.
 */
export function outlineFromHtml(html: string): OutlineItem[] {
  if (typeof DOMParser === 'undefined') return [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return [];
  }
  const items: OutlineItem[] = [];
  for (const el of Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    const stamp = el.getAttribute('data-off');
    const match = stamp ? /^(\d+):(\d+)$/.exec(stamp) : null;
    const title = (el.textContent ?? '').trim();
    if (!match || !title) continue;
    items.push({
      title,
      level: Number(el.tagName.slice(1)),
      start: Number(match[1]),
    });
  }
  return items;
}

/**
 * Merge heading and section outlines without duplicates.
 *
 * When both exist, headings win: they are the document's real structure.
 * Sections alone still make a usable outline (slides and sheets have no
 * headings), and neither alone means no outline at all.
 */
export function buildOutline(
  html: string | undefined,
  sections: Array<{ title: string; start: number; end: number }> | undefined,
): OutlineItem[] {
  const headings = html ? outlineFromHtml(html) : [];
  if (headings.length) {
    return headings.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }
  return sections?.length ? outlineFromSections(sections) : [];
}

/** Index of the item `offset` falls inside (the last one starting at or before it). */
export function outlineIndexForOffset(outline: OutlineItem[], offset: number): number {
  let found = -1;
  for (let i = 0; i < outline.length; i++) {
    const start = outline[i].start;
    if (start === undefined) continue;
    if (start <= offset) found = i;
    else break;
  }
  return found;
}

/** Index of the first item on `page`, for PDFs whose outline carries pages. */
export function outlineIndexForPage(outline: OutlineItem[], page: number): number {
  return outline.findIndex(item => item.page === page);
}

/**
 * Index of the outline item `page` falls inside: the last item whose page is
 * at or before it. Exact matches win; between two entries the earlier one is
 * still "where the reader is".
 */
export function outlineIndexForPageNear(outline: OutlineItem[], page: number): number {
  const exact = outlineIndexForPage(outline, page);
  if (exact >= 0) return exact;
  let found = -1;
  for (let i = 0; i < outline.length; i++) {
    const itemPage = outline[i].page;
    if (itemPage !== undefined && itemPage <= page) found = i;
  }
  return found;
}
