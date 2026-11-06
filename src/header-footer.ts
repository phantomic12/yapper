// ─── Running header / footer suppression ─────────────────────────
// A scanned or printed book repeats the same furniture on every page: the
// title at the top, the chapter name, "Page 12 of 340" at the bottom. Read
// aloud start to finish, that furniture is noise — it is not part of the
// argument, and a synthesizer dutifully announcing "Page 13 of 340" between
// every two paragraphs makes a long document unlistenable.
//
// The detection has to be conservative in one direction only. Missing a
// running header costs a few spoken words; deleting a real line loses
// content the reader cannot get back by re-listening. So a line is only
// removed when ALL of these hold:
//
//   * it appears in the top or bottom margin band of most pages — at least
//     60% of the pages after the first, and never fewer than three of them;
//   * the occurrences are in the same band (a title at the top is not
//     corroborated by the same words at the bottom);
//   * the page has more than one line, so a page is never emptied;
//   * the page is not the document's first page. A title page looks exactly
//     like a running header by frequency, and "most pages" starts at page
//     two for that reason.
//
// Page numbers are the one thing normalised away: "Page 12 of 340" and
// "Page 13 of 340" are the same furniture, and comparing them literally
// would find no repetition at all. Nothing else is normalised — collapsing
// all digits would make "Chapter 3" and "Chapter 4" look identical and
// delete real headings.

/** A rectangle in scale-1 page space; structurally a pdfjs viewport box. */
export interface MarginSuppressionOptions {
  /**
   * Non-empty lines inspected at each edge. Two is enough for a title plus
   * a chapter line, and small enough that a body paragraph rarely lands in
   * the band by accident.
   */
  marginLines?: number;
  /** Fraction of pages (after the first) that must show the line. */
  minPageFraction?: number;
  /**
   * Absolute floor, applied both to the number of pages considered and to
   * the recurrence count. A three-page document is too short to prove that
   * anything is furniture.
   */
  minPages?: number;
}

export interface MarginSuppressionResult {
  /** drop[page][line] — true when the line is repeating page furniture. */
  drop: boolean[][];
  /** Normalised keys removed, for a progress/debug message. */
  recurring: string[];
  /** Total number of lines marked for removal. */
  removed: number;
}

export const DEFAULT_MARGIN_OPTIONS: Required<MarginSuppressionOptions> = {
  marginLines: 2,
  minPageFraction: 0.6,
  minPages: 3,
};

/** The key a pure page number normalises to, whatever the number was. */
export const PAGE_NUMBER_KEY = '#page';

// Only shapes that are unambiguously a page number. "Page 12", "12",
// "12 of 340", "- 12 -", "p. 12", "12 / 340". Anything with other words in
// it is left alone, so "Chapter 12" stays distinct from "Chapter 13".
const PAGE_NUMBER_PATTERNS: readonly RegExp[] = [
  /^\d{1,5}$/,
  /^page \d{1,5}( of \d{1,5})?$/,
  /^\d{1,5} of \d{1,5}$/,
  /^p\.? ?\d{1,5}$/,
  /^[-–—] ?\d{1,5} ?[-–—]$/,
  /^\d{1,5} ?\/ ?\d{1,5}$/,
];

/**
 * The comparable form of a margin line: whitespace collapsed, lowercased,
 * and pure page numbers replaced by one shared key.
 *
 * Lowercasing makes "THE BIG BOOK" and "The Big Book" the same header;
 * collapsing whitespace forgives the double spaces OCR inserts around
 * justified text.
 */
export function normaliseMarginLine(line: string): string {
  const clean = line.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!clean) return '';
  for (const pattern of PAGE_NUMBER_PATTERNS) {
    if (pattern.test(clean)) return PAGE_NUMBER_KEY;
  }
  return clean;
}

interface Occurrence {
  page: number;
  line: number;
}

/**
 * Mark repeating header/footer lines for removal.
 *
 * `pages` is the document as extracted: one array of lines per page, in
 * reading order. Blank lines are ignored as candidates, which is what makes
 * this work for both the text layer (where a blank line is a paragraph gap)
 * and OCR (where it is a detection failure).
 */
