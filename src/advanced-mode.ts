/**
 * Simple mode vs Advanced mode.
 *
 * The app grew a lot of legitimate knobs — thirteen model cards, a language
 * filter, a speed slider, dtype/device trade-offs, a storage budget readout.
 * All of it is real, and all of it is noise to someone who opened a
 * text-to-speech site to type a sentence and hear it. So the default view
 * is the short path (pick a quality, pick a voice, type, speak) and
 * everything else sits behind the bottom bar's "More" toggle.
 *
 * Like the theme, this is a single attribute on <html>: the stylesheet hides
 * every `[data-advanced]` region unless the attribute is set, so no
 * per-element show/hide logic can drift out of sync with the CSS. The choice
 * is mirrored into localStorage and re-applied by an inline script in
 * <head> (see index.html) so the model grid does not flash into view on
 * every load for someone who turned advanced on.
 *
 * Warnings are deliberately NOT behind the toggle: if the selected model
 * runs on the main thread, or an fp16 model quietly resolved to int8, that
 * is true regardless of which view you are in, and hiding it would trade a
 * cluttered screen for a surprised one.
 */

export const ADVANCED_STORAGE_KEY = 'yapper.advanced.v1';

/** Advanced is opt-in: the first thing a new visitor sees is the short path. */
export const ADVANCED_DEFAULT = false;

/** localStorage is unavailable in some privacy modes; treat that as "no choice". */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored preference, or false when absent, unreadable or not a boolean. */
export function readStoredAdvanced(): boolean {
  try {
    return safeStorage()?.getItem(ADVANCED_STORAGE_KEY) === '1';
  } catch {
    return ADVANCED_DEFAULT;
  }
}

export function storeAdvanced(on: boolean): void {
  try {
    safeStorage()?.setItem(ADVANCED_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // A blocked write must not break the toggle.
  }
}

/** True when the document is currently showing the advanced view. */
export function isAdvanced(doc: Document = document): boolean {
  return doc.documentElement.dataset.advanced === 'on';
}

/**
 * Apply a mode to the document. Setting the attribute is what the stylesheet
 * keys off; the button's label and aria-pressed follow so the control still
 * reads correctly to a screen reader in either mode.
 */
export function applyAdvancedMode(on: boolean, doc: Document = document): void {
  if (on) {
    doc.documentElement.dataset.advanced = 'on';
  } else {
    delete doc.documentElement.dataset.advanced;
  }
  const toggle = doc.getElementById('advanced-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(on));
    toggle.title = on
      ? 'Hide the extra settings'
      : 'Show model choice, language filter, speed and download options';
  }
  // The toggle lives on the bottom bar and reads as an action, so its label
  // flips with the mode: "More" when the extras are hidden, "Less" when shown.
  const label = doc.getElementById('advanced-toggle-label');
  if (label) label.textContent = on ? 'Less' : 'More';
}

/** Read the stored preference and apply it. Call once at startup. */
export function restoreAdvancedMode(doc: Document = document): boolean {
  const on = readStoredAdvanced();
  applyAdvancedMode(on, doc);
  return on;
}

/** Wire the bottom-bar "More" toggle that reveals the advanced regions. */
export function bindAdvancedToggle(doc: Document = document): void {
  const toggle = doc.getElementById('advanced-toggle');
  const flip = (): void => {
    const next = !isAdvanced(doc);
    storeAdvanced(next);
    applyAdvancedMode(next, doc);
  };
  toggle?.addEventListener('click', flip);
  // Re-apply from storage rather than trusting whatever the attribute
  // happens to say: the inline <head> script sets it for the no-flash, but
  // this module has to stand on its own for any host that does not run it.
  restoreAdvancedMode(doc);
}
