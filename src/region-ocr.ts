/**
 * Geometry and text handling for region OCR: the maths between "the reader
 * dragged a box over a page" and "crop these pixels, recognise them, speak
 * the result".
 *
 * Deliberately DOM-free. The one calculation that quietly ruins this feature
 * is the coordinate transform: the drag is measured in CSS pixels *after* the
 * page has been zoomed, while the pixels handed to Tesseract come from a
 * canvas backing store that is bigger than its CSS box by the device pixel
 * ratio. Slip a factor of the zoom in there and OCR still returns text — just
 * the wrong text — which is far harder to notice than an empty result. With
 * the transform here it can be asserted at every zoom level without a
 * browser, and the UI is left with nothing but measuring boxes.
 */

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

/** A drag shorter than this in either axis is a click, not a selection. */
export const MIN_SELECTION_PX = 8;

/**
 * Normalise a drag into a rectangle with non-negative width and height.
 *
 * The reader may drag in any of four directions, and a selection that only
 * works when dragged down-right feels broken half the time.
 */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Whether a drag is big enough to be worth sending to OCR. */
export function isSelectionUsable(rect: Rect, minimum = MIN_SELECTION_PX): boolean {
  return rect.width >= minimum && rect.height >= minimum;
}

/**
 * The overlap of two rectangles, or null when they do not touch.
 *
 * Used for both "which page is the reader selecting" and "clip the selection
 * to the page so the crop coordinates never go negative".
 */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** A rendered raster surface's box in client (viewport) coordinates. */
export interface SurfaceBounds {
  /** Caller's index; echoed back so the UI can find the element it measured. */
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PickedRegion {
  /** Index of the surface the selection belongs to. */
  id: number;
  /** The selection clipped to that surface, in surface-local CSS pixels. */
  rect: Rect;
}

/**
 * Choose the surface a selection belongs to: the one it overlaps most.
 *
 * A drag across a page boundary deliberately lands on the page holding most
 * of the box rather than refusing or reading two pages at once. Starting on
 * the white gutter beside a page still finds that page, because the overlap
 * only has to be non-zero.
 */
export function pickSurface(
  surfaces: readonly SurfaceBounds[],
  selection: Rect,
): PickedRegion | null {
  let best: PickedRegion | null = null;
  let bestArea = 0;
  for (const surface of surfaces) {
    if (!(surface.width > 0) || !(surface.height > 0)) continue;
    const overlap = intersect(selection, {
      x: surface.left,
      y: surface.top,
      width: surface.width,
      height: surface.height,
    });
    if (!overlap) continue;
    const area = overlap.width * overlap.height;
    if (area <= bestArea) continue;
    bestArea = area;
    best = {
      id: surface.id,
      rect: {
        x: overlap.x - surface.left,
        y: overlap.y - surface.top,
        width: overlap.width,
        height: overlap.height,
      },
    };
  }
  return best;
}

/**
 * A raster element as it is displayed: the CSS box the reader sees, and the
 * backing pixels that can actually be copied out of it.
 *
 * CSS size *includes* the current page zoom; backing size includes the device
 * pixel ratio. Their ratio is therefore exactly the factor between a drag
 * coordinate and a source pixel — no `scale` variable from the viewer needed,
 * and nothing to keep in sync when the reader zooms.
 */
export interface CaptureSurface {
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface CropOptions {
  /**
   * Extra CSS pixels around the selection. A box drawn tight to a line
   * shaves the ascenders and descenders, and Tesseract reads a clipped
   * letter as a different letter. Clipped to the surface.
   */
  padding?: number;
  /** Upscale small crops until they are at least this wide (before caps). */
  minOutputWidth?: number;
  /** Never magnify more than this; past it the blur outweighs the gain. */
  maxUpscale?: number;
  /** Hard ceiling on the OCR canvas so a full page at dpr 2 stays sane. */
  maxPixels?: number;
}

export interface CropPlan {
  /** Source rectangle in the surface's own pixel space. */
  source: Rect;
  /** Destination canvas size. */
  outputWidth: number;
  outputHeight: number;
  /** Destination pixels per source pixel. 1 copies, >1 magnifies for OCR. */
  scale: number;
}

const DEFAULT_MIN_OUTPUT_WIDTH = 1200;
const DEFAULT_MAX_UPSCALE = 3;
const DEFAULT_MAX_PIXELS = 12_000_000;

/**
 * Turn a selection measured in CSS pixels into a concrete crop.
 *
 * Rounds outward to whole source pixels (a half-covered edge pixel can hold
 * half a glyph), then chooses an output size: small selections are magnified
 * because Tesseract's models want roughly 20–30 px of text height, and very
 * large ones are held under a pixel budget because a 4K page at dpr 2 is a
 * ~130 MB RGBA buffer for no accuracy benefit.
 */
export function planCrop(
  surface: CaptureSurface,
  selection: Rect,
  options: CropOptions = {},
): CropPlan | null {
  if (!(surface.cssWidth > 0) || !(surface.cssHeight > 0)
    || !(surface.pixelWidth > 0) || !(surface.pixelHeight > 0)) {
    return null;
  }
  if (!(selection.width > 0) || !(selection.height > 0)) return null;

  const padding = Math.max(0, options.padding ?? 0);
  const minOutputWidth = Math.max(1, options.minOutputWidth ?? DEFAULT_MIN_OUTPUT_WIDTH);
  const maxUpscale = Math.max(1, options.maxUpscale ?? DEFAULT_MAX_UPSCALE);
  const maxPixels = Math.max(1, options.maxPixels ?? DEFAULT_MAX_PIXELS);

  const padded: Rect = {
    x: selection.x - padding,
    y: selection.y - padding,
    width: selection.width + padding * 2,
    height: selection.height + padding * 2,
  };
  const local = intersect(padded, { x: 0, y: 0, width: surface.cssWidth, height: surface.cssHeight });
  if (!local) return null;

  const ratioX = surface.pixelWidth / surface.cssWidth;
  const ratioY = surface.pixelHeight / surface.cssHeight;
  let left = Math.floor(local.x * ratioX);
  let top = Math.floor(local.y * ratioY);
  let right = Math.ceil((local.x + local.width) * ratioX);
  let bottom = Math.ceil((local.y + local.height) * ratioY);
  // Rounding must never push the box outside the image or produce a
  // zero-width source: drawImage with those arguments throws.
  left = Math.max(0, Math.min(surface.pixelWidth - 1, left));
  top = Math.max(0, Math.min(surface.pixelHeight - 1, top));
  right = Math.max(left + 1, Math.min(surface.pixelWidth, right));
  bottom = Math.max(top + 1, Math.min(surface.pixelHeight, bottom));

  const width = right - left;
  const height = bottom - top;
  let scale = Math.min(maxUpscale, Math.max(1, minOutputWidth / width));
  if (width * height * scale * scale > maxPixels) {
    scale = Math.sqrt(maxPixels / (width * height));
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  return {
    source: { x: left, y: top, width, height },
    outputWidth,
    outputHeight,
    scale: outputWidth / width,
  };
}

/**
 * Text worth speaking, or null when the region held nothing readable.
 *
 * OCR over an empty crop returns whitespace, and a punctuation-only crop
 * (a border, a bullet, an arrow) returns things like "· — |". Handing either
 * to speech gives a silent clip and a status that claims success; both are
 * the same failure, so the test is for an actual letter or digit. Line
 * breaks inside a region are layout, not pauses, so they collapse to one
 * space rather than reaching the synthesiser as gaps.
 */
export function regionSpeechText(raw: string): string | null {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  return text;
}
