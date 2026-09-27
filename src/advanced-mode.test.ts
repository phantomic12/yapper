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

  it('hides the "Change" shortcut once the grid is on screen', () => {
    // In advanced mode the grid *is* the affordance, so a second button
    // pointing at it would be redundant.
    const change = document.getElementById('model-change-btn') as HTMLButtonElement;
    applyAdvancedMode(false);
    expect(change.hidden).toBe(false);
    applyAdvancedMode(true);
    expect(change.hidden).toBe(true);
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
    for (const id of ['text-input', 'generate-btn', 'stream-btn', 'voice-grid', 'load-btn', 'model-summary']) {
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

  it('names the selected model in the simple-view summary', () => {
    const root = mountApp();
    expect(root.querySelector('#model-summary-name')!.textContent).toBe('Kitten TTS Nano (~24MB)');
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

  it('"Change model" opens the grid, so the model choice is one click away', () => {
    mountApp();
    bindAdvancedToggle();
    const change = document.getElementById('model-change-btn')!;
    expect(isAdvanced()).toBe(false);
    change.click();
    expect(isAdvanced()).toBe(true);
  });

  it('starts from the stored choice rather than always the simple view', () => {
    mountApp();
    storeAdvanced(true);
    bindAdvancedToggle();
    expect(isAdvanced()).toBe(true);
    expect(document.getElementById('advanced-toggle')!.getAttribute('aria-pressed')).toBe('true');
  });
});
