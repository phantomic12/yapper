/**
 * Region OCR wiring: a "Select area" button next to the reader's other
 * controls, a drag-to-select layer over the rendered pages, a crop, and the
 * recognised text spoken through the reader's existing quick-read path.
 *
 * The selection layer is a fixed-position element over the page scroller
 * instead of ink drawn into the page. The page canvas is owned by
 * document-view.ts and is replaced on every zoom, page turn and theme change;
 * anything painted into it — or positioned inside it — disappears at the next
 * render. A sibling layer can be created, dragged and removed without the
 * viewer knowing it exists, which is also why this module needs no changes to
 * the viewer itself.
 *
 * Speech goes through ReadAloudController, the same utterance chain behind
 * ▶ Quick read, word lookup and Write's read-aloud. There is no second audio
 * path here: a region is short, and the quick-read voice works before any
 * model has been downloaded — which is exactly when a scanned page turns up.
 */

import { getOcrEngine } from '../ocr';
import { ReadAloudController } from './read-aloud';
import {
  isSelectionUsable,
  pickSurface,
  planCrop,
  rectFromPoints,
  regionSpeechText,
  type CaptureSurface,
  type CropPlan,
  type Point,
  type Rect,
  type SurfaceBounds,
} from '../region-ocr';

const BUTTON_ID = 'region-ocr-btn';
const STATUS_ID = 'region-ocr-status';

/** Extra CSS pixels around the drawn box so ascenders and descenders survive. */
const CROP_PADDING_PX = 6;

type RasterSurface = HTMLCanvasElement | HTMLImageElement;

/** The small slice of a speech path this feature needs. */
export interface RegionSpeaker {
  speak(text: string): void;
  stop(): void;
}

export interface RegionOcrOptions {
  /** Holds the mounted document view. Defaults to `#document-view`. */
  host?: HTMLElement | null;
  /** Trigger button. Defaults to `#region-ocr-btn`. */
  button?: HTMLButtonElement | null;
  /** Visible live region for instructions and results. Defaults to `#region-ocr-status`. */
  status?: HTMLElement | null;
  /** Overrides the speech path (tests, or a caller routing to another voice). */
  speaker?: RegionSpeaker;
  /** Overrides Tesseract (tests). */
  recognize?: (image: HTMLCanvasElement) => Promise<{ text: string }>;
  /** Overrides the canvas crop (tests). */
  crop?: (surface: RasterSurface, plan: CropPlan) => HTMLCanvasElement | null;
  /** Overrides which elements can be selected (tests). */
  surfaces?: () => RasterSurface[];
  /** Where the selection layer is mounted. Defaults to `document.body`. */
  layer?: HTMLElement | null;
}

export interface RegionOcrHandle {
  /** Detach listeners and tear down any open selection layer. */
  destroy(): void;
}

/**
 * Feature-local styles, injected instead of added to src/style.css.
 *
 * The layer exists only while a box is being drawn, so its rules travel with
 * the feature that owns them; keeping them out of the shared stylesheet also
 * keeps this work clear of the files several readers are editing at once.
 */
