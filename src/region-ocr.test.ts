import { describe, expect, it } from 'vitest';
import {
  MIN_SELECTION_PX,
  intersect,
  isSelectionUsable,
  pickSurface,
  planCrop,
  rectFromPoints,
  regionSpeechText,
  type CaptureSurface,
  type SurfaceBounds,
} from './region-ocr';

/**
 * A 612×792 pt page as the viewer displays it: `zoom` CSS pixels per point,
 * and `dpr` backing pixels per CSS pixel. This is exactly the shape of a
 * PDF canvas — cssWidth includes the zoom, pixelWidth includes the dpr —
 * which is why the same fraction of the page must map to the same fraction
 * of the raster at every zoom.
 */
function shownPage(zoom: number, dpr = 2): CaptureSurface {
  return {
    cssWidth: 612 * zoom,
    cssHeight: 792 * zoom,
    pixelWidth: Math.round(612 * zoom * dpr),
    pixelHeight: Math.round(792 * zoom * dpr),
  };
}

describe('rectFromPoints', () => {
  it('normalises a drag in every direction to a positive rectangle', () => {
    const expected = { x: 10, y: 20, width: 30, height: 40 };
    expect(rectFromPoints({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected);
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected);
    expect(rectFromPoints({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected);
    expect(rectFromPoints({ x: 10, y: 60 }, { x: 40, y: 20 })).toEqual(expected);
  });
});

describe('isSelectionUsable', () => {
  it('rejects a click and accepts a deliberate box', () => {
    expect(isSelectionUsable({ x: 0, y: 0, width: MIN_SELECTION_PX - 1, height: 200 })).toBe(false);
    expect(isSelectionUsable({ x: 0, y: 0, width: 200, height: MIN_SELECTION_PX - 1 })).toBe(false);
    expect(isSelectionUsable({ x: 0, y: 0, width: MIN_SELECTION_PX, height: MIN_SELECTION_PX })).toBe(true);
  });
});

describe('intersect', () => {
  it('returns the overlap and null for a miss', () => {
    expect(intersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }))
      .toEqual({ x: 50, y: 50, width: 50, height: 50 });
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10, width: 10, height: 10 }))
      .toBeNull();
  });
});

describe('pickSurface', () => {
  const pages: SurfaceBounds[] = [
    { id: 0, left: 100, top: 100, width: 600, height: 800 },
    { id: 1, left: 100, top: 920, width: 600, height: 800 },
  ];

  it('returns the selection relative to the page it landed on', () => {
    expect(pickSurface(pages, { x: 200, y: 1000, width: 100, height: 50 }))
      .toEqual({ id: 1, rect: { x: 100, y: 80, width: 100, height: 50 } });
  });

  it('prefers the page holding most of a selection that crosses the gutter', () => {
    // 50 px on page 1, 130 px on page 2.
    expect(pickSurface(pages, { x: 300, y: 850, width: 200, height: 200 }))
      .toEqual({ id: 1, rect: { x: 200, y: 0, width: 200, height: 130 } });
  });

  it('returns null when the box is entirely in the gutter or off the pages', () => {
    expect(pickSurface(pages, { x: 100, y: 900, width: 600, height: 20 })).toBeNull();
    expect(pickSurface(pages, { x: 900, y: 100, width: 100, height: 100 })).toBeNull();
  });

  it('ignores zero-sized surfaces', () => {
    expect(pickSurface([{ id: 0, left: 0, top: 0, width: 0, height: 800 }],
      { x: 0, y: 0, width: 100, height: 100 })).toBeNull();
  });
});

