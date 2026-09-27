import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readStoredTheme,
  storeTheme,
  resolveTheme,
  nextTheme,
  applyTheme,
  bindThemeToggle,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from './theme';

// jsdom has no matchMedia by default; each test installs what it needs.
type MqlStub = { matches: boolean; addEventListener?: () => void; addListener?: () => void };

function stubMatchMedia(dark: boolean): void {
  const mql: MqlStub = { matches: dark };
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => {
    if (query.includes('dark')) return mql;
    return { matches: false, addEventListener: () => {} } as unknown as MqlStub;
  };
}

function removeMatchMedia(): void {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
}

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

describe('theme storage', () => {
  beforeEach(() => stubStorage());
  afterEach(() => { vi.unstubAllGlobals(); });

  it('defaults to following the system when nothing is stored', () => {
    expect(readStoredTheme()).toBe('system');
  });

  it('round-trips an explicit choice', () => {
    storeTheme('light');
    expect(readStoredTheme()).toBe('light');
    storeTheme('dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('ignores a corrupt stored value rather than trusting it', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme()).toBe('system');
  });

  it('survives storage being unavailable (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(readStoredTheme()).toBe('system');
    expect(() => storeTheme('dark')).not.toThrow();
  });
});

describe('resolveTheme', () => {
  afterEach(() => removeMatchMedia());

  it('maps system to whatever the OS asks for', () => {
    stubMatchMedia(true);
    expect(systemPrefersDark()).toBe(true);
    expect(resolveTheme('system')).toBe('dark');
    stubMatchMedia(false);
    expect(systemPrefersDark()).toBe(false);
    expect(resolveTheme('system')).toBe('light');
  });

  it('ignores the OS for an explicit choice', () => {
    stubMatchMedia(true);
    expect(resolveTheme('light')).toBe('light');
    stubMatchMedia(false);
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('falls back to dark when matchMedia is missing', () => {
    removeMatchMedia();
    expect(resolveTheme('system')).toBe('dark');
  });
});

describe('nextTheme', () => {
  afterEach(() => removeMatchMedia());

  it('cycles system → opposite of the system → the other explicit', () => {
    stubMatchMedia(true);
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });

  it('cycles the other way on a light OS', () => {
    stubMatchMedia(false);
    expect(nextTheme('system')).toBe('dark');
  });

  it('always lands on an explicit choice, never back on system', () => {
    stubMatchMedia(false);
    let choice: ThemeChoice = 'system';
    for (let i = 0; i < 6; i++) {
      choice = nextTheme(choice);
      expect(choice).not.toBe('system');
    }
  });
});

describe('applyTheme', () => {
  beforeEach(() => { document.documentElement.removeAttribute('data-theme'); });
  afterEach(() => removeMatchMedia());

  it('sets and clears the attribute on <html>', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // 'system' must leave the attribute off so the media query in the
    // stylesheet can decide — otherwise the OS toggle would go dead.
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('bindThemeToggle', () => {
  beforeEach(() => {
    stubStorage();
    document.body.innerHTML = '<button id="theme-toggle" type="button">Auto</button>';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    removeMatchMedia();
    vi.unstubAllGlobals();
  });

  it('does nothing when the toggle is absent', () => {
    document.body.innerHTML = '';
    expect(() => bindThemeToggle()).not.toThrow();
  });

  it('applies the stored choice on bind and reflects it in the label', () => {
    stubMatchMedia(true);
    storeTheme('light');
    bindThemeToggle();
    const button = document.getElementById('theme-toggle')!;
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(button.textContent).toBe('Light');
    expect(button.getAttribute('data-theme-choice')).toBe('light');
  });

  it('cycles on click, persists, and updates the label each time', () => {
    stubMatchMedia(true); // system resolves to dark
    bindThemeToggle();
    const button = document.getElementById('theme-toggle')!;
    expect(button.textContent).toBe('Auto');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    button.click(); // system → light (opposite of a dark OS)
    expect(readStoredTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(button.textContent).toBe('Light');

    button.click(); // light → dark
    expect(readStoredTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(button.textContent).toBe('Dark');
  });

  it('describes what the next activation will do', () => {
    stubMatchMedia(true);
    bindThemeToggle();
    const button = document.getElementById('theme-toggle')!;
    expect(button.getAttribute('aria-label')).toContain('following system');
    button.click();
    expect(button.getAttribute('aria-label')).toContain('light');
  });
});
