import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ADVANCED_STORAGE_KEY,
  ADVANCED_DEFAULT,
  readStoredAdvanced,
  storeAdvanced,
  isAdvanced,
  applyAdvancedMode,
  restoreAdvancedMode,
  bindAdvancedToggle,
} from './advanced-mode';
import { buildAppMarkup } from './ui/layout';
import { updatePrecisionWarning } from './ui/model-panel';
import type { AppState } from './app-state';

/** Minimal in-memory Storage; node's experimental localStorage no-ops. */
function stubStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  });
  return map;
}

function mountApp(): HTMLDivElement {
  document.documentElement.removeAttribute('data-advanced');
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.innerHTML = buildAppMarkup({ capability: 'none', selectedModelId: 'kitten-nano' });
  document.body.appendChild(root);
  return root;
}

describe('advanced mode — storage', () => {
  beforeEach(() => { stubStorage(); });

  it('defaults to the simple view', () => {
    expect(ADVANCED_DEFAULT).toBe(false);
    expect(readStoredAdvanced()).toBe(false);
  });

  it('round-trips the choice', () => {
    storeAdvanced(true);
    expect(localStorage.getItem(ADVANCED_STORAGE_KEY)).toBe('1');
    expect(readStoredAdvanced()).toBe(true);
    storeAdvanced(false);
    expect(readStoredAdvanced()).toBe(false);
  });

  it('ignores anything that is not exactly "1"', () => {
    // A hand-edited or half-migrated value must not unlock the grid.
    localStorage.setItem(ADVANCED_STORAGE_KEY, 'true');
    expect(readStoredAdvanced()).toBe(false);
    localStorage.setItem(ADVANCED_STORAGE_KEY, '');
    expect(readStoredAdvanced()).toBe(false);
  });
});

describe('advanced mode — applying to the document', () => {
  beforeEach(() => {
    stubStorage();
    mountApp();
  });

  it('sets and clears the attribute the stylesheet keys off', () => {
    applyAdvancedMode(true);
    expect(document.documentElement.dataset.advanced).toBe('on');
    expect(isAdvanced()).toBe(true);

    applyAdvancedMode(false);
    // Removed rather than set to "off", so the CSS :not() selector matches.
    expect(document.documentElement.hasAttribute('data-advanced')).toBe(false);
    expect(isAdvanced()).toBe(false);
  });

  it('keeps the toggle\'s accessible state in step with the mode', () => {
    const toggle = document.getElementById('advanced-toggle')!;
    applyAdvancedMode(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.title).toMatch(/Hide/);
    applyAdvancedMode(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.title).toMatch(/Show/);
  });

  it('flips the bottom-bar toggle label between More and Less', () => {
    // The toggle reads as an action on the bottom bar, so its word tracks the
    // mode instead of sitting at a static "Advanced".
    const label = document.getElementById('advanced-toggle-label')!;
    applyAdvancedMode(false);
    expect(label.textContent).toBe('More');
    applyAdvancedMode(true);
    expect(label.textContent).toBe('Less');
  });

  it('restores the stored preference', () => {
    storeAdvanced(true);
    expect(restoreAdvancedMode()).toBe(true);
    expect(isAdvanced()).toBe(true);
  });
});

