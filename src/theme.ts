/**
 * Light/dark theme selection.
 *
 * The palette is entirely custom properties on :root (see src/style.css), so
 * switching themes is one attribute on <html> and nothing else. Three modes
 * are supported: an explicit user choice, or "follow the system" — the
 * default, because a privacy tool that ignores the OS setting is a small
 * papercut on every launch.
 *
 * The applied value is mirrored into localStorage so a reload does not flash
 * the wrong theme, and `data-theme` is left unset for "system" so the CSS
 * `@media (prefers-color-scheme)` rules can decide.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'yapper.theme.v1';

const VALID: ReadonlySet<string> = new Set<ThemeChoice>(['light', 'dark', 'system']);

/** localStorage is unavailable in some privacy modes; treat that as "no choice". */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored choice, or 'system' when absent or unrecognised. */
export function readStoredTheme(): ThemeChoice {
  try {
    const raw = safeStorage()?.getItem(THEME_STORAGE_KEY);
    return raw && VALID.has(raw) ? (raw as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

export function storeTheme(choice: ThemeChoice): void {
  try {
    safeStorage()?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Persistence is a nicety here; a blocked write must not break the toggle.
  }
}

/** True when the OS is asking for a dark UI. Defaults to dark when unknown. */
export function systemPrefersDark(): boolean {
  // Dark is the app's original palette, so when we cannot ask the OS it is the
  // safer default — it also means a missing matchMedia cannot silently flip
  // someone to light.
  if (typeof matchMedia !== 'function') return true;
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/** The theme that will actually be painted for a given choice. */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return choice;
}

/** The next choice when the toggle is pressed. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  if (choice === 'system') return systemPrefersDark() ? 'light' : 'dark';
  return choice === 'dark' ? 'light' : 'dark';
}

/**
 * Apply a choice to <html>. 'system' clears the attribute so the stylesheet's
 * own media query applies, which also keeps the OS toggle live without JS.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
}

/**
 * Wire the header toggle. Cycles system → the opposite of the system → the
 * other explicit choice, and keeps the button's label in step with what it
 * will do next, so the control explains itself instead of being a mystery
 * toggle.
 */
export function bindThemeToggle(): void {
  const button = document.getElementById('theme-toggle') as HTMLButtonElement | null;
  if (!button) return;

  let choice = readStoredTheme();
  applyTheme(choice);

  const labelFor = (c: ThemeChoice): string =>
    c === 'system'
      ? `Theme: following system (${resolveTheme('system')}). Activate to switch to ${resolveTheme('system') === 'dark' ? 'light' : 'dark'}.`
      : `Theme: ${c}. Activate to switch to ${c === 'dark' ? 'light' : 'dark'}.`;

  const paint = (): void => {
    button.textContent = choice === 'system' ? 'Auto' : choice === 'dark' ? 'Dark' : 'Light';
    button.title = labelFor(choice);
    button.setAttribute('aria-label', labelFor(choice));
    button.setAttribute('data-theme-choice', choice);
  };

  paint();

  button.addEventListener('click', () => {
    choice = nextTheme(choice);
    storeTheme(choice);
    applyTheme(choice);
    paint();
  });

  // While the choice is "system", follow live OS changes.
  if (typeof matchMedia === 'function') {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      if (choice === 'system') {
        applyTheme('system');
        paint();
      }
    };
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
    } else if (typeof query.addListener === 'function') {
      query.addListener(onChange); // Safari < 14
    }
  }
}
