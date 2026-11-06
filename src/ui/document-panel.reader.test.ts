/**
 * The reader controls, exercised through the real markup and the real event
 * bindings.
 *
 * `reader.test.ts` proves the session's decisions; this file proves those
 * decisions reach the page. The gap between them is where a feature can look
 * complete — every state field correct — while the highlight on screen never
 * moves, so the important assertions here are on classes the reader actually
 * sees: one word chip, a band over the unit, and controls that update their
 * pressed state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAppState } from '../app-state';
import { silentWordDurationMs } from '../reading-units';
import { buildAppMarkup } from './layout';
import { bindDocumentEvents } from './document-panel';

function mountReader() {
  document.body.innerHTML = buildAppMarkup({
    capability: 'none',
    selectedModelId: 'kitten-nano',
  });
  const state = createAppState();
  bindDocumentEvents(state);
  // The sample goes through exactly the same render path as an upload.
  (document.getElementById('document-sample-btn') as HTMLButtonElement).click();
  return state;
}

const view = (): HTMLElement => document.getElementById('document-reader-view') as HTMLElement;
const wordsWith = (className: string): HTMLElement[] =>
  Array.from(view().querySelectorAll<HTMLElement>(`.reader-word.${className}`));
const activeWord = (): HTMLElement | null =>
  view().querySelector<HTMLElement>('.reader-word.reader-active-word');
const button = (selector: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(selector) as HTMLButtonElement;

describe('reader controls — silent reading', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('starts reading with no model when silent is turned on', () => {
    const state = mountReader();
    expect(state.engine).toBeNull();
    expect(state.readerSession).toBeNull();

    const toggle = button('#silent-read-btn');
    toggle.click();

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(state.readerSession).not.toBeNull();
    expect(state.readerSession?.isSilent()).toBe(true);
    expect(activeWord()).not.toBeNull();
  });

  it('paints the current word inside a larger unit band', () => {
    mountReader();
    button('#silent-read-btn').click();

    const active = activeWord();
    expect(active).not.toBeNull();
    // The word chip is also part of the band, and the band covers more than
    // one word — that is what "dual" means on screen.
    expect(active!.classList.contains('reader-unit')).toBe(true);
    expect(wordsWith('reader-unit').length).toBeGreaterThan(1);
  });

  it('advances the highlight on its own, with no audio', () => {
    mountReader();
    button('#silent-read-btn').click();

    const first = activeWord()!.textContent ?? '';
    vi.advanceTimersByTime(silentWordDurationMs(first, 1));

    expect(activeWord()?.textContent).not.toBe(first);
    expect(wordsWith('reader-active-word')).toHaveLength(1);
  });

  it('enables skip only while a session holds a position', () => {
    mountReader();
    const forward = button('[data-reader-nav="forward"]');
    expect(forward.disabled).toBe(true);

    button('#silent-read-btn').click();
    expect(forward.disabled).toBe(false);
  });
});

describe('reader controls — reading unit and skip', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('shrinks the highlighted unit to one word when Word is chosen', () => {
    mountReader();
    button('#silent-read-btn').click();
    expect(wordsWith('reader-unit').length).toBeGreaterThan(1);

    const wordButton = button('[data-reading-unit="word"]');
    wordButton.click();

    expect(wordsWith('reader-unit')).toHaveLength(1);
    expect(wordButton.getAttribute('aria-pressed')).toBe('true');
    expect(button('[data-reading-unit="sentence"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('moves the highlight one unit forward and back', () => {
    mountReader();
    button('#silent-read-btn').click();
    button('[data-reading-unit="word"]').click();

    const start = activeWord()!.textContent;
    button('[data-reader-nav="forward"]').click();
    const next = activeWord()!.textContent;
    expect(next).not.toBe(start);

    button('[data-reader-nav="back"]').click();
    expect(activeWord()!.textContent).toBe(start);
  });

  it('keeps both copies of the selector in step', () => {
    mountReader();
    const [topBarButton] = document.querySelectorAll<HTMLButtonElement>(
      '.document-actions [data-reading-unit="paragraph"]',
    );
    topBarButton.click();

    const pressed = Array.from(document.querySelectorAll<HTMLButtonElement>(
      '[data-reading-unit="paragraph"]',
    )).filter(b => b.getAttribute('aria-pressed') === 'true');
    // One in the top bar, one in the overlay.
    expect(pressed).toHaveLength(2);
  });

  it('remembers the unit between mounts', () => {
    mountReader();
    button('[data-reading-unit="paragraph"]').click();
    document.body.innerHTML = '';

    mountReader();
    expect(button('[data-reading-unit="paragraph"]').getAttribute('aria-pressed')).toBe('true');
  });
});

/**
 * The sentence the cursor is in is the coordinate every consumer of the
 * highlight agrees on: the document view scrolls to it, the status line counts
 * it, and anything checking that reading works reads it. It has to be on the
 * page, not only derivable from the word chip — a word index alone does not
 * say which sentence it belongs to without walking the DOM, and a sentence
 * split across two chunks makes the word index ambiguous on its own.
 */
