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
