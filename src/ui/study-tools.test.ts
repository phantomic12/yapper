/**
 * The study tools in the real reader: voice notes, bubble notes, and the
 * column-note self-test.
 *
 * The pure modules have their own tests; this file proves they are wired to
 * the page a reader actually uses — a marker lands on the word that was
 * picked, an answer survives in the store, and a covered column is genuinely
 * absent from the DOM until it is revealed (opacity alone would leak it to a
 * screen reader).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppState } from '../app-state';
import { documentBubbleNotesKey, loadDocumentBubbleNotes } from '../bubble-notes';
import { buildAppMarkup } from './layout';
import { bindDocumentEvents } from './document-panel';
import { READER_DOCUMENT_EVENT, bindVoiceNotes } from './voice-notes-panel';

const DOCUMENT_TEXT = 'First sentence here.\n\nSecond paragraph with more words.';

function button(selector: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(selector) as HTMLButtonElement;
}

function field(selector: string): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(selector) as HTMLTextAreaElement;
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Mount the shell and bind the reader, exactly as main.ts does. */
function mountReader() {
  document.body.innerHTML = buildAppMarkup({ capability: 'none', selectedModelId: 'kitten-nano' });
  const state = createAppState();
  bindDocumentEvents(state);
  bindVoiceNotes();
  return state;
}

/** Open a file through the real upload control, so every key is built as it is in the app. */
async function openFile(state: ReturnType<typeof createAppState>): Promise<File> {
  const file = new File([DOCUMENT_TEXT], 'notes.md', { type: 'text/markdown' });
  const input = document.getElementById('document-upload') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
  await until(() => state.extractedDocument !== null, 'the document to be extracted');
  return file;
}

function addColumnNote(text: string): void {
  button('#colnotes-add-btn').click();
  field('#colnotes-text').value = text;
  (document.getElementById('colnotes-form') as HTMLFormElement)
    .dispatchEvent(new Event('submit', { cancelable: true }));
}

const covers = (): NodeListOf<HTMLElement> =>
  document.querySelectorAll<HTMLElement>('#colnotes-list .colnotes__cover');

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('voice notes — no microphone', () => {
  it('says the browser cannot record instead of offering a button that fails', () => {
    mountReader();
    // jsdom exposes no mediaDevices and no MediaRecorder: the honest path.
    const status = document.getElementById('voice-note-status')!;
    expect(status.textContent).toContain('cannot record audio');
    expect(button('#voice-note-record-btn').disabled).toBe(true);
  });

  it('handles a document change without throwing', () => {
    mountReader();
    expect(() => {
      document.dispatchEvent(new CustomEvent(READER_DOCUMENT_EVENT, {
        detail: { key: 'doc:1:2', name: 'notes.md', offset: 12, text: DOCUMENT_TEXT },
      }));
    }).not.toThrow();
    expect(document.querySelectorAll('#voice-note-list li')).toHaveLength(0);
  });
});

describe('bubble notes — pinned in the reading text', () => {
  it('pins a question to the word at the reading position and keeps the answer', async () => {
    const state = mountReader();
    const file = await openFile(state);
    await until(() => !button('#bubble-add-btn').disabled, 'the bubble panel to open');

    button('#bubble-add-btn').click();
    expect(button('#bubble-add-btn').getAttribute('aria-expanded')).toBe('true');
    field('#bubble-prompt').value = 'What does first mean here?';
    (document.getElementById('bubble-form') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { cancelable: true }));

    const bubbles = document.querySelectorAll('#document-reader-view .bubble-note');
    expect(bubbles).toHaveLength(1);
    // A word anchor puts the marker right after the first word, not at the end
    // of the sentence.
    const marker = bubbles[0].querySelector<HTMLElement>('.bubble-note__marker')!;
    expect(marker.textContent).toBe('?');
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    expect(bubbles[0].previousElementSibling?.textContent).toBe('First');

    const stored = loadDocumentBubbleNotes(documentBubbleNotesKey(file));
    expect(stored).toHaveLength(1);
    expect(stored[0].prompt).toBe('What does first mean here?');
    expect(stored[0].anchor).toBe('word');

    // The marker opens the callout and moves focus into the answer box.
    marker.click();
    const answer = bubbles[0].querySelector<HTMLTextAreaElement>('.bubble-note__answer')!;
    expect(bubbles[0].classList.contains('bubble-note--open')).toBe(true);
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(answer);

    answer.value = 'The opening one.';
    answer.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => loadDocumentBubbleNotes(documentBubbleNotesKey(file))[0]?.answer === 'The opening one.',
      'the answer to be saved');
    expect(loadDocumentBubbleNotes(documentBubbleNotesKey(file))[0].answer).toBe('The opening one.');

    // Escape closes the pop-up and hands focus back to its marker.
    answer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bubbles[0].classList.contains('bubble-note--open')).toBe(false);
    expect(document.activeElement).toBe(marker);
  });
});

describe('column-note self-test — covering a column', () => {
  it('covers every note until revealed, one deliberate press at a time', async () => {
    const state = mountReader();
    await openFile(state);
    addColumnNote('Photosynthesis happens in the chloroplast.');
    addColumnNote('Mitochondria are the powerhouse.');

    const items = (): NodeListOf<HTMLElement> =>
      document.querySelectorAll<HTMLElement>('#colnotes-list .colnotes__item');
    expect(items()).toHaveLength(2);

    button('#colnote-quiz-btn').click();
    expect(button('#colnote-quiz-btn').getAttribute('aria-pressed')).toBe('true');
    expect(covers()).toHaveLength(2);
    // Covered text is not merely invisible: it is not in the document at all.
    expect(document.querySelectorAll('#colnotes-list .colnotes__note')).toHaveLength(0);
    expect(document.getElementById('colnote-quiz-status')!.textContent)
      .toBe('Self-test on — 2 of 2 notes covered, 0 revealed.');

    covers()[0].click();
    expect(document.querySelectorAll('#colnotes-list .colnotes__note')).toHaveLength(1);
    expect(covers()).toHaveLength(1);
    expect(document.getElementById('colnote-quiz-status')!.textContent)
      .toBe('Self-test on — 1 of 2 notes covered, 1 revealed.');
    // The reveal is only announced if focus moves onto the revealed text.
    const revealed = document.querySelector<HTMLElement>('#colnotes-list .colnotes__note');
    expect(document.activeElement).toBe(revealed);
    expect(revealed!.textContent).toBe('Photosynthesis happens in the chloroplast.');

    // Covering the other column re-hides everything: a reveal in one
    // direction says nothing about the other.
    const select = document.getElementById('colnote-cover-field') as HTMLSelectElement;
    select.value = 'cue';
    select.dispatchEvent(new Event('change'));
    expect(covers()).toHaveLength(2);
    expect(document.querySelectorAll('#colnotes-list .colnotes__note')).toHaveLength(2);

    button('#colnote-reveal-all-btn').click();
    expect(covers()).toHaveLength(0);

    button('#colnote-quiz-btn').click();
    expect(button('#colnote-quiz-btn').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('#colnotes-list .colnotes__note')).toHaveLength(2);
  });

  it('cannot be started without a document to quiz', () => {
    mountReader();
    button('#colnote-quiz-btn').click();
    expect(document.getElementById('colnote-quiz-status')!.textContent)
      .toBe('Self-test is on, but there are no column notes to cover yet.');
  });
});
