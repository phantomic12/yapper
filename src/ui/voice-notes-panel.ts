/**
 * The voice-notes rail: record, play back, and delete a spoken note attached
 * to the reader's current place in a document.
 *
 * The reader panel owns the document. This module never reaches into it:
 * `document-panel` dispatches one `yapper:reader-document` event when the
 * document or the reading position changes, and the rail reacts. That keeps
 * the recording code out of the 2,500-line panel and, more usefully, means the
 * rail can be exercised on its own in a test with nothing but an event.
 *
 * Playback is a single shared `<audio>` element rather than one per note:
 * browsers cap concurrent media elements, and two notes playing over each
 * other is never what the reader meant.
 */

import {
  MAX_VOICE_NOTE_MS,
  VoiceNoteRecorder,
  deleteVoiceNote,
  formatNoteDuration,
  loadVoiceNotes,
  putVoiceNote,
  type VoiceNoteRecord,
} from '../voice-notes';

/** Fired by document-panel whenever the open document or its position changes. */
export const READER_DOCUMENT_EVENT = 'yapper:reader-document';

export interface ReaderDocumentDetail {
  /** Progress key of the open file; null for a document with no file behind it. */
  key: string | null;
  name: string;
  /** Where a new note would be anchored: the reader's current offset. */
  offset: number;
  /** Extracted text, so the rail can quote the spot a note belongs to. */
  text: string;
}

const RECORD_LABEL = '● Record';
const STOP_LABEL = '■ Stop';
const TICK_MS = 250;

