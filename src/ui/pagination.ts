/**
 * Page sheets for reflowable reading surfaces.
 *
 * A PDF reader shows a stack of fixed-size pages; a reflowable document has
 * no pages of its own, so its blocks are flowed onto sheets of the same shape
 * (A4 proportion) and the reader gets the same thing to read: a page with
 * margins, a page number, and a page to turn to. Blocks stay whole — a
 * paragraph is never cut in half at a page break — and a block taller than a
 * page (a long table, one enormous paragraph) simply grows its sheet.
 *
 * The geometry is measured in the browser rather than assumed: the nominal
 * sheet height comes from the sheet's own laid-out width, so sheets scale
 * down on narrow screens exactly like the CSS says and the packing budget
 * always matches what the user sees.
 */

/** Aspect of a printed page: height is this much of the width. */
const PAGE_ASPECT = 297 / 210;

const PAGE_CLASS = 'docpage';
const BODY_CLASS = 'docpage__body';

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

  const collectBlocks = (): HTMLElement[] => {
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
  };

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

  const layout = (): void => {
    if (destroyed) return;
    const blocks = collectBlocks();
    clearPages();
    const { nominal, budget } = measurePage();
    const heights = measureAll(blocks);
    for (const page of paginatePlan(heights, budget)) {
      const sheet = document.createElement('div');
      sheet.className = PAGE_CLASS;
      sheet.setAttribute('role', 'group');
      const body = document.createElement('div');
      body.className = BODY_CLASS;
      for (const index of page) body.appendChild(blocks[index]);
      sheet.appendChild(body);
      if (nominal > 0) sheet.style.minHeight = `${nominal}px`;
      container.appendChild(sheet);
    }
    pageCount = container.querySelectorAll(`:scope > .${PAGE_CLASS}`).length;
    container.querySelectorAll<HTMLElement>(`:scope > .${PAGE_CLASS}`).forEach((sheet, index) => {
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
