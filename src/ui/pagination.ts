/**
 * Page sheets for reflowable reading surfaces.
 *
 * A PDF reader shows a stack of fixed-size pages; a reflowable document has
 * no pages of its own, so its blocks are flowed onto sheets of the same shape
 * (A4 proportion) and the reader gets the same thing to read: a page with
 * margins, a page number, and a page to turn to.
 *
 * Paragraphs are cut across page boundaries when they do not fit — snapped to
 * a word boundary, never inside a sentence — so a page fills to its margin
 * instead of stopping a third short. The geometry is measured in the browser
 * rather than assumed: the nominal sheet height comes from the sheet's own
 * laid-out width, so sheets scale down on narrow screens exactly like the CSS
 * says and the packing budget always matches what the user sees.
 *
 * Re-packing must be idempotent, because it runs on every change to the
 * flow: before measuring, any cuts from the previous run are merged back
 * (`mergeContinuations`), so the planner always starts from the document's
 * real blocks and can lay them out differently for a new width or type size.
 */

/** Aspect of a printed page: height is this much of the width. */
const PAGE_ASPECT = 297 / 210;

const PAGE_CLASS = 'docpage';
const BODY_CLASS = 'docpage__body';

/**
 * Marker on a block piece whose paragraph continues on the next sheet: the
 * paragraph was cut, so the blank line the text carries between paragraphs
 * must not be counted after this block (the e2e stamps walker reads this).
 */
const SPLIT_MORE = 'doc-split-more';

/** Marker on every piece of a split paragraph after the first. */
const SPLIT_CONT = 'doc-split-cont';

/** Smallest cut worth making, in characters: a handful of words. */
const MIN_SPLIT_CHARS = 8;

/**
 * Pack blocks of the given heights onto pages of `budget` height.
 *
 * Returns one array of block indexes per page. Rules, in order of
 * importance: a block is never split across pages; a block that cannot fit
 * any page gets a page of its own; otherwise pages are filled greedily.
 *
 * A non-positive budget packs everything onto a single page. A surface that
 * cannot be measured (hidden, or a DOM with no layout at all) should not be
 * chopped into arbitrary page breaks — callers re-pack once it is visible.
 *
 * For paragraphs that may be cut across sheets, see `paginateFlow`.
 */
