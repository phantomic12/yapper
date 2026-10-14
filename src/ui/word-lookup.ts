/**
 * The word-lookup popover: tap a word in any reading view while lookup mode
 * is on and get its definition, synonyms and syllabification next to the
 * word — the "point and learn" surface of the reader.
 *
 * All content is built as text nodes or escaped markup: glosses come from a
 * bundled data file and tapped words come from user documents, neither of
 * which may become HTML. The popover is a fixed-position card with basic
 * viewport clamping; Escape, its close button, and clicking anywhere else
 * dismiss it.
 */

import { escapeHtmlText } from '../document-html';
import { loadDictionary, lookupWord, syllabify, type DictionaryEntry } from '../dictionary';

export interface LookupTarget {
  /** The surface form the user tapped. */
  word: string;
  /** Document-text offsets of the tapped word, for highlight/save actions. */
  start: number;
  end: number;
  /** Client coordinates to anchor the popover near. */
  x: number;
  y: number;
}

export interface LookupActions {
  onSpeak(word: string): void;
  onSaveWord(word: string, start: number, end: number): boolean;
  onHighlight(start: number, end: number): void;
}

export interface WordLookupController {
  open(target: LookupTarget): void;
  close(): void;
  readonly openWord: string | null;
}

/** Render the resolved entry into the popover body. */
function entryMarkup(entry: DictionaryEntry | null, word: string): string {
  if (!entry) {
    return `<p class="word-lookup__none">No dictionary entry for “${escapeHtmlText(word)}”.</p>`;
  }
  const senses = entry.senses.map(sense => `
    <li class="word-lookup__sense">
      <span class="word-lookup__pos">${escapeHtmlText(sense.pos)}</span>
      <span class="word-lookup__gloss">${escapeHtmlText(sense.gloss)}</span>
    </li>`).join('');
  const synonyms = entry.synonyms.length
    ? `<p class="word-lookup__syns"><span class="word-lookup__syns-label">Synonyms</span> `
      + entry.synonyms.map(syn =>
        `<button class="word-lookup__syn" type="button" data-syn="${escapeHtmlText(syn)}">${escapeHtmlText(syn)}</button>`)
        .join(' ')
      + '</p>'
    : '';
  const lemma = entry.lemma !== word.toLowerCase()
    ? `<span class="word-lookup__lemma">→ ${escapeHtmlText(entry.lemma)}</span>`
    : '';
  return `${lemma}<ol class="word-lookup__senses">${senses}</ol>${synonyms}`;
}

/**
 * Create the lookup controller. The popover element is made lazily on first
 * open so the reader pays nothing while lookup stays unused.
 */
export function createWordLookup(actions: LookupActions): WordLookupController {
  let popover: HTMLElement | null = null;
  let statusEl: HTMLElement | null = null;
  let bodyEl: HTMLElement | null = null;
  let lastTrigger: HTMLElement | null = null;
  let currentWord: string | null = null;
  let generation = 0;

  function ensure(): HTMLElement {
    if (popover) return popover;
    popover = document.createElement('div');
    popover.className = 'word-lookup';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Word lookup');
    popover.innerHTML = `
      <div class="word-lookup__head">
        <span class="word-lookup__word" data-role="word"></span>
        <span class="word-lookup__syl" data-role="syl"></span>
        <button class="document-btn word-lookup__close" type="button" data-role="close" aria-label="Close"><span aria-hidden="true">✕</span></button>
      </div>
      <div class="word-lookup__status" data-role="status" role="status" aria-live="polite"></div>
      <div class="word-lookup__body" data-role="body"></div>
      <div class="word-lookup__actions">
        <button class="document-btn" type="button" data-role="speak">Hear it</button>
        <button class="document-btn" type="button" data-role="save">Save word</button>
        <button class="document-btn" type="button" data-role="highlight">Highlight</button>
      </div>
      <p class="word-lookup__credit">Definitions: WordNet 3.1, bundled offline</p>`;
    document.body.appendChild(popover);
    statusEl = popover.querySelector('[data-role="status"]');
    bodyEl = popover.querySelector('[data-role="body"]');
    popover.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-role], [data-syn]');
      if (!button) return;
      const role = button.dataset.role;
      if (button.dataset.syn) {
        const syn = button.dataset.syn;
        currentWord = syn;
        fill(syn);
        return;
      }
      if (role === 'close') controller.close();
      else if (role === 'speak' && currentWord) actions.onSpeak(currentWord);
      else if (role === 'save' && currentWord) {
        const saved = actions.onSaveWord(currentWord, currentStart, currentEnd);
        if (statusEl) statusEl.textContent = saved ? `Saved “${currentWord}”` : `“${currentWord}” is already saved`;
      } else if (role === 'highlight') {
        actions.onHighlight(currentStart, currentEnd);
        controller.close();
      }
    });
    return popover;
  }

  let currentStart = 0;
  let currentEnd = 0;

  function fill(word: string): void {
    if (!popover || !statusEl || !bodyEl) return;
    const wordEl = popover.querySelector<HTMLElement>('[data-role="word"]')!;
    const sylEl = popover.querySelector<HTMLElement>('[data-role="syl"]')!;
    wordEl.textContent = word;
    sylEl.textContent = syllabify(word);
    statusEl.textContent = '';
    bodyEl.innerHTML = '<p class="word-lookup__none">Looking up…</p>';
    const run = ++generation;
    void loadDictionary().then(dict => {
      if (run !== generation || !bodyEl) return;
      bodyEl.innerHTML = dict ? entryMarkup(lookupWord(dict, word), word) : '<p class="word-lookup__none">Dictionary unavailable offline.</p>';
    });
  }

  function place(x: number, y: number): void {
    if (!popover) return;
    popover.style.visibility = 'hidden';
    popover.style.left = '0px';
    popover.style.top = '0px';
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, x - width / 2));
    const below = y + 12;
    const top = below + height + margin > window.innerHeight
      ? Math.max(margin, y - height - 12)
      : below;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    popover.style.visibility = '';
  }

  function onDocumentClick(event: MouseEvent): void {
    if (popover && !popover.contains(event.target as Node)) controller.close();
  }
  function onDocumentKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      controller.close();
    }
  }

  const controller: WordLookupController = {
    get openWord() { return currentWord; },
    open(target) {
      lastTrigger = document.activeElement as HTMLElement | null;
      ensure();
      currentWord = target.word;
      currentStart = target.start;
      currentEnd = target.end;
      fill(target.word);
      popover!.hidden = false;
      place(target.x, target.y);
      document.addEventListener('click', onDocumentClick, true);
      document.addEventListener('keydown', onDocumentKey, true);
      popover!.querySelector<HTMLElement>('[data-role="close"]')?.focus();
    },
    close() {
      if (!popover) return;
      currentWord = null;
      generation++;
      popover.hidden = true;
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onDocumentKey, true);
      lastTrigger?.focus?.();
      lastTrigger = null;
    },
  };
  return controller;
}