describe('reader highlight — the active sentence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const activeSentences = (): HTMLElement[] =>
    Array.from(view().querySelectorAll<HTMLElement>('.reader-sentence.reader-active-sentence'));

  it('marks the sentence that holds the cursor', () => {
    mountReader();
    button('#silent-read-btn').click();

    const marked = activeSentences();
    expect(marked).toHaveLength(1);
    // The mark is the sentence of the word chip, not some other sentence.
    const word = activeWord()!;
    expect(marked[0]).toBe(word.closest('[data-sentence-index]'));
    expect(marked[0].dataset.sentenceIndex).toBe(
      word.closest<HTMLElement>('[data-sentence-index]')!.dataset.sentenceIndex,
    );
  });

  it('moves the mark forward with the cursor', () => {
    mountReader();
    button('#silent-read-btn').click();
    const first = activeSentences()[0].dataset.sentenceIndex;

    // Skip by sentence until the cursor is in a different one; the sample is
    // several sentences long, so this happens on the first skip.
    button('[data-reader-nav="forward"]').click();

    const second = activeSentences()[0].dataset.sentenceIndex;
    expect(second).not.toBe(first);
    expect(activeSentences()).toHaveLength(1);
  });

  it('keeps the mark when the unit shrinks to a single word', () => {
    mountReader();
    button('#silent-read-btn').click();
    button('[data-reading-unit="word"]').click();

    // The band covers one word now, but the sentence is still known: a
    // consumer must not lose the sentence just because the unit is finer.
    expect(wordsWith('reader-unit')).toHaveLength(1);
    expect(activeSentences()).toHaveLength(1);
    expect(activeSentences()[0]).toBe(activeWord()!.closest('[data-sentence-index]'));
  });

  it('marks the sentence in the overlay copy as well as the inline one', () => {
    mountReader();
    button('#silent-read-btn').click();

    const overlay = document.getElementById('reader-overlay-content') as HTMLElement;
    const marked = overlay.querySelectorAll('.reader-sentence.reader-active-sentence');
    expect(marked).toHaveLength(1);
    expect(overlay.querySelector('.reader-word.reader-active-word')).not.toBeNull();
  });

  it('takes the mark down when the session stops', () => {
    mountReader();
    button('#silent-read-btn').click();
    expect(activeSentences()).toHaveLength(1);

    button('#stop-document-btn').click();
    expect(activeSentences()).toHaveLength(0);
    expect(wordsWith('reader-unit')).toHaveLength(0);
  });
});

/**
 * Pause and Resume are one button, and both halves have failed before: an
 * earlier build resumed only when autoplay had been blocked, so after an
 * ordinary Pause the label said Resume and the click did nothing. The button
 * is also the only way back into a read, so the state — not just the label —
 * has to change.
 */
describe('reader controls — pause and resume', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const overlayPause = (): HTMLButtonElement =>
    document.getElementById('reader-overlay-pause') as HTMLButtonElement;

  it('pauses and resumes from the overlay button', () => {
    const state = mountReader();
    button('#silent-read-btn').click();
    expect(state.readerSession?.getState().status).toBe('playing');
    expect(overlayPause().textContent).toBe('Pause');

    overlayPause().click();
    expect(state.readerSession?.getState().status).toBe('paused');
    expect(overlayPause().textContent).toBe('Resume');

    overlayPause().click();
    // The click has to start the session again, not just relabel the button.
    expect(state.readerSession?.getState().status).toBe('playing');
    expect(overlayPause().textContent).toBe('Pause');
  });

  it('keeps reading from where it paused', () => {
    mountReader();
    button('#silent-read-btn').click();
    const word = activeWord()!.textContent;

    overlayPause().click();
    const held = activeWord()!.textContent;
    expect(held).toBe(word);

    overlayPause().click();
    // Still the same word right after resuming: resume must not restart the
    // document.
    expect(activeWord()!.textContent).toBe(held);
  });
});

/**
 * Two controls a reader needs while a document is open. Both failures were
 * the same shape: the control existed in the markup but sat somewhere the
 * open-document layout hides or collapses, so it could not be clicked at all
 * — the export produced nothing and the OCR switch could not be reached.
 */
describe('reader controls — reachable with a document open', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the audiobook export out of the collapsed tools section', () => {
    mountReader();
    const exportBtn = document.getElementById('export-audiobook-btn');
    expect(exportBtn).not.toBeNull();
    // A click on a control inside a closed <details> lands on nothing: the
    // element is not rendered, so no handler ever runs.
    expect(exportBtn!.closest('details')).toBeNull();
    expect(exportBtn!.closest('.document-actions')).not.toBeNull();
  });

  it('leaves the OCR switch in a region the open-document layout keeps', () => {
    mountReader();
    const toggle = document.getElementById('ocr-toggle') as HTMLInputElement;
    expect(toggle).not.toBeNull();
    // The label is what a pointer actually clicks; the input itself is
    // visually hidden inside it.
    expect(toggle.closest('label.switch')).not.toBeNull();
    expect(document.getElementById('document-options')?.contains(toggle)).toBe(true);

    // The open-document layout hides the upload chrome. The options row must
    // not be in that list: with a scanned file open is exactly when the OCR
    // switch has to be reachable.
    const css = readFileSync(resolve(__dirname, '..', 'style.css'), 'utf8');
    const hideRule = css.slice(
      css.indexOf('body.document-open .header,'),
      css.indexOf('display: none;', css.indexOf('body.document-open .header,')),
    );
    expect(hideRule).not.toContain('.document-options');
  });
});
