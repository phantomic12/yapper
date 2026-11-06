/**
 * The section-voice panel, exercised through the real markup and the real
 * document bindings.
 *
 * The pure splitter is proven in `section-voices.test.ts`; this file proves the
 * affordance reaches it — that "Tag paragraph" really tags the paragraph at
 * the cursor, that a selection really becomes a range, that Clear all really
 * returns the document to one voice, and that none of it offers a voice the
 * loaded model does not have.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAppState } from '../app-state';
import type { TTSEngine } from '../engine';
import { documentSectionVoicesKey, loadSectionVoices } from '../section-voices';
import { buildAppMarkup } from './layout';
import { bindDocumentEvents } from './document-panel';
import { bindSectionVoices, setSectionVoiceDocument } from './section-voices-panel';

const VOICES = [
  { id: 'af_heart', name: 'Heart' },
  { id: 'am_adam', name: 'Adam' },
];

function fakeEngine(voices: Array<{ id: string; name: string }> = VOICES): TTSEngine {
  return {
    getEngineState: () => 'ready',
    getCurrentModel: () => ({
      id: 'kokoro-82m',
      name: 'Kokoro-82M',
      voices,
      defaultVoiceId: voices[0]?.id,
    }),
    enqueue: vi.fn(() => ({ id: 'job-1', status: 'pending', url: undefined })),
    cancel: vi.fn(),
    on: vi.fn(() => () => {}),
  } as unknown as TTSEngine;
}

function mount(options: { engine?: TTSEngine } = {}) {
  document.body.innerHTML = buildAppMarkup({ capability: 'none', selectedModelId: 'kitten-nano' });
  const state = createAppState();
  state.engine = options.engine ?? null;
  state.selectedVoiceId = 'af_heart';
  bindDocumentEvents(state);
  bindSectionVoices(state);
  (document.getElementById('document-sample-btn') as HTMLButtonElement).click();
  return state;
}

const button = (selector: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(selector)!;

function tagListItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#section-voice-list [data-section-voice-id]'));
}

describe('section voices panel', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('disables tagging when no model is loaded', () => {
    mount();
    const select = document.getElementById('section-voice-picker') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(button('#section-voice-paragraph-btn').disabled).toBe(true);
    expect(button('#section-voice-selection-btn').disabled).toBe(true);
    expect(button('#section-voice-clear-btn').disabled).toBe(true);
  });

  it('offers the active model’s voices', () => {
    mount({ engine: fakeEngine() });
    const select = document.getElementById('section-voice-picker') as HTMLSelectElement;
    expect(Array.from(select.options).map(option => option.textContent)).toEqual(['Heart', 'Adam']);
    expect(select.disabled).toBe(false);
    expect(button('#section-voice-paragraph-btn').disabled).toBe(false);
  });

  it('tags the paragraph at the reading cursor', () => {
    const state = mount({ engine: fakeEngine() });
    button('#silent-read-btn').click();
    expect(state.readerSession).not.toBeNull();

    const select = document.getElementById('section-voice-picker') as HTMLSelectElement;
    select.value = 'am_adam';
    button('#section-voice-paragraph-btn').click();

    expect(tagListItems()).toHaveLength(1);
    expect(document.getElementById('section-voice-status')?.textContent).toContain('Adam');
    // The live session was re-planned: some chunk now speaks in Adam's voice.
    expect(state.readerSession!.getChunks().some(chunk => chunk.voiceId === 'am_adam')).toBe(true);
    // The page text is untouched — the view still holds the same words.
    expect(document.querySelector('.reader-word')).not.toBeNull();
  });

  it('tags the current selection', () => {
    const state = mount({ engine: fakeEngine() });
    button('#silent-read-btn').click();

    const word = document.querySelectorAll<HTMLElement>('.reader-word')[1];
    const textNode = word.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const select = document.getElementById('section-voice-picker') as HTMLSelectElement;
    select.value = 'am_adam';
    button('#section-voice-selection-btn').click();

    expect(tagListItems()).toHaveLength(1);
    const tagged = state.readerSession!.getChunks().find(chunk => chunk.voiceId === 'am_adam');
    expect(tagged?.text).toBe(word.textContent);
    selection.removeAllRanges();
  });

  it('says so when nothing is selected', () => {
    mount({ engine: fakeEngine() });
    button('#silent-read-btn').click();
    window.getSelection()?.removeAllRanges();
    button('#section-voice-selection-btn').click();
    expect(document.getElementById('section-voice-status')?.textContent).toMatch(/select some text/i);
    expect(tagListItems()).toHaveLength(0);
  });

  it('clears every tag and returns the document to one voice', () => {
    const state = mount({ engine: fakeEngine() });
    button('#silent-read-btn').click();
    button('#section-voice-paragraph-btn').click();
    expect(tagListItems()).toHaveLength(1);

    button('#section-voice-clear-btn').click();

    expect(tagListItems()).toHaveLength(0);
    expect(state.readerSession!.getChunks().every(chunk => chunk.voiceId === undefined)).toBe(true);
    expect(document.getElementById('section-voice-status')?.textContent).toMatch(/cleared/i);
  });

  it('removes one tag from the list', () => {
    mount({ engine: fakeEngine() });
    button('#silent-read-btn').click();
    button('#section-voice-paragraph-btn').click();
    expect(tagListItems()).toHaveLength(1);

    const remove = document.querySelector<HTMLButtonElement>('[data-section-voice-remove]')!;
    remove.click();

    expect(tagListItems()).toHaveLength(0);
  });

  it('persists tags for a file-backed document', () => {
    mount({ engine: fakeEngine() });
    button('#silent-read-btn').click();
    // Swap in a file identity and tag; this is the same path an uploaded
    // document takes through `showDocument`.
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    setSectionVoiceDocument(file);
    button('#section-voice-paragraph-btn').click();

    expect(loadSectionVoices(documentSectionVoicesKey(file))).toHaveLength(1);
  });

  it('does nothing when the markup is absent', () => {
    document.body.innerHTML = '';
    expect(() => bindSectionVoices(createAppState())).not.toThrow();
  });
});