export function bindVoiceNotes(): void {
  // The rail ships with the app shell (layout.ts), the same way every other
  // panel's controls do; a missing node would be a build error, not a state
  // this code can recover from.
  const recordButton = document.getElementById('voice-note-record-btn') as HTMLButtonElement;
  const timerEl = document.getElementById('voice-note-timer') as HTMLElement;
  const statusEl = document.getElementById('voice-note-status') as HTMLElement;
  const list = document.getElementById('voice-note-list') as HTMLUListElement;

  const recorder = new VoiceNoteRecorder();
  const support = recorder.support;

  let current: ReaderDocumentDetail | null = null;
  /** Prefix for this document's records; null when nothing can be stored. */
  let storageKey: string | null = null;
  /** Identity of the document the rail is showing, so position updates are cheap. */
  let lastIdentity: string | null = null;
  let notes: VoiceNoteRecord[] = [];
  /** Where the current take started; the reading position may move under it. */
  let takeOffset = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let finishing = false;
  let playing: { id: string; audio: HTMLAudioElement; url: string } | null = null;

  function setStatus(message: string): void {
    statusEl.textContent = message;
  }

  function quoteAt(text: string, offset: number): string {
    const slice = text.slice(Math.max(0, offset), offset + 48).replace(/\s+/g, ' ').trim();
    if (!slice) return '';
    return text.length > offset + 48 ? `${slice}…` : slice;
  }

  function stopPlayback(): void {
    const active = playing;
    if (!active) return;
    playing = null;
    active.audio.pause?.();
    active.audio.removeAttribute('src');
    URL.revokeObjectURL(active.url);
  }

  function stopTicker(): void {
    clearInterval(ticker);
    ticker = undefined;
  }

  function render(): void {
    // An enabled Record button that can only fail is a lie about the page's
    // abilities; the reason is shown instead of discovered on click.
    recordButton.disabled = !support.canRecord || !storageKey;
    recordButton.title = !support.canRecord
      ? support.reason
      : !storageKey
        ? 'Open a document to attach a voice note to it'
        : 'Record a voice note at this spot';
    if (!support.canRecord) setStatus(support.reason);
    else if (!storageKey && current) setStatus('Open a document to attach a voice note to it.');
  }

  function renderList(): void {
    list.replaceChildren();
    const text = current?.text ?? '';
    for (const note of notes) {
      const item = document.createElement('li');
      item.className = 'docbookmarks__item';
      item.dataset.voiceNoteId = note.id;

      const textWrap = document.createElement('div');
      textWrap.className = 'docbookmarks__text';
      const label = document.createElement('span');
      label.className = 'docbookmarks__label-text';
      const quote = quoteAt(text, note.offset);
      label.textContent = quote
        ? `${formatNoteDuration(note.durationMs)} · “${quote}”`
        : `${formatNoteDuration(note.durationMs)} · position ${note.offset}`;
      textWrap.appendChild(label);

      const actions = document.createElement('div');
      actions.className = 'docbookmarks__actions';
      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.className = 'document-btn';
      playButton.dataset.action = 'play';
      const isPlaying = playing?.id === note.id;
      playButton.textContent = isPlaying ? STOP_LABEL : '▶ Play';
      playButton.setAttribute('aria-pressed', String(isPlaying));
      playButton.setAttribute('aria-label',
        `${isPlaying ? 'Stop' : 'Play'} voice note from ${formatNoteDuration(note.durationMs)} at position ${note.offset}`);
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'document-btn';
      removeButton.dataset.action = 'remove';
      removeButton.textContent = 'Remove';
      actions.append(playButton, removeButton);

      item.append(textWrap, actions);
      list.appendChild(item);
    }
  }

  function play(note: VoiceNoteRecord): void {
    if (playing?.id === note.id) {
      stopPlayback();
      renderList();
      return;
    }
    stopPlayback();
    const url = URL.createObjectURL(note.blob);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;
    playing = { id: note.id, audio, url };
    const finished = () => {
      if (playing?.audio !== audio) return;
      stopPlayback();
      renderList();
    };
    audio.addEventListener('ended', finished);
    audio.addEventListener('error', finished);
    // A rejected play() is a gesture or codec problem, not an exception the
    // rail should surface as a crash.
    const started = audio.play?.();
    if (started && typeof started.catch === 'function') {
      started.catch(() => {
        if (playing?.audio !== audio) return;
        stopPlayback();
        renderList();
        setStatus('The browser would not play this note.');
      });
    }
    renderList();
  }

  async function remove(id: string): Promise<void> {
    if (playing?.id === id) stopPlayback();
    notes = notes.filter(note => note.id !== id);
    renderList();
    const removed = await deleteVoiceNote(id);
    setStatus(removed ? 'Voice note deleted.' : 'Voice note removed from this session — browser storage is unavailable.');
  }

  function updateTimer(): void {
    timerEl.textContent = formatNoteDuration(recorder.elapsedMs());
    if (recorder.elapsedMs() >= MAX_VOICE_NOTE_MS) void finishRecording();
  }

  async function finishRecording(): Promise<void> {
    if (finishing || !recorder.recording) return;
    finishing = true;
    stopTicker();
    try {
      const result = await recorder.stop(takeOffset);
      recordButton.textContent = RECORD_LABEL;
      recordButton.setAttribute('aria-pressed', 'false');
      timerEl.textContent = '0:00';
      if (!result.ok) {
        setStatus(result.reason);
        return;
      }
      if (!storageKey) {
        setStatus('The note was recorded, but no document is open to keep it against.');
        return;
      }
      const record: VoiceNoteRecord = { ...result.note, documentKey: storageKey };
      notes = [...notes, record].sort((a, b) => a.offset - b.offset || a.createdAt - b.createdAt);
      renderList();
      // Written after the rail shows it: a slow or refused IndexedDB write
      // must not make the note the reader just spoke disappear.
      const saved = await putVoiceNote(record);
      setStatus(saved
        ? `Saved a ${formatNoteDuration(record.durationMs)} voice note at position ${record.offset}.`
        : `Recorded a ${formatNoteDuration(record.durationMs)} note, but browser storage refused it — it will be gone after a reload.`);
    } finally {
      finishing = false;
    }
  }

  async function startRecording(): Promise<void> {
    if (!storageKey || !current) {
      setStatus('Open a document before recording.');
      return;
    }
    if (!support.canRecord) {
      setStatus(support.reason);
      return;
    }
    const result = await recorder.start();
    if (!result.ok) {
      setStatus(result.reason);
      return;
    }
    // Captured once: the reading position can advance while the reader talks,
    // and a note must stay where it was recorded, not where reading got to.
    takeOffset = current.offset;
    recordButton.textContent = STOP_LABEL;
    recordButton.setAttribute('aria-pressed', 'true');
    timerEl.textContent = '0:00';
    setStatus(`Recording at position ${takeOffset}. Press stop when you are done.`);
    stopTicker();
    ticker = setInterval(updateTimer, TICK_MS);
  }

  recordButton.addEventListener('click', () => {
    void (recorder.recording ? finishRecording() : startRecording());
  });

  list.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    const item = button?.closest<HTMLElement>('[data-voice-note-id]');
    const note = notes.find(entry => entry.id === item?.dataset.voiceNoteId);
    if (!button || !note) return;
    if (button.dataset.action === 'play') play(note);
    else if (button.dataset.action === 'remove') void remove(note.id);
  });

  document.addEventListener(READER_DOCUMENT_EVENT, event => {
    const detail = (event as CustomEvent<ReaderDocumentDetail>).detail;
    if (!detail) return;
    current = detail;
    // Position updates arrive on every saved reading step. Only a new document
    // is worth re-reading the store for — and only a new document may cancel a
    // take, since reading on while recording is not a reason to lose the note.
    const identity = `${detail.key ?? ''}\u0000${detail.name}`;
    if (identity === lastIdentity) return;
    lastIdentity = identity;

    if (recorder.recording) {
      recorder.cancel();
      recordButton.textContent = RECORD_LABEL;
      recordButton.setAttribute('aria-pressed', 'false');
      timerEl.textContent = '0:00';
      stopTicker();
    }
    stopPlayback();
    // A document without a file behind it (the sample, a fetched page) still
    // gets a session key: the blobs are real, and reloading the same sample
    // should find them again.
    storageKey = detail.key
      ?? (detail.name ? `voice:session:${detail.name}` : null);
    notes = [];
    renderList();
    render();
    if (!storageKey) return;
    const requestedKey = storageKey;
    void loadVoiceNotes(requestedKey).then(loaded => {
      // The reader may have moved to another document while IndexedDB was
      // opening; those notes belong to the old one.
      if (requestedKey !== storageKey) return;
      notes = loaded;
      renderList();
      if (loaded.length) {
        setStatus(`${loaded.length} voice note${loaded.length === 1 ? '' : 's'} in this document.`);
      } else if (support.canRecord) {
        setStatus('');
      }
    });
  });

  render();
  renderList();
}