function ensureStyles(): void {
  if (document.querySelector('style[data-region-ocr]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-region-ocr', '');
  style.textContent = `
.region-ocr {
  position: fixed;
  z-index: 60;
  box-sizing: border-box;
  cursor: crosshair;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  background: rgba(10, 10, 20, 0.10);
  outline: 2px solid var(--accent, #6366f1);
  outline-offset: -2px;
}
.region-ocr:focus-visible { outline-offset: -4px; }
.region-ocr__hint {
  position: absolute;
  top: 10px;
  left: 50%;
  z-index: 1;
  transform: translateX(-50%);
  margin: 0;
  max-width: min(640px, calc(100% - 140px));
  padding: 7px 14px;
  border-radius: 999px;
  background: rgba(8, 8, 16, 0.88);
  color: #fff;
  font-size: 0.82rem;
  line-height: 1.35;
  text-align: center;
  pointer-events: none;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
}
.region-ocr__hint kbd {
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 4px;
  font: inherit;
  font-size: 0.78em;
}
.region-ocr__cancel {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.45);
  border-radius: 999px;
  background: rgba(8, 8, 16, 0.88);
  color: #fff;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
.region-ocr__cancel:hover { background: rgba(30, 30, 50, 0.95); }
.region-ocr__box {
  position: absolute;
  display: none;
  box-sizing: border-box;
  border: 2px solid var(--accent, #6366f1);
  background: rgba(99, 102, 241, 0.20);
  box-shadow: 0 0 0 9999px rgba(8, 8, 16, 0.30);
  pointer-events: none;
}
.region-ocr__status {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  font-size: 0.78rem;
  line-height: 1.3;
  color: var(--text-muted);
}
.region-ocr__status:empty { display: none; }
`;
  document.head.appendChild(style);
}

function defaultSpeaker(announce: (message: string) => void): RegionSpeaker {
  const controller = new ReadAloudController({ onError: announce });
  return {
    speak: text => controller.speak([{ text }]),
    stop: () => controller.stop(),
  };
}

/**
 * Copy the planned region out of the on-screen raster.
 *
 * The page is painted white first because OCR reads transparent pixels as
 * black: a transparent PNG in an HTML document would otherwise arrive as
 * unreadable noise. Remote images taint the canvas and make drawImage throw,
 * which the caller reports as a normal failure rather than a crash.
 */
function cropToCanvas(surface: RasterSurface, plan: CropPlan): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = plan.outputWidth;
  canvas.height = plan.outputHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    surface,
    plan.source.x,
    plan.source.y,
    plan.source.width,
    plan.source.height,
    0,
    0,
    plan.outputWidth,
    plan.outputHeight,
  );
  return canvas;
}

/** The CSS box and the backing pixels of a canvas or image. */
function measureSurface(surface: RasterSurface): CaptureSurface {
  const box = surface.getBoundingClientRect();
  const canvas = surface.tagName === 'CANVAS' ? (surface as HTMLCanvasElement) : null;
  return {
    cssWidth: box.width,
    cssHeight: box.height,
    pixelWidth: canvas ? canvas.width : (surface as HTMLImageElement).naturalWidth,
    pixelHeight: canvas ? canvas.height : (surface as HTMLImageElement).naturalHeight,
  };
}

/**
 * Every raster on the rendered pages that could hold text.
 *
 * Canvases rather than `.docview__surface`, because the surface also carries
 * highlight boxes that drawImage cannot copy. Thumbnails live in their own
 * rail outside `.docview__pages`, so a mini page can never win the selection.
 * Tiny images are skipped: they are icons and rules, not content.
 */
function rasterSurfaces(pages: HTMLElement): RasterSurface[] {
  const found: RasterSurface[] = [
    ...Array.from(pages.querySelectorAll<HTMLCanvasElement>('canvas.docview__canvas')),
    ...Array.from(pages.querySelectorAll<HTMLImageElement>('img')),
  ];
  return found.filter(surface => {
    const box = surface.getBoundingClientRect();
    if (box.width < 24 || box.height < 16) return false;
    return surface.tagName === 'CANVAS'
      ? (surface as HTMLCanvasElement).width > 0 && (surface as HTMLCanvasElement).height > 0
      : (surface as HTMLImageElement).naturalWidth > 0
        && (surface as HTMLImageElement).naturalHeight > 0;
  });
}

/**
 * Bind the capture control. Returns a handle for teardown (mainly tests);
 * the app calls this once at boot and lets it live for the session.
 */