export function detectPageMargins(
  pages: readonly (readonly string[])[],
  options: MarginSuppressionOptions = {},
): MarginSuppressionResult {
  const marginLines = Math.max(1, options.marginLines ?? DEFAULT_MARGIN_OPTIONS.marginLines);
  const minPages = Math.max(2, options.minPages ?? DEFAULT_MARGIN_OPTIONS.minPages);
  const fraction = options.minPageFraction ?? DEFAULT_MARGIN_OPTIONS.minPageFraction;

  const drop = pages.map(page => page.map(() => false));
  const empty: MarginSuppressionResult = { drop, recurring: [], removed: 0 };

  // The first page is exempt — see the header comment. Counting starts
  // there too, so a three-page document never has enough evidence.
  const considered = pages.slice(1);
  if (considered.length < minPages) return empty;
  const required = Math.max(minPages, Math.ceil(considered.length * fraction));

  // Key includes the band: the same words at the top and at the bottom are
  // two different pieces of furniture, and one must not corroborate the
  // other.
  const buckets = new Map<string, { occurrences: Occurrence[]; pages: Set<number> }>();
  const record = (key: string, occurrence: Occurrence): void => {
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.occurrences.push(occurrence);
      bucket.pages.add(occurrence.page);
    } else {
      buckets.set(key, { occurrences: [occurrence], pages: new Set([occurrence.page]) });
    }
  };

  considered.forEach((lines, index) => {
    const page = index + 1;
    const occupied: number[] = [];
    lines.forEach((line, lineIndex) => {
      if (line.trim()) occupied.push(lineIndex);
    });
    // A page with one line has no margin to spare: removing it would leave
    // an empty page, and the line might be the only content on it.
    if (occupied.length <= 1) return;

    const top = new Set(occupied.slice(0, marginLines));
    const bottom = new Set(occupied.slice(-marginLines));
    for (const lineIndex of occupied) {
      const inTop = top.has(lineIndex);
      const inBottom = bottom.has(lineIndex);
      if (!inTop && !inBottom) continue;
      const key = normaliseMarginLine(lines[lineIndex]);
      if (!key) continue;
      // A very short page can put one line in both bands; record it once
      // per band so both hypotheses get the evidence. `record` keeps a Set
      // of pages, so repeating a line on one page cannot inflate the count.
      for (const band of [inTop ? 'top' : '', inBottom ? 'bottom' : '']) {
        if (!band) continue;
        record(`${band}\u0000${key}`, { page, line: lineIndex });
      }
    }
  });

  for (const bucket of buckets.values()) {
    if (bucket.pages.size < required) continue;
    for (const occurrence of bucket.occurrences) {
      drop[occurrence.page][occurrence.line] = true;
    }
  }

  // Belt and braces for the "never empty a page" rule: if a page somehow
  // ended up with every line marked (a header and footer on a two-line
  // page), keep the page intact rather than emitting nothing for it.
  pages.forEach((lines, pageIndex) => {
    const occupied = lines.map((line, lineIndex) => (line.trim() ? lineIndex : -1))
      .filter(lineIndex => lineIndex >= 0);
    if (!occupied.length) return;
    if (occupied.every(lineIndex => drop[pageIndex][lineIndex])) {
      drop[pageIndex] = lines.map(() => false);
    }
  });

  let removed = 0;
  const recurring: string[] = [];
  pages.forEach((lines, pageIndex) => {
    lines.forEach((line, lineIndex) => {
      if (!drop[pageIndex][lineIndex]) return;
      removed += 1;
      const key = normaliseMarginLine(line);
      if (key && !recurring.includes(key)) recurring.push(key);
    });
  });
  return { drop, recurring: recurring.sort(), removed };
}

// ─── Persistence ─────────────────────────────────────────────────
// One preference, stored next to the algorithm. Best-effort like every other
// setting: if storage is unavailable, suppression stays on (the conservative
// default) and the reader can turn it off again in this session.

const STORAGE_KEY = 'yapper.header-footer.v1';

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether repeating headers/footers should be dropped. Defaults to true. */
export function loadHeaderFooterSuppression(storage?: Storage): boolean {
  const store = resolveStorage(storage);
  if (!store) return true;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return true;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'strip' in parsed) {
      return (parsed as { strip?: unknown }).strip !== false;
    }
    return true;
  } catch {
    return true;
  }
}

export function saveHeaderFooterSuppression(enabled: boolean, storage?: Storage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ strip: enabled }));
  } catch {
    // Quota / private mode — best-effort.
  }
}

export const HEADER_FOOTER_STORAGE_KEY = STORAGE_KEY;
