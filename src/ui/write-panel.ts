/**
 * The Write page: a talking editor.
 *
 * Three supports, all offline and all on the one drafting surface:
 *
 * - Word prediction — the frequency-ranked list offers completions for
 *   the word under the caret; click one, or Tab to take the first.
 * - Spell checking — "Check spelling" lists words with no dictionary
 *   entry, each with click-to-apply corrections.
 * - Talking editing — "Speak while typing" reads each finished word,
 *   and "Read text" reads the whole draft with the browser voice.
 *
 * The draft itself autosaves to localStorage like the reader's notes.
 */

import type { AppState } from '../app-state';
import { loadDictionary, loadFrequencyList } from '../dictionary';
import { findMisspellings, predictCompletions, suggestCorrections } from '../spellcheck';
import { ReadAloudController, readAloudSupported } from './read-aloud';

const DRAFT_KEY = 'yapper.write-draft.v1';
const WORD_CHAR = /[\p{L}\p{N}'’-]/u;

/** The partial word ending at the caret, or null when the caret rests elsewhere. */
function wordBeforeCaret(text: string, caret: number): { word: string; start: number } | null {
  let start = caret;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  const word = text.slice(start, caret).replace(/^['’-]+/, '');
  return word ? { word, start: start + (text.slice(start, caret).length - word.length) } : null;
}

export function bindWriteEvents(state: AppState): void {
  const editor = document.getElementById('write-editor') as HTMLTextAreaElement;
  const predict = document.getElementById('write-predict') as HTMLElement;
  const spellPanel = document.getElementById('write-spell') as HTMLElement;
  const speakBtn = document.getElementById('write-speak-btn') as HTMLButtonElement;
  const stopBtn = document.getElementById('write-stop-btn') as HTMLButtonElement;
  const typingSpeakBtn = document.getElementById('write-typing-speak-btn') as HTMLButtonElement;
  const spellBtn = document.getElementById('write-spell-btn') as HTMLButtonElement;
  const clearBtn = document.getElementById('write-clear-btn') as HTMLButtonElement;
  const status = document.getElementById('write-status') as HTMLElement;

  let frequency: string[] = [];
  let frequencyLoading = false;
  let speakWhileTyping = false;
  let lastLength = 0;

  const speaker = new ReadAloudController({
    onError: message => { status.textContent = message; },
    onEnd: () => { stopBtn.style.display = 'none'; speakBtn.style.display = ''; },
    onStateChange: s => {
      const playing = s === 'playing' || s === 'paused';
      stopBtn.style.display = playing ? '' : 'none';
      speakBtn.style.display = playing ? 'none' : '';
    },
  });

  function setStatus(message: string) {
    status.textContent = message;
    if (message) setTimeout(() => { if (status.textContent === message) status.textContent = ''; }, 4000);
  }

  /** Frequency list arrives on first use; predictions light up after it. */
  function ensureFrequency() {
    if (frequency.length || frequencyLoading) return;
    frequencyLoading = true;
    void loadFrequencyList().then(list => { frequency = list; updatePrediction(); });
  }

  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, editor.value); } catch { /* best-effort */ }
  }

  function updatePrediction() {
    if (!frequency.length) { predict.hidden = true; return; }
    const found = wordBeforeCaret(editor.value, editor.selectionStart);
    const suggestions = found ? predictCompletions(found.word, frequency) : [];
    predict.replaceChildren();
    if (!suggestions.length) { predict.hidden = true; return; }
    predict.hidden = false;
    for (const suggestion of suggestions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'docwords__chip write-predict__chip';
      chip.textContent = suggestion;
      chip.dataset.word = suggestion;
      predict.appendChild(chip);
    }
  }

  /** Insert `completion` over the partial word at the caret. */
  function applyCompletion(completion: string) {
    const found = wordBeforeCaret(editor.value, editor.selectionStart);
    if (!found) return;
    const before = editor.value.slice(0, found.start);
    const after = editor.value.slice(editor.selectionStart);
    editor.value = `${before}${completion} ${after}`;
    const caret = before.length + completion.length + 1;
    editor.setSelectionRange(caret, caret);
    saveDraft();
    updatePrediction();
    if (speakWhileTyping) speaker.speak([{ text: completion }], 0, {});
    editor.focus();
  }

  editor.value = (() => {
    try { return localStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
  })();
  lastLength = editor.value.length;

  editor.addEventListener('input', () => {
    ensureFrequency();
    updatePrediction();
    saveDraft();
    if (speakWhileTyping && readAloudSupported() && editor.value.length > lastLength) {
      const ch = editor.value[editor.selectionStart - 1];
      if (ch === ' ' || ch === '\n' || ch === '\t') {
        const text = editor.value.slice(0, editor.selectionStart);
        const found = wordBeforeCaret(text, text.trimEnd().length);
        if (found) speaker.speak([{ text: found.word }], 0, {});
      }
    }
    lastLength = editor.value.length;
  });

  // Tab takes the first suggestion — a predictive editor's muscle memory.
  editor.addEventListener('keydown', event => {
    if (event.key === 'Tab' && !predict.hidden) {
      const first = predict.querySelector<HTMLButtonElement>('.write-predict__chip');
      if (first?.dataset.word) {
        event.preventDefault();
        applyCompletion(first.dataset.word);
      }
    }
  });

  editor.addEventListener('click', updatePrediction);
  editor.addEventListener('keyup', event => {
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') updatePrediction();
  });

  predict.addEventListener('click', event => {
    const chip = (event.target as HTMLElement).closest<HTMLButtonElement>('.write-predict__chip');
    if (chip?.dataset.word) applyCompletion(chip.dataset.word);
  });

  speakBtn.addEventListener('click', () => {
    const text = editor.value.trim();
    if (!text) { setStatus('Nothing to read yet.'); return; }
    if (!readAloudSupported()) { setStatus('This browser has no built-in speech voice.'); return; }
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)
      .map(sentence => ({ text: sentence }));
    speaker.speak(sentences, 0, {});
  });

  stopBtn.addEventListener('click', () => speaker.stop());

  typingSpeakBtn.addEventListener('click', () => {
    speakWhileTyping = !speakWhileTyping;
    typingSpeakBtn.setAttribute('aria-pressed', String(speakWhileTyping));
    typingSpeakBtn.classList.toggle('document-btn--on', speakWhileTyping);
    if (!speakWhileTyping) speaker.stop();
    if (!readAloudSupported()) setStatus('This browser has no built-in speech voice.');
  });

  spellBtn.addEventListener('click', async () => {
    spellPanel.hidden = false;
    spellPanel.textContent = 'Checking…';
    spellBtn.disabled = true;
    const [dict, freq] = await Promise.all([loadDictionary(), loadFrequencyList()]);
    spellBtn.disabled = false;
    if (!dict) {
      spellPanel.textContent = 'Dictionary unavailable — spell check needs the bundled word list.';
      return;
    }
    if (freq.length && !frequency.length) frequency = freq;
    const misspelled = findMisspellings(editor.value, dict);
    spellPanel.replaceChildren();
    if (!misspelled.length) {
      spellPanel.textContent = editor.value.trim()
        ? 'No misspellings found.'
        : 'Nothing written yet.';
      return;
    }
    for (const miss of misspelled) {
      const row = document.createElement('div');
      row.className = 'write-spell__row';
      const word = document.createElement('span');
      word.className = 'write-spell__word';
      word.textContent = miss.count > 1 ? `${miss.word} ×${miss.count}` : miss.word;
      row.appendChild(word);
      const suggestions = freq.length ? suggestCorrections(miss.word, freq, 4) : [];
      if (!suggestions.length) {
        const none = document.createElement('span');
        none.className = 'write-spell__none';
        none.textContent = 'no suggestion';
        row.appendChild(none);
      }
      for (const suggestion of suggestions) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'docwords__chip';
        chip.textContent = suggestion;
        chip.dataset.fix = suggestion;
        chip.dataset.word = miss.word;
        chip.dataset.offset = String(miss.start);
        chip.dataset.length = String(miss.end - miss.start);
        row.appendChild(chip);
      }
      spellPanel.appendChild(row);
    }
  });

  // A correction replaces the flagged occurrence; a change since the check
  // that no longer matches is left alone rather than mangled.
  spellPanel.addEventListener('click', event => {
    const chip = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-fix]');
    if (!chip?.dataset.fix) return;
    const offset = Number(chip.dataset.offset);
    const length = Number(chip.dataset.length);
    const current = editor.value.slice(offset, offset + length);
    if (current.toLowerCase() !== (chip.dataset.word ?? '').toLowerCase()) {
      setStatus(`"${current}" changed since the check — re-check spelling.`);
      return;
    }
    const fix = chip.dataset.fix;
    editor.value = editor.value.slice(0, offset) + fix + editor.value.slice(offset + length);
    editor.setSelectionRange(offset + fix.length, offset + fix.length);
    saveDraft();
    chip.closest('.write-spell__row')?.remove();
    editor.focus();
  });

  clearBtn.addEventListener('click', () => {
    speaker.stop();
    editor.value = '';
    saveDraft();
    spellPanel.hidden = true;
    predict.hidden = true;
    editor.focus();
  });

  void state; // reserved for future voice-model reading on the Write page
}