export function bindRegionOcr(options: RegionOcrOptions = {}): RegionOcrHandle {
  ensureStyles();

  const button = options.button ?? document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  const status = options.status ?? document.getElementById(STATUS_ID);
  if (status) {
    if (!status.hasAttribute('aria-live')) status.setAttribute('aria-live', 'polite');
    if (!status.hasAttribute('role')) status.setAttribute('role', 'status');
  }

  let overlay: HTMLDivElement | null = null;
  let dragStart: Point | null = null;
  let selection: Rect | null = null;
  let busy = false;
  let destroyed = false;
  let reposition: (() => void) | null = null;

  const announce = (message: string): void => {
    if (status) status.textContent = message;
  };

  const speaker = options.speaker ?? defaultSpeaker(announce);
  const recognize = options.recognize
    ?? ((image: HTMLCanvasElement) => getOcrEngine().recognize(image, { includeWords: false }));
  const crop = options.crop ?? cropToCanvas;

  function pagesElement(): HTMLElement | null {
    const host = options.host ?? document.getElementById('document-view');
    if (!host || host.hidden) return null;
    return host.querySelector<HTMLElement>('.docview__pages');
  }

  function setButtonState(): void {
    if (!button) return;
    const capturing = overlay !== null;
    button.textContent = capturing ? 'Cancel selection' : 'Select area';
    button.setAttribute('aria-pressed', String(capturing));
    button.disabled = busy && !capturing;
  }

  function endCapture(message?: string): void {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    dragStart = null;
    selection = null;
    document.removeEventListener('keydown', onKeyDown, true);
    if (reposition) window.removeEventListener('resize', reposition);
    reposition = null;
    setButtonState();
    try {
      button?.focus({ preventScroll: true });
    } catch {
      // Older engines ignore focus options; focus without them is enough.
      button?.focus();
    }
    if (message) announce(message);
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // Capture phase so Escape closes the selection even when the reader's
    // own document shortcuts would otherwise claim the key first.
    event.preventDefault();
    event.stopPropagation();
    endCapture('Area selection cancelled.');
  };

  function startCapture(): void {
    if (busy) {
      announce('Still reading the previous selection — one moment.');
      return;
    }
    if (overlay) return;
    const pages = pagesElement();
    if (!pages) {
      announce('Open a document in Document view to select an area.');
      return;
    }
    const box = pages.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) {
      announce('The document pages are not visible. Switch to Document view and try again.');
      return;
    }

    if ((options.surfaces?.() ?? rasterSurfaces(pages)).length === 0) {
      announce('There is no scanned page or picture to select here. Region reading works on the rendered document.');
      return;
    }
    // A new selection replaces whatever the last one was saying, the same
    // way starting a new quick read does.
    speaker.stop();

    const layer = document.createElement('div');
    layer.className = 'region-ocr';
    layer.tabIndex = -1;
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-label', 'Select an area to read');
    layer.setAttribute('aria-describedby', 'region-ocr-hint');
    layer.setAttribute('aria-keyshortcuts', 'Escape');
    layer.style.left = `${box.left}px`;
    layer.style.top = `${box.top}px`;
    layer.style.width = `${box.width}px`;
    layer.style.height = `${box.height}px`;
    layer.innerHTML = `
      <p class="region-ocr__hint" id="region-ocr-hint">Drag a box over the part you want read. <kbd>Esc</kbd> cancels.</p>
      <button class="region-ocr__cancel" type="button" data-role="region-ocr-cancel">Cancel</button>
      <div class="region-ocr__box" aria-hidden="true"></div>`;
    const boxEl = layer.querySelector<HTMLDivElement>('.region-ocr__box')!;

    const paint = (): void => {
      if (!selection) return;
      const place = layer.getBoundingClientRect();
      boxEl.style.display = 'block';
      boxEl.style.left = `${selection.x - place.left}px`;
      boxEl.style.top = `${selection.y - place.top}px`;
      boxEl.style.width = `${selection.width}px`;
      boxEl.style.height = `${selection.height}px`;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      // The layer's own Cancel button is not the start of a selection.
      if ((event.target as HTMLElement | null)?.closest('button')) return;
      event.preventDefault();
      dragStart = { x: event.clientX, y: event.clientY };
      selection = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
      paint();
      if (typeof layer.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
        try {
          layer.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is a convenience; the pointerup handler still
          // fires for drags that end inside the layer.
        }
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragStart) return;
      selection = rectFromPoints(dragStart, { x: event.clientX, y: event.clientY });
      paint();
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!dragStart) return;
      const dragged = rectFromPoints(dragStart, { x: event.clientX, y: event.clientY });
      dragStart = null;
      if (!isSelectionUsable(dragged)) {
        // Arguably a mis-click: stay in capture mode so the reader can try
        // again without hunting for the button.
        selection = null;
        boxEl.style.display = 'none';
        announce('That was a click, not a box. Drag across the text you want to hear.');
        return;
      }
      selection = null;
      endCapture();
      void readRegion(dragged);
    };

    reposition = (): void => {
      if (overlay !== layer) return;
      const pagesNow = pagesElement();
      if (!pagesNow) {
        endCapture('Area selection cancelled.');
        return;
      }
      const place = pagesNow.getBoundingClientRect();
      layer.style.left = `${place.left}px`;
      layer.style.top = `${place.top}px`;
      layer.style.width = `${place.width}px`;
      layer.style.height = `${place.height}px`;
      if (selection) paint();
    };

    layer.addEventListener('pointerdown', onPointerDown);
    layer.addEventListener('pointermove', onPointerMove);
    layer.addEventListener('pointerup', onPointerUp);
    layer.addEventListener('pointercancel', () => endCapture('Area selection cancelled.'));
    layer.querySelector<HTMLButtonElement>('[data-role="region-ocr-cancel"]')
      ?.addEventListener('click', () => endCapture('Area selection cancelled.'));

    (options.layer ?? document.body).appendChild(layer);
    overlay = layer;
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', reposition);
    setButtonState();
    layer.focus({ preventScroll: true });
    announce('Area selection on. Drag a box over the page; press Escape to cancel.');
  }

  async function readRegion(region: Rect): Promise<void> {
    if (destroyed || busy) return;
    const pages = pagesElement();
    if (!pages) {
      announce('Open a document in Document view to select an area.');
      return;
    }

    const elements = options.surfaces?.() ?? rasterSurfaces(pages);
    if (elements.length === 0) {
      announce('There is no scanned page or picture to read here.');
      return;
    }
    const bounds: SurfaceBounds[] = elements.map((surface, id) => {
      const box = surface.getBoundingClientRect();
      return { id, left: box.left, top: box.top, width: box.width, height: box.height };
    });
    const picked = pickSurface(bounds, region);
    if (!picked) {
      announce('That area is outside the page. Drag a box over the page itself.');
      return;
    }

    const surface = elements[picked.id];
    const plan = planCrop(measureSurface(surface), picked.rect, { padding: CROP_PADDING_PX });
    if (!plan) {
      announce('That selection is too small to read. Drag a larger box.');
      return;
    }

    busy = true;
    setButtonState();
    announce('Reading the selected area…');
    try {
      const image = crop(surface, plan);
      if (!image) throw new Error('the selected area could not be copied');
      const result = await recognize(image);
      // The view can be torn down while Tesseract is still crunching; by
      // then there is no reader to speak to.
      if (destroyed) return;
      const text = regionSpeechText(result.text);
      if (!text) {
        // The whole point of saying this out loud: an empty clip and a
        // success message would be worse than admitting the region failed.
        announce('Nothing readable in that area. Try a larger box, or one around clearer text.');
        return;
      }
      const words = text.split(/\s+/).length;
      announce(`Reading ${words} word${words === 1 ? '' : 's'} from the selection.`);
      speaker.speak(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      announce(`Could not read that area: ${detail}.`);
    } finally {
      busy = false;
      if (!destroyed) setButtonState();
    }
  }

  const onButtonClick = (): void => {
    if (overlay) {
      endCapture('Area selection cancelled.');
      return;
    }
    startCapture();
  };
  button?.addEventListener('click', onButtonClick);
  setButtonState();

  return {
    destroy(): void {
      destroyed = true;
      endCapture();
      speaker.stop();
      button?.removeEventListener('click', onButtonClick);
    },
  };
}