export function paginatePlan(heights: number[], budget: number): number[][] {
  const limit = budget > 0 ? budget : Infinity;
  const pages: number[][] = [];
  let page: number[] = [];
  let used = 0;
  for (const [index, height] of heights.entries()) {
    const h = Math.max(0, height);
    if (page.length > 0 && used + h > limit) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(index);
    used += h;
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

export interface FlowBlock {
  /** Outer height of the block, margins included. */
  height: number;
  /** Its text, so a cut can be snapped to a word boundary. */
  text: string;
  /**
   * Whether this block may be divided across sheets. Only paragraphs:
   * a heading or list item cut in half loses the shape that makes it one.
   */
  splittable: boolean;
}

/**
 * One piece of a block on one page. `end` is the absolute character offset
 * where the piece stops; omitted means "to the block's end" — the whole
 * block when it is its first piece, the tail when it is its last. The
 * pieces of a block arrive in order, one per page, starting a new page.
 */
export interface FlowPiece {
  index: number;
  end?: number;
}

/**
 * Cut `text` at the whitespace nearest `target` (at or before it, else the
 * next one after) so a piece never ends mid-word. Returns null when no cut
 * leaves `MIN_SPLIT_CHARS` characters on both sides.
 */
function snapCut(text: string, target: number): number | null {
  const maxHead = text.length - MIN_SPLIT_CHARS;
  if (maxHead < MIN_SPLIT_CHARS) return null;
  const from = Math.max(MIN_SPLIT_CHARS, Math.min(target, maxHead));
  for (let i = from; i >= MIN_SPLIT_CHARS; i--) {
    if (/\s/.test(text[i])) return i;
  }
  for (let i = from + 1; i <= maxHead; i++) {
    if (/\s/.test(text[i])) return i;
  }
  return null;
}

/**
 * Pack blocks onto pages, cutting paragraphs that cross a page boundary.
 *
 * A cut sits at a word boundary near the point where the page fills, so the
 * sheet's text column ends where the margin does instead of a third of the
 * sheet being left empty. The height attributed to a cut's remainder is
 * proportional to its characters — close enough for prose that the worst
 * case is a sheet growing by a line or two (sheets have no fixed height, so
 * nothing is ever clipped).
 *
 * Falls back to `paginatePlan`'s whole-block packing when the budget cannot
 * be measured or nothing is splittable.
 */
export function paginateFlow(
  blocks: FlowBlock[],
  budget: number,
  minSplit: number,
): FlowPiece[][] {
  const limit = budget > 0 ? budget : Infinity;
  if (!Number.isFinite(limit) || blocks.every(block => !block.splittable)) {
    return paginatePlan(blocks.map(block => block.height), budget)
      .map(page => page.map(index => ({ index }) as FlowPiece));
  }

  const pages: FlowPiece[][] = [];
  let page: FlowPiece[] = [];
  let used = 0;
  const flush = (): void => {
    pages.push(page);
    page = [];
    used = 0;
  };

  for (const [index, block] of blocks.entries()) {
    let height = block.height;
    let text = block.text;
    let start = 0;
    for (;;) {
      if (!block.splittable || !text) {
        if (page.length > 0 && used + height > limit) flush();
        page.push({ index });
        used += height;
        break;
      }
      if (used + height <= limit) {
        page.push({ index });
        used += height;
        break;
      }
      // Does not fit here. Cut it only when cutting leaves a worthwhile
      // piece: a fresh page always has the whole budget to fill, but a
      // sliver of leftover room would strand a couple of words on a sheet.
      const room = limit - used;
      const cut = (page.length === 0 || room >= minSplit) && room > 0
        ? snapCut(text, Math.floor(text.length * Math.min(1, room / height)))
        : null;
      if (cut !== null && cut < text.length) {
        page.push({ index, end: start + cut });
        flush();
        const fraction = cut / text.length;
        height *= 1 - fraction;
        text = text.slice(cut);
        start += cut;
        continue;
      }
      if (page.length > 0) {
        // No usable cut here: the remainder starts a fresh page.
        flush();
        continue;
      }
      // A whole page of room and still no cut: the block grows the sheet.
      page.push({ index });
      used = height;
      break;
    }
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

function setFirstText(root: Node, value: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (node) node.textContent = value;
}

/**
 * Cut a stamped run span at `offset` characters: the head keeps its range,
 * the returned clone carries the rest. Each run is a single text node (the
 * emitter wraps it in its optional bold/italic tags at most), so both
 * halves keep their wrappers by cloning before rewriting the text.
 */
function cutStampedRun(span: HTMLElement, offset: number): HTMLElement | null {
  const text = span.textContent ?? '';
  const [rawStart, rawEnd] = (span.dataset.off ?? '').split(':');
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (offset <= 0 || offset >= text.length || !Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  const tail = span.cloneNode(true) as HTMLElement;
  setFirstText(tail, text.slice(offset));
  tail.dataset.off = `${start + offset}:${end}`;
  setFirstText(span, text.slice(0, offset));
  span.dataset.off = `${start}:${start + offset}`;
  return tail;
}

/** The continuation element a cut leaves behind: same shape, no new chapter. */
function makeContinuation(source: HTMLElement): HTMLElement {
  const tail = document.createElement(source.tagName);
  source.classList.forEach(name => {
    if (name !== 'doc-chapter-start') tail.classList.add(name);
  });
  tail.classList.add(SPLIT_CONT);
  tail.removeAttribute('data-section-start');
  return tail;
}

/**
 * Cut the block's content at `rel` characters, leaving the head in place
 * and returning the continuation piece.
 *
 * Cuts land on a child boundary or inside a child that may be divided —
 * a stamped run (whose stamp is rewritten so the halves still tile) or a
 * plain text node. A child that may not be divided (a reader sentence —
 * cloning it would duplicate its identity) is never entered: the cut steps
 * back to before it, or reports null when that would leave an empty head.
 */
export function splitBlockAt(
  el: HTMLElement,
  rel: number,
): { tail: HTMLElement; cut: number } | null {
  if (rel <= 0) return null;
  const children = Array.from(el.childNodes);
  let acc = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const len = child.textContent?.length ?? 0;
    if (acc + len <= rel) {
      acc += len;
      continue;
    }
    // `rel` lands inside this child.
    const atBoundary = rel === acc;
    const cuttable = child.nodeType === Node.TEXT_NODE
      || (child.nodeType === Node.ELEMENT_NODE && (child as Element).hasAttribute('data-off'));
    if (!atBoundary && !cuttable && acc === 0) return null;
    const tail = makeContinuation(el);
    if (atBoundary || !cuttable) {
      for (const node of children.slice(i)) tail.appendChild(node);
    } else if (child.nodeType === Node.TEXT_NODE) {
      const rest = (child as Text).splitText(rel - acc);
      for (const node of [rest, ...children.slice(i + 1)]) tail.appendChild(node);
    } else {
      const run = cutStampedRun(child as HTMLElement, rel - acc);
      if (!run) return null;
      for (const node of [run, ...children.slice(i + 1)]) tail.appendChild(node);
    }
    el.classList.add(SPLIT_MORE);
    return { tail, cut: atBoundary || !cuttable ? acc : rel };
  }
  return null;
}

/** The container's blocks in reading order, flattening any page sheets. */
function flattenBlocks(container: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  for (const child of Array.from(container.children)) {
    if (child.classList.contains(PAGE_CLASS)) {
      const body = child.querySelector(`.${BODY_CLASS}`);
      if (body) blocks.push(...Array.from(body.children) as HTMLElement[]);
    } else {
      blocks.push(child as HTMLElement);
    }
  }
  return blocks;
}

/**
 * Undo every cut inside the container, so the next pack starts from the
 * document's real blocks.
 *
 * The pieces are merged in reading order rather than by sibling lookup: a
 * continuation always starts the sheet after its head, so within its own
 * body it has no previous sibling — only the flattened sequence knows which
 * block it belongs to. Chains merge in order, and the head loses its
 * "continues" marker because its paragraph ends there again.
 */
export function mergeContinuations(container: HTMLElement): number {
  let merged = 0;
  const kept: HTMLElement[] = [];
  for (const block of flattenBlocks(container)) {
    const head = kept[kept.length - 1];
    if (block.classList.contains(SPLIT_CONT) && head && head.tagName === block.tagName) {
      while (block.firstChild) head.appendChild(block.firstChild);
      head.classList.remove(SPLIT_MORE);
      block.remove();
      merged++;
    } else {
      kept.push(block);
    }
  }
  return merged;
}

export interface PagePagination {
  /** Re-flow the container's blocks into pages. Safe to call repeatedly. */
  layout(): void;
  /** How many sheets the last layout produced. */
  readonly pageCount: number;
  /** Stop observing the container. The blocks are left as they are. */
  destroy(): void;
}

/**
 * Flow the container's block children onto page sheets.
 *
 * The helper owns the container's children from here on: `layout()` unwraps
 * and re-wraps them, so callers render blocks into the container and then
 * paginate (and re-run `layout()` after anything that changes text flow,
 * like a font or type-size change).
 *
 * A ResizeObserver re-packs when the container's width changes — including
 * the moment a hidden surface becomes visible, which is when its geometry
 * first exists at all.
 */
export function paginateIntoPages(
  container: HTMLElement,
  options: { onPageCount?: (count: number) => void } = {},
): PagePagination {
  let destroyed = false;
  let pageCount = 0;
  /** Width the current pages were packed for; a change triggers a re-pack. */
  let packedWidth = -1;
  let frame: number | undefined;

  const collectBlocks = (): HTMLElement[] => flattenBlocks(container);

  const clearPages = (): void => {
    for (const page of Array.from(container.querySelectorAll(`:scope > .${PAGE_CLASS}`))) {
      page.remove();
    }
  };

  /** Outer height: the flow box plus its margins, which pack into the page. */
  const measure = (block: HTMLElement): number => {
    const style = getComputedStyle(block);
    return block.offsetHeight
      + (parseFloat(style.marginTop) || 0)
      + (parseFloat(style.marginBottom) || 0);
  };

  /**
   * Every block's outer height, measured in one pass.
   *
   * Long documents virtualise their blocks with `content-visibility: auto`,
   * which reports a stand-in size for anything off-screen — so real layout
   * is forced for the duration of the measurement and the inline override
   * comes straight back out again.
   */
  const measureAll = (blocks: HTMLElement[]): number[] => {
    for (const block of blocks) block.style.contentVisibility = 'visible';
    const heights = blocks.map(measure);
    for (const block of blocks) block.style.contentVisibility = '';
    return heights;
  };

  /**
   * The nominal sheet size and the height budget its content may fill:
   * the sheet's own width by the page aspect, minus the margins around the
   * text. Measured from a throwaway sheet so the numbers track whatever the
   * stylesheet actually does instead of duplicating it here.
   */
  const measurePage = (): { nominal: number; budget: number } => {
    const probe = document.createElement('div');
    probe.className = PAGE_CLASS;
    const body = document.createElement('div');
    body.className = BODY_CLASS;
    probe.appendChild(body);
    container.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    const style = getComputedStyle(probe);
    const chrome =
      (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
      + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    probe.remove();
    const nominal = Math.round(width * PAGE_ASPECT);
    return { nominal, budget: nominal - chrome };
  };

  /** Two lines of the current type: shorter cuts are not worth a break. */
  const minSplitFor = (blocks: HTMLElement[]): number => {
    const size = blocks.length ? parseFloat(getComputedStyle(blocks[0]).fontSize) : NaN;
    return (Number.isFinite(size) ? size : 16) * 1.65 * 2;
  };

  const layout = (): void => {
    if (destroyed) return;
    // Merge any cuts from the previous run first: this run may pack the
    // document differently (new width, new type size), and it can only plan
    // from whole blocks.
    mergeContinuations(container);
    const blocks = collectBlocks();
    const { nominal, budget } = measurePage();
    // Measure in place, before tearing the old sheets down: removing them
    // detaches the blocks, a detached element measures as zero, and a
    // zero-height document packs onto a single sheet that then never
    // re-splits. In place, blocks lay out at the width their new sheet
    // gives them, which is what the budget is computed from too.
    const heights = measureAll(blocks);
    const flow = paginateFlow(
      blocks.map((block, index) => ({
        height: heights[index],
        text: block.textContent ?? '',
        splittable: block.tagName === 'P',
      })),
      budget,
      minSplitFor(blocks),
    );
    clearPages();

    const sheets: HTMLElement[] = [];
    const open = new Map<number, { el: HTMLElement; start: number }>();
    const consumed = new Set<number>();
    for (const pieces of flow) {
      const sheet = document.createElement('div');
      sheet.className = PAGE_CLASS;
      sheet.setAttribute('role', 'group');
      if (nominal > 0) sheet.style.minHeight = `${nominal}px`;
      const body = document.createElement('div');
      body.className = BODY_CLASS;
      for (const piece of pieces) {
        if (consumed.has(piece.index)) continue;
        const state = open.get(piece.index);
        const el = state ? state.el : blocks[piece.index];
        const start = state ? state.start : 0;
        body.appendChild(el);
        if (piece.end === undefined) {
          consumed.add(piece.index);
          open.delete(piece.index);
          continue;
        }
        const rel = piece.end - start;
        const cut = rel > 0 ? splitBlockAt(el, rel) : null;
        if (!cut) {
          // No legal cut at this position (or none left): the piece is
          // whole, and the plan's later pieces for it have nothing to place.
          consumed.add(piece.index);
          open.delete(piece.index);
          continue;
        }
        open.set(piece.index, { el: cut.tail, start: start + cut.cut });
      }
      sheet.appendChild(body);
      container.appendChild(sheet);
      sheets.push(sheet);
    }

    pageCount = sheets.length;
    sheets.forEach((sheet, index) => {
      sheet.setAttribute('aria-label', `Page ${index + 1} of ${pageCount}`);
    });
    packedWidth = container.clientWidth;
    options.onPageCount?.(pageCount);
  };

  const scheduleLayout = (): void => {
    if (destroyed || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      layout();
    });
  };

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    // Layout changes the container's height, not its width, so comparing
    // widths keeps the observer from re-packing on its own output.
    if (destroyed || container.clientWidth === packedWidth) return;
    scheduleLayout();
  });
  observer?.observe(container);

  layout();

  return {
    layout,
    get pageCount() {
      return pageCount;
    },
    destroy() {
      destroyed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
    },
  };
}
