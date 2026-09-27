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
    expect(root.querySelector('#bottom-bar-model')!.textContent).toBe('Kitten TTS Nano (~24MB)');
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
