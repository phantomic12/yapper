import { DocumentReaderSession, type ReaderState } from '../reader';
import type { AppState } from '../app-state';
import { showStatus } from '../dom-utils';
import { splitAtWord, type SplitSentence } from '../karaoke';

// ─── Streaming playback ──────────────────────────────────────────
// "Play" speaks the textarea content while it is still generating: the
// text is chunked into short pieces (see DocumentReaderSession), each
// chunk is a queue job, and a hidden player auto-advances as soon as
// the next chunk lands. Time-to-first-audio is one small chunk instead
// of the whole text.

const STREAM_CHUNK_CHARS = 160;

/**
 * Repaint the "now speaking" line so the word being read is marked.
 *
 * The parts always rejoin to the sentence text, so the visible words never
 * change — only the emphasis does. When the word cannot be located the
 * whole sentence is shown unmarked rather than leaving the line blank.
 */
export function paintSpeakingLine(el: HTMLElement, parts: SplitSentence | null): void {
  el.replaceChildren();
  if (!parts || (!parts.before && !parts.active && !parts.after)) return;
  el.append(document.createTextNode(`“${parts.before}`));
  if (parts.active) {
    const mark = document.createElement('mark');
    mark.className = 'stream-bar__word';
    mark.textContent = parts.active;
    el.append(mark);
  }
  el.append(document.createTextNode(`${parts.after}”`));
}

export function bindStreamPlayer(state: AppState): void {
  const playBtn = document.getElementById('stream-btn') as HTMLButtonElement;
  const bar = document.getElementById('stream-bar') as HTMLElement;
  const statusEl = document.getElementById('stream-status-text') as HTMLElement;
  const speakingEl = document.getElementById('stream-speaking') as HTMLElement;
  const pauseBtn = document.getElementById('stream-pause-btn') as HTMLButtonElement;
  const stopBtn = document.getElementById('stream-stop-btn') as HTMLButtonElement;
  const textInput = document.getElementById('text-input') as HTMLTextAreaElement;

  let session: DocumentReaderSession | null = null;
  // onHighlight fires on every audio timeupdate, so the same word is
  // reported dozens of times a second. Repainting only on a real change
  // keeps this from thrashing the DOM all the way through a document.
  let lastHighlight: { sentence: number; word: number } | null = null;

  // The "now speaking" line marks the word being read, so the bar reads
  // along with the voice instead of flashing a whole sentence per word.
  const clearSpeaking = (): void => {
    lastHighlight = null;
    paintSpeakingLine(speakingEl, null);
  };

  const renderState = (s: ReaderState): void => {
    if (s.status === 'finished') {
      statusEl.textContent = 'Finished';
      pauseBtn.disabled = true;
      clearSpeaking();
      return;
    }
    const label = s.status === 'paused'
      ? s.needsUserGesture
        ? 'Paused — click Play to continue'
        : 'Paused'
      : 'Playing';
    statusEl.textContent = `${label} · part ${Math.min(s.currentIndex + 1, s.totalChunks)}/${s.totalChunks}`;
    pauseBtn.textContent = s.status === 'paused' ? 'Resume' : 'Pause';
  };

  const stop = (): void => {
    session?.stop();
    session = null;
    bar.hidden = true;
    clearSpeaking();
    pauseBtn.disabled = false;
  };

  playBtn.addEventListener('click', () => {
    // A paused autoplay-blocked session resumes from the same button.
    if (session && session.getState().needsUserGesture) {
      session.resumeAfterGesture();
      return;
    }
    if (session && session.getState().status === 'paused') {
      session.resume();
      return;
    }
    const text = textInput.value.trim();
    if (!text) return;
    if (!state.engine || state.engine.getEngineState() !== 'ready') {
      showStatus('error', 'Load a model first, then press Play.');
      return;
    }
    session?.stop();
    session = new DocumentReaderSession(state.engine, text, {
      chunkSize: STREAM_CHUNK_CHARS,
      lookahead: 2,
      speed: state.currentSpeed,
      onStateChange: renderState,
      onHighlight: (info) => {
        if (
          lastHighlight &&
          lastHighlight.sentence === info.sentenceIndex &&
          lastHighlight.word === info.wordIndex
        ) {
          return;
        }
        const sentence = session?.getSentences()[info.sentenceIndex];
        if (!sentence) return;
        lastHighlight = { sentence: info.sentenceIndex, word: info.wordIndex };
        paintSpeakingLine(speakingEl, splitAtWord(sentence, info.wordIndex));
      },
    });
    bar.hidden = false;
    pauseBtn.disabled = false;
    renderState(session.getState());
    session.start();
  });

  pauseBtn.addEventListener('click', () => {
    if (!session) return;
    const s = session.getState();
    if (s.status === 'paused') {
      if (s.needsUserGesture) session.resumeAfterGesture();
      else session.resume();
    } else {
      session.pause();
    }
    renderState(session.getState());
  });

  stopBtn.addEventListener('click', stop);

  // The Play button mirrors the generate button's readiness gating.
  state.engine?.on('engineStateChange', (engineState) => {
    playBtn.disabled = engineState !== 'ready';
    if (engineState !== 'ready' && session) stop();
  });
}
