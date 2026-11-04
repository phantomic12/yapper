import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindRegionOcr } from './region-ocr';
import type { CropPlan } from '../region-ocr';

function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

interface Fixture {
  host: HTMLElement;
  pages: HTMLElement;
  canvas: HTMLCanvasElement;
  button: HTMLButtonElement;
  status: HTMLElement;
}

/** A document view holding one rendered 600×800 CSS-pixel page. */
function mount(): Fixture {
  document.body.innerHTML = `
    <div id="document-view">
      <div class="docview__pages">
        <div class="docview__page">
          <div class="docview__surface"><canvas class="docview__canvas"></canvas></div>
        </div>
      </div>
    </div>
    <button id="region-ocr-btn" type="button">Select area</button>
    <span id="region-ocr-status"></span>`;
  const host = document.getElementById('document-view')!;
  const pages = host.querySelector<HTMLElement>('.docview__pages')!;
  const canvas = host.querySelector<HTMLCanvasElement>('canvas')!;
  canvas.width = 1200; // dpr 2 backing store
  canvas.height = 1600;
  pages.getBoundingClientRect = () => box(0, 0, 600, 800);
  canvas.getBoundingClientRect = () => box(0, 0, 600, 800);
  return {
    host,
    pages,
    canvas,
    button: document.getElementById('region-ocr-btn') as HTMLButtonElement,
    status: document.getElementById('region-ocr-status')!,
  };
}

function drag(layer: Element, from: [number, number], to: [number, number]): void {
  const events: Array<[string, [number, number]]> = [
    ['pointerdown', from],
    ['pointermove', to],
    ['pointerup', to],
  ];
  for (const [type, [clientX, clientY]] of events) {
    layer.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 }));
  }
}

describe('bindRegionOcr', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = mount();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('says plainly when nothing was recognised, and never speaks an empty clip', async () => {
    const recognize = vi.fn(async () => ({ text: ' \n\t • — ' }));
    const spoken: string[] = [];
    const handle = bindRegionOcr({
      speaker: { speak: text => spoken.push(text), stop: () => undefined },
      recognize,
      crop: () => document.createElement('canvas'),
    });

    fixture.button.click();
    const layer = document.querySelector('.region-ocr');
    expect(layer).not.toBeNull();
    expect(fixture.button.getAttribute('aria-pressed')).toBe('true');
    expect(layer!.getAttribute('role')).toBe('dialog');
    expect(layer!.getAttribute('aria-label')).toBe('Select an area to read');

    drag(layer!, [50, 50], [350, 250]);

    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(1));
    expect(spoken).toEqual([]);
    expect(fixture.status.textContent).toMatch(/nothing readable/i);
    expect(document.querySelector('.region-ocr')).toBeNull();
    expect(fixture.button.textContent).toBe('Select area');
    handle.destroy();
  });

  it('crops the selected region and speaks the cleaned text', async () => {
    const recognize = vi.fn(async () => ({ text: '  Figure\n 3: Valve assembly ' }));
    const spoken: string[] = [];
    const plans: CropPlan[] = [];
    const handle = bindRegionOcr({
      speaker: { speak: text => spoken.push(text), stop: () => undefined },
      recognize,
      crop: (surface, plan) => {
        expect(surface).toBe(fixture.canvas);
        plans.push(plan);
        return document.createElement('canvas');
      },
    });

    fixture.button.click();
    drag(document.querySelector('.region-ocr')!, [50, 50], [350, 250]);

    await vi.waitFor(() => expect(spoken).toEqual(['Figure 3: Valve assembly']));
    // 300 CSS px of a 600 px-wide box with a 1200 px backing store: the crop
    // must ask for 600 backing pixels, plus the padding, not 300.
    expect(plans[0].source.width).toBeGreaterThanOrEqual(600);
    expect(plans[0].source.x).toBeGreaterThanOrEqual(0);
    expect(fixture.status.textContent).toMatch(/reading 4 words/i);
    handle.destroy();
  });

  it('Escape leaves capture mode without reading anything', () => {
    const speak = vi.fn();
    const handle = bindRegionOcr({
      speaker: { speak, stop: () => undefined },
      recognize: vi.fn(),
      crop: () => document.createElement('canvas'),
    });

    fixture.button.click();
    expect(document.querySelector('.region-ocr')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.region-ocr')).toBeNull();
    expect(fixture.button.getAttribute('aria-pressed')).toBe('false');
    expect(fixture.status.textContent).toBe('Area selection cancelled.');
    expect(speak).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('explains itself when no rendered page is open', () => {
    fixture.host.replaceChildren();
    const handle = bindRegionOcr({ speaker: { speak: vi.fn(), stop: () => undefined } });

    fixture.button.click();

    expect(fixture.status.textContent).toMatch(/open a document in document view/i);
    expect(document.querySelector('.region-ocr')).toBeNull();
    handle.destroy();
  });
});
