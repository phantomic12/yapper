import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAppMarkup } from './ui/layout';
import { CAPABILITY_INFO, type CapabilityClass } from './capability';

function render(capability: CapabilityClass): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = buildAppMarkup({ capability, selectedModelId: 'kitten-nano' });
  return root;
}

describe('capability banner markup (AC3)', () => {
  let originalGpu: unknown;

  beforeEach(() => {
    // jsdom has no navigator.gpu; the layout itself is capability-driven so
    // these tests render each class directly.
    originalGpu = (navigator as { gpu?: unknown }).gpu;
  });

  afterEach(() => {
    (navigator as { gpu?: unknown }).gpu = originalGpu;
  });

  it("renders the 'none' wording on browsers without WebGPU", () => {
    const root = render('none');
    const label = root.querySelector('.gpu-status__label')!;
    expect(label.textContent).toBe(CAPABILITY_INFO.none.label);
    expect(label.textContent).toContain('WebGPU unavailable');
    const dot = root.querySelector<HTMLElement>('.gpu-status__dot')!;
    expect(dot.classList.contains('gpu-status__dot--off')).toBe(true);
  });

  it("renders distinct 'partial' wording for unusable WebGPU (Firefox Nightly)", () => {
    const root = render('partial');
    const label = root.querySelector('.gpu-status__label')!;
    expect(label.textContent).toBe(CAPABILITY_INFO.partial.label);
    expect(label.textContent).toContain('WebGPU detected but unusable');
    const dot = root.querySelector<HTMLElement>('.gpu-status__dot')!;
    expect(dot.classList.contains('gpu-status__dot--partial')).toBe(true);
  });

  it("renders the GPU-accelerated wording when WebGPU is fully available", () => {
    const root = render('full');
    const label = root.querySelector('.gpu-status__label')!;
    expect(label.textContent).toBe(CAPABILITY_INFO.full.label);
    expect(label.textContent).toContain('WebGPU detected — GPU-accelerated inference');
    const dot = root.querySelector<HTMLElement>('.gpu-status__dot')!;
    expect(dot.classList.contains('gpu-status__dot--on')).toBe(true);
  });

  it('carries the long explanation as a tooltip on every class', () => {
    for (const cls of ['none', 'partial', 'full'] as CapabilityClass[]) {
      const root = render(cls);
      const banner = root.querySelector<HTMLElement>('.gpu-status')!;
      expect(banner.title).toBe(CAPABILITY_INFO[cls].detail);
      expect(banner.getAttribute('role')).toBe('status');
    }
  });
});

describe('generation liveness element (AC4)', () => {
  it('exists in the layout and is hidden until generation starts', () => {
    const root = render('none');
    const feedback = root.querySelector<HTMLElement>('#generation-feedback')!;
    expect(feedback).toBeTruthy();
    // Hidden by default: the --visible modifier class drives display.
    expect(feedback.classList.contains('generation-feedback--visible')).toBe(false);
    expect(root.querySelector('#generation-feedback-text')?.textContent).toContain('Generating');
  });
});