describe('advanced mode — markup', () => {
  it('marks exactly the regions that are advanced-only', () => {
    const root = mountApp();
    const marked = [...root.querySelectorAll('[data-advanced]')];
    const advanced = marked.map(el => el.id || [...el.classList].join(' '));
    // The things a newcomer should not have to read before their first word.
    expect(advanced).toContain('model-grid');
    expect(advanced.some(c => c.includes('language-select-wrapper'))).toBe(true);
    expect(advanced).toContain('speed-row');
    expect(advanced).toContain('download-all-btn');
    expect(advanced).toContain('clear-btn');
    expect(advanced).toContain('gpu-status');
    expect(advanced).toContain('document-options');
  });

  it('marks the label that explains the language filter along with it', () => {
    // Hiding the <select> but leaving "FILTER MODELS BY LANGUAGE" above the
    // text box would be worse than showing either one.
    const root = mountApp();
    const label = root.querySelector('label[data-advanced]')!;
    expect(label.getAttribute('for')).toBe('language-filter');
  });

  it('leaves the essentials and the warnings visible in the simple view', () => {
    const root = mountApp();
    for (const id of ['text-input', 'generate-btn', 'stream-btn', 'voice-grid', 'load-btn', 'quality-presets', 'bottom-bar']) {
      expect(root.querySelector(`#${id}`), `#${id} must exist`).not.toBeNull();
    }
    // A warning that is true regardless of view must not be hidden: someone
    // who picked a main-thread model in advanced mode should still be told
    // when they switch back to the simple view.
    for (const id of ['main-thread-warning', 'f16-warning']) {
      const el = root.querySelector(`#${id}`)!;
      expect(el.hasAttribute('data-advanced'), `#${id} must stay visible`).toBe(false);
    }
  });

  it('reflects the selected model in the quality presets and bottom bar', () => {
    const root = mountApp();
    // mountApp selects kitten-nano, which is the "low" preset.
    expect(root.querySelector('.quality-preset--active')?.getAttribute('data-quality')).toBe('low');
    expect(root.querySelector('#bottom-bar-preset')!.textContent).toBe('Low');
    // The name alone: the bottom bar is visible in the simple view, so it
    // must not carry a download size (see the memory-figure guard below).
    expect(root.querySelector('#bottom-bar-model')!.textContent).toBe('Kitten TTS Nano');
  });

  it('keeps memory figures out of the simple view', () => {
    const root = mountApp();
    // The rule the simple view lives by: nothing a newcomer can read — label,
    // blurb or tooltip — quotes a download size. Elements marked data-advanced
    // are exempt (the stylesheet hides the whole subtree), which is exactly
    // where the sizes are allowed to live.
    const SIZE = /\d+(?:\.\d+)?\s*(?:MB|MiB|KB|GB)\b/i;
    // One surface is allowed to quote a number: the upload cap, which is a
    // limit the user has to respect *before* they pick a file, not a
    // description of what the app is downloading. Selector-based on purpose —
    // it cannot be defeated by a reword. The e2e suite asserts the same
    // single exception against the live, computed styles.
    const ALLOWED = '#document-formats';
    const offenders: string[] = [];
    // Direct text nodes only: an ancestor's textContent includes the copy of
    // the advanced children nested inside it, and the size in a hidden span
    // must not be blamed on the button that contains it.
    const ownText = (el: Element) => [...el.childNodes]
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent ?? '')
      .join(' ')
      .trim();
    const walk = (el: Element): void => {
      if (el.hasAttribute('data-advanced')) return; // hidden subtree
      if (el.closest(ALLOWED)) return; // see ALLOWED above
      const text = ownText(el);
      const title = el.getAttribute('title') ?? '';
      if (SIZE.test(text) || SIZE.test(title)) {
        offenders.push(`${el.tagName.toLowerCase()}.${el.className || '(no class)'} → ${text || title}`);
      }
      for (const child of el.children) walk(child);
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('still states the upload cap in the simple view', () => {
    const root = mountApp();
    // Pinned so nobody "tidies" the exception away by hiding the region: it
    // is load-bearing, and it is checked live in the e2e suite too.
    const formats = root.querySelector('#document-formats')!;
    expect(formats.hasAttribute('data-advanced')).toBe(false);
    expect(formats.textContent).toMatch(/25 MB/);
  });

  it('gives the fp16 fallback warning a simple sentence and a technical one', () => {
    // The warning stays in the simple view — it is true regardless of mode —
    // but the simple view gets the consequence in the preset row's own words,
    // while the mechanism, model names and byte counts sit behind the toggle.
    const root = mountApp();
    updatePrecisionWarning({ acceleration: { degradedGpu: true } } as unknown as AppState);

    const simple = root.querySelector<HTMLElement>('[data-role="f16-copy"]')!;
    const detail = root.querySelector<HTMLElement>('[data-role="f16-copy-detail"]')!;
    expect(root.querySelector<HTMLElement>('#f16-warning')!.style.display).toBe('');
    expect(simple.textContent).toMatch(/High quality/);
    expect(simple.textContent).not.toMatch(/fp16|int8|\d+\s*MB/);
    expect(detail.textContent).toMatch(/fp16/);
    expect(detail.textContent).toMatch(/88MB rather than 156MB/);
    // The two marks are complementary, so the banner shows one sentence per
    // view instead of the same news twice side by side.
    expect(simple.hasAttribute('data-simple')).toBe(true);
    expect(detail.hasAttribute('data-advanced')).toBe(true);
  });

  it('marks short-path-only copy with data-simple, never data-advanced', () => {
    // data-advanced means "advanced view only". Copy that belongs to the
    // simple view and steps aside in the advanced one has to use the other
    // mark, or the two sentences render together in the same banner.
    const root = mountApp();
    const marked = [...root.querySelectorAll('[data-simple]')];
    expect(marked.length).toBeGreaterThan(0);
    for (const el of marked) {
      expect(el.hasAttribute('data-advanced'), `${el.className} is marked twice`).toBe(false);
    }
  });

  it('keeps the size figures, but only, behind the toggle', () => {
    const root = mountApp();
    // The information is relocated, not deleted: the advanced view still
    // shows the size ladder on the presets and on the model cards.
    const presetSizes = [...root.querySelectorAll('#quality-presets .quality-preset__size')];
    expect(presetSizes.map(el => el.textContent)).toEqual(['~24MB', '~88MB', '~156MB']);
    for (const el of presetSizes) {
      expect(el.hasAttribute('data-advanced')).toBe(true);
    }
    const cardSizes = [...root.querySelectorAll('#model-grid .model-card__size')];
    expect(cardSizes.length).toBeGreaterThan(0);
    for (const el of cardSizes) {
      expect(el.hasAttribute('data-advanced')).toBe(true);
    }
  });

  it('does not smuggle a size in through the preset tooltip', () => {
    // A hover tooltip is still the simple view: the title has to sell the
    // outcome ("Fastest"), not the engineering.
    const root = mountApp();
    for (const btn of root.querySelectorAll('.quality-preset')) {
      expect(btn.getAttribute('title')).not.toMatch(/MB/i);
    }
  });

  it('names the model without its quantisation, which moves to an advanced chip', () => {
    const root = mountApp();
    // Two Kokoro builds share the name "Kokoro-82M"; the card tells them
    // apart with a variant chip that only the advanced view renders.
    const kokoro = [...root.querySelectorAll('.model-card[data-model-id="kokoro-82m"], .model-card[data-model-id="kokoro-82m-fp16"]')];
    expect(kokoro.map(c => c.querySelector('.model-card__name')!.textContent)).toEqual(['Kokoro-82M', 'Kokoro-82M']);
    const variants = kokoro.map(c => c.querySelector('.model-card__variant')?.textContent);
    expect(variants).toEqual(['int8', 'fp16']);
    for (const c of kokoro) {
      expect(c.querySelector('.model-card__variant')!.hasAttribute('data-advanced')).toBe(true);
    }
  });

  it('drops the old model-summary clutter from the default view', () => {
    // The model grid + jargon-y summary are exactly the info dump the default
    // view should not have; they are replaced by the preset control + bar.
    const root = mountApp();
    expect(root.querySelector('#model-summary')).toBeNull();
    expect(root.querySelector('#model-change-btn')).toBeNull();
    expect(root.querySelector('#quality-presets')).not.toBeNull();
    expect(root.querySelector('#bottom-bar')).not.toBeNull();
  });
});

describe('advanced mode — toggle', () => {
  beforeEach(() => { stubStorage(); });

  it('flips the mode and persists it', () => {
    mountApp();
    bindAdvancedToggle();
    const toggle = document.getElementById('advanced-toggle')!;

    toggle.click();
    expect(isAdvanced()).toBe(true);
    expect(readStoredAdvanced()).toBe(true);

    toggle.click();
    expect(isAdvanced()).toBe(false);
    expect(readStoredAdvanced()).toBe(false);
  });

  it('the bottom-bar More toggle reveals the advanced regions', () => {
    mountApp();
    bindAdvancedToggle();
    const toggle = document.getElementById('advanced-toggle')!;
    expect(isAdvanced()).toBe(false);
    toggle.click();
    expect(isAdvanced()).toBe(true);
    expect(document.getElementById('advanced-toggle-label')!.textContent).toBe('Less');
    toggle.click();
    expect(isAdvanced()).toBe(false);
    expect(document.getElementById('advanced-toggle-label')!.textContent).toBe('More');
  });

  it('starts from the stored choice rather than always the simple view', () => {
    mountApp();
    storeAdvanced(true);
    bindAdvancedToggle();
    expect(isAdvanced()).toBe(true);
    expect(document.getElementById('advanced-toggle')!.getAttribute('aria-pressed')).toBe('true');
  });
});