describe('planCrop — zoom scaling', () => {
  it('maps the same page fraction to the same raster fraction at every zoom level', () => {
    for (const zoom of [0.6, 0.75, 1, 1.35, 2, 3]) {
      const surface = shownPage(zoom);
      const selection = {
        x: surface.cssWidth / 4,
        y: surface.cssHeight / 4,
        width: surface.cssWidth / 2,
        height: surface.cssHeight / 3,
      };
      const plan = planCrop(surface, selection, { padding: 0, minOutputWidth: 1 });
      expect(plan, `zoom ${zoom}`).not.toBeNull();
      const { source } = plan!;
      const expectedX = surface.pixelWidth / 4;
      const expectedWidth = surface.pixelWidth / 2;
      // Outward rounding may add at most one source pixel per edge.
      expect(Math.abs(source.x - expectedX), `x at zoom ${zoom}`).toBeLessThanOrEqual(1);
      expect(Math.abs(source.width - expectedWidth), `width at zoom ${zoom}`).toBeLessThanOrEqual(2);
      expect(source.x).toBeGreaterThanOrEqual(0);
      expect(source.y).toBeGreaterThanOrEqual(0);
      expect(source.x + source.width).toBeLessThanOrEqual(surface.pixelWidth);
      expect(source.y + source.height).toBeLessThanOrEqual(surface.pixelHeight);
    }
  });

  it('converts CSS coordinates at 200% zoom to backing pixels, not CSS pixels', () => {
    // 600×800 px of page shown at 2× with dpr 2: 2400×3200 backing pixels.
    const surface: CaptureSurface = {
      cssWidth: 1200,
      cssHeight: 1600,
      pixelWidth: 2400,
      pixelHeight: 3200,
    };
    const plan = planCrop(surface, { x: 100, y: 200, width: 300, height: 100 },
      { padding: 0, minOutputWidth: 1 });
    expect(plan!.source).toEqual({ x: 200, y: 400, width: 600, height: 200 });
    // Same box on a dpr-1 screen must take half as many backing pixels.
    const dpr1 = planCrop({ ...surface, pixelWidth: 1200, pixelHeight: 1600 },
      { x: 100, y: 200, width: 300, height: 100 }, { padding: 0, minOutputWidth: 1 });
    expect(dpr1!.source).toEqual({ x: 100, y: 200, width: 300, height: 100 });
  });

  it('copies 1:1 when the backing store matches the CSS box', () => {
    const surface: CaptureSurface = { cssWidth: 600, cssHeight: 800, pixelWidth: 600, pixelHeight: 800 };
    const plan = planCrop(surface, { x: 150, y: 200, width: 300, height: 100 },
      { padding: 0, minOutputWidth: 1 });
    expect(plan).toEqual({
      source: { x: 150, y: 200, width: 300, height: 100 },
      outputWidth: 300,
      outputHeight: 100,
      scale: 1,
    });
  });
});

describe('planCrop — crop sizing', () => {
  const surface: CaptureSurface = { cssWidth: 1000, cssHeight: 1000, pixelWidth: 1000, pixelHeight: 1000 };

  it('pads the box and clips the padding to the page edge', () => {
    const plan = planCrop(surface, { x: 0, y: 0, width: 100, height: 50 }, { padding: 10 });
    // The padding beyond the page's top-left corner is clipped, so only the
    // right and bottom margins widen the crop.
    expect(plan!.source).toEqual({ x: 0, y: 0, width: 110, height: 60 });
  });

  it('magnifies a small selection up to the cap so OCR has enough pixels', () => {
    const plan = planCrop(surface, { x: 0, y: 0, width: 100, height: 50 }, { minOutputWidth: 1200 });
    expect(plan!.scale).toBe(3);
    expect(plan!.outputWidth).toBe(300);
    expect(plan!.outputHeight).toBe(150);
  });

  it('magnifies a medium selection exactly to the minimum width', () => {
    const plan = planCrop(surface, { x: 0, y: 0, width: 600, height: 200 }, { minOutputWidth: 1200 });
    expect(plan!.outputWidth).toBe(1200);
    expect(plan!.outputHeight).toBe(400);
  });

  it('never exceeds the pixel budget for a whole large page', () => {
    const large: CaptureSurface = { cssWidth: 4000, cssHeight: 4000, pixelWidth: 5000, pixelHeight: 5000 };
    const plan = planCrop(large, { x: 0, y: 0, width: 4000, height: 4000 }, { minOutputWidth: 1 });
    expect(plan!.outputWidth * plan!.outputHeight).toBeLessThanOrEqual(12_000_000);
    expect(plan!.outputWidth).toBeGreaterThan(0);
    expect(plan!.outputHeight).toBeGreaterThan(0);
  });

  it('returns null for an empty surface, an empty selection, or a box off the page', () => {
    expect(planCrop({ ...surface, cssWidth: 0 }, { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(planCrop({ ...surface, pixelHeight: 0 }, { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(planCrop(surface, { x: 0, y: 0, width: 0, height: 10 })).toBeNull();
    expect(planCrop(surface, { x: 1200, y: 0, width: 10, height: 10 })).toBeNull();
  });
});

describe('regionSpeechText', () => {
  it('returns null for whitespace so the UI never speaks an empty clip', () => {
    expect(regionSpeechText('')).toBeNull();
    expect(regionSpeechText('   \n\t\r\n  ')).toBeNull();
  });

  it('returns null for punctuation-only OCR output', () => {
    expect(regionSpeechText('— · | • …')).toBeNull();
  });

  it('collapses layout whitespace into one speakable line', () => {
    expect(regionSpeechText('  Figure\n\n 3:\tValve   assembly \r\n')).toBe('Figure 3: Valve assembly');
  });

  it('keeps a region that contains any letter or digit', () => {
    expect(regionSpeechText('A1')).toBe('A1');
    expect(regionSpeechText('\u00a0Ω\n')).toBe('Ω');
  });
});
