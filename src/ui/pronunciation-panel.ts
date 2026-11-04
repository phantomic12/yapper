// ─── Pronunciation editor panel ──────────────────────────────────
// The UI half of `pronunciation.ts`. One textarea holding `word = say`
// lines, because a document usually needs a handful of fixes at once and
// a row-per-rule table would be more chrome than content.
//
// Saving does three things: writes the rules to localStorage, updates
// `AppState` so any session created later picks them up, and pushes them
// into the live session so the rest of the current document is read with
// the fix. Chunks already sent to the engine keep their old text — the
// alternative is re-synthesizing audio the reader is listening to.

import type { AppState } from '../app-state';
import {
  formatPronunciationList,
  loadPronunciations,
  parsePronunciationList,
  sanitizeEntries,
  savePronunciations,
} from '../pronunciation';

function statusNode(): HTMLElement | null {
  return document.getElementById('pron-status');
}

function setStatus(message: string): void {
  const node = statusNode();
  if (node) node.textContent = message;
}

/**
 * Apply a new rule set everywhere it matters: storage, shared state, and
 * the session currently reading. Returns the sanitized rules.
 */
export function applyPronunciationRules(state: AppState, raw: string): number {
  const entries = sanitizeEntries(parsePronunciationList(raw));
  savePronunciations(entries);
  state.pronunciations = entries;
  state.readerSession?.setPronunciations(entries);
  return entries.length;
}

/** Wire the editor. Safe to call on a page that lacks the markup. */
export function bindPronunciationPanel(state: AppState): void {
  const list = document.getElementById('pron-list') as HTMLTextAreaElement | null;
  const saveBtn = document.getElementById('pron-save-btn');
  const clearBtn = document.getElementById('pron-clear-btn');
  if (!list || !saveBtn) return;

  // Show what is already stored, not an empty box that silently discards
  // rules the reader set in a previous visit.
  const stored = state.pronunciations.length ? state.pronunciations : loadPronunciations();
  state.pronunciations = stored;
  list.value = formatPronunciationList(stored);
  if (stored.length) setStatus(`${stored.length} rule${stored.length === 1 ? '' : 's'} active`);

  saveBtn.addEventListener('click', () => {
    const count = applyPronunciationRules(state, list.value);
    // Reflect what was actually kept, so a malformed line does not look
    // like it was accepted.
    list.value = formatPronunciationList(state.pronunciations);
    setStatus(count ? `${count} rule${count === 1 ? '' : 's'} saved` : 'No rules — plain reading');
  });

  clearBtn?.addEventListener('click', () => {
    list.value = '';
    applyPronunciationRules(state, '');
    setStatus('Rules cleared');
  });
}
