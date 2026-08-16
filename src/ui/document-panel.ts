import { extractDocument } from '../document-reader';
import {
  DocumentReaderSession,
  prepareReaderData,
  type ReaderState,
  type HighlightInfo,
  type ReaderSentence,
} from '../reader';
import type { AppState } from '../app-state';
import { showStatus } from '../dom-utils';

export function updateDocumentSectionVisibility(state: AppState): void {
  const needModel = document.getElementById('document-need-model') as HTMLElement;
  const readBtn = document.getElementById('read-document-btn') as HTMLButtonElement;
  const canRead = !!(state.engine && state.engine.getEngineState() === 'ready');
  if (needModel) needModel.style.display = canRead ? 'none' : '';
  readBtn.disabled = !canRead;
  readBtn.title = canRead ? 'Read extracted text aloud' : 'Load a model above before reading';
}

// ─── Document upload + reader ──────────────────────────────────────
export function bindDocumentEvents(state: AppState): void {
  const drop = document.getElementById('document-drop') as HTMLElement;
  const input = document.getElementById('document-upload') as HTMLInputElement;
  const ocrToggle = document.getElementById('ocr-toggle') as HTMLInputElement;
  const ocrModeSelector = document.getElementById('ocr-mode-selector') as HTMLElement;
  const documentProgress = document.getElementById('document-progress') as HTMLElement;
  const options = document.getElementById('document-options') as HTMLElement;
  const preview = document.getElementById('document-preview') as HTMLElement;
  const readerView = document.getElementById('document-reader-view') as HTMLElement;
  const readBtn = document.getElementById('read-document-btn') as HTMLButtonElement;
  const pauseBtn = document.getElementById('pause-document-btn') as HTMLButtonElement;
  const stopBtn = document.getElementById('stop-document-btn') as HTMLButtonElement;
  const readerStatus = document.getElementById('reader-status') as HTMLElement;
  const readerOverlay = document.getElementById('reader-overlay') as HTMLElement;
  const readerOverlayContent = document.getElementById('reader-overlay-content') as HTMLElement;
  const readerOverlayStatus = document.getElementById('reader-overlay-status') as HTMLElement;
  const readerOverlayPause = document.getElementById('reader-overlay-pause') as HTMLButtonElement;
  const readerOverlayStop = document.getElementById('reader-overlay-stop') as HTMLButtonElement;
  const readerOverlayClose = document.getElementById('reader-overlay-close') as HTMLButtonElement;
  const layoutDetails = document.getElementById('layout-details') as HTMLDetailsElement;
  const layoutPre = document.getElementById('layout-pre') as HTMLPreElement;

  function openReaderOverlay() {
    if (readerOverlay.style.display === 'none') {
      readerOverlay.style.display = '';
      readerOverlayStatus.textContent = readerStatus.textContent;
      document.body.style.overflow = 'hidden';
      readerOverlayClose.focus();
    }
  }
  function closeReaderOverlay() {
    readerOverlay.style.display = 'none';
    document.body.style.overflow = '';
  }

  function setProgress(msg: string) {
    documentProgress.textContent = msg;
    documentProgress.parentElement!.hidden = false;
    // If the message contains "page X/Y" or "OCR page X: N%", use that to
    // drive a progress bar. Falls back to an indeterminate state otherwise.
    const pageMatch = msg.match(/page\s+(\d+)\s*\/\s*(\d+)/i);
    const ocrMatch = msg.match(/OCR page\s+\d+:\s*(\d+)%/i);
    const fill = document.getElementById('document-progress-fill') as HTMLElement;
    if (pageMatch) {
      const pct = Math.min(100, Math.round((parseInt(pageMatch[1], 10) / parseInt(pageMatch[2], 10)) * 100));
      fill.style.width = `${pct}%`;
      fill.classList.remove('document-progress-bar__fill--indeterminate');
    } else if (ocrMatch) {
      fill.style.width = `${ocrMatch[1]}%`;
      fill.classList.remove('document-progress-bar__fill--indeterminate');
    } else if (msg) {
      fill.classList.add('document-progress-bar__fill--indeterminate');
    }
  }

  function clearProgress() {
    documentProgress.textContent = '';
    documentProgress.parentElement!.hidden = true;
    const fill = document.getElementById('document-progress-fill') as HTMLElement;
    fill.style.width = '0%';
    fill.classList.remove('document-progress-bar__fill--indeterminate');
  }

  function renderReaderContent(target: HTMLElement, text: string) {
    target.innerHTML = '';
    const { sentences } = prepareReaderData(text, 300);
    const sentenceByPara = new Map<number, ReaderSentence[]>();
    for (const s of sentences) {
      const list = sentenceByPara.get(s.paragraphIndex) ?? [];
      list.push(s);
      sentenceByPara.set(s.paragraphIndex, list);
    }
    const paragraphIndices = Array.from(sentenceByPara.keys()).sort((a, b) => a - b);
    for (const pIdx of paragraphIndices) {
      const p = document.createElement('p');
      p.className = 'reader-paragraph';
      for (const sentence of sentenceByPara.get(pIdx)!) {
        const sentenceSpan = document.createElement('span');
        sentenceSpan.className = 'reader-sentence';
        sentenceSpan.dataset.sentenceIndex = String(sentence.globalIndex);
        sentenceSpan.dataset.chunkIndex = String(sentence.globalIndex); // placeholder, updated later
        for (let w = 0; w < sentence.words.length; w++) {
          const wordSpan = document.createElement('span');
          wordSpan.className = 'reader-word';
          wordSpan.dataset.wordIndex = String(w);
          wordSpan.textContent = sentence.words[w];
          sentenceSpan.appendChild(wordSpan);
          if (w < sentence.words.length - 1) sentenceSpan.appendChild(document.createTextNode(' '));
        }
        p.appendChild(sentenceSpan);
        p.appendChild(document.createTextNode(' '));
      }
      target.appendChild(p);
    }
    return Array.from(target.querySelectorAll('.reader-sentence'));
  }

  function renderReaderView(text: string) {
    return renderReaderContent(readerView, text);
  }

  function renderOverlay(text: string) {
    return renderReaderContent(readerOverlayContent, text);
  }

  function findOverlaySentence(globalIndex: number): HTMLElement | null {
    return readerOverlayContent.querySelector(`[data-sentence-index="${globalIndex}"]`) as HTMLElement | null;
  }

  function handleFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      showStatus('error', 'File is too large. Maximum size is 25 MB.');
      return;
    }
    setProgress('Extracting text…');
    const useOcr = ocrToggle.checked && file.name.toLowerCase().endsWith('.pdf');
    extractDocument(file, { useOcr, ocrMode: state.ocrMode, onProgress: setProgress })
      .then(doc => {
        state.extractedDocument = doc;
        renderReaderView(doc.text);
        preview.style.display = '';
        options.style.display = '';
        layoutDetails.style.display = doc.layoutBlocks && doc.layoutBlocks.length ? '' : 'none';
        if (doc.layoutBlocks && doc.layoutBlocks.length) {
          layoutPre.textContent = JSON.stringify(doc.layoutBlocks.slice(0, 50), null, 2)
            + (doc.layoutBlocks.length > 50 ? '\n…' : '');
        }
        setProgress(`Loaded ${doc.name} · ${doc.text.length.toLocaleString()} chars`);
        readerView.focus();
      })
      .catch(err => {
        clearProgress();
        showStatus('error', `Could not read document: ${err instanceof Error ? err.message : String(err)}`, true);
      });
  }

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('document-drop--active');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('document-drop--active'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('document-drop--active');
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  });

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) handleFile(file);
  });

  // Show/hide the OCR mode selector when the OCR toggle changes.
  ocrToggle.addEventListener('change', () => {
    ocrModeSelector.style.display = ocrToggle.checked ? '' : 'none';
  });

  // Wire up OCR mode radio buttons.
  ocrModeSelector.querySelectorAll<HTMLInputElement>('input[name="ocr-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.ocrMode = radio.value as 'tesseract' | 'llm';
    });
  });

  let lastHighlightedWord: { sentence: number; word: number } | null = null;
  let activeSentenceElement: HTMLElement | null = null;

  function clearHighlight() {
    if (activeSentenceElement) {
      activeSentenceElement.classList.remove('reader-active-sentence');
      activeSentenceElement.querySelector('.reader-active-word')?.classList.remove('reader-active-word');
    }
    activeSentenceElement = null;
    lastHighlightedWord = null;
    // Reset all past-state markers in overlay / inline view
    document.querySelectorAll('.reader-sentence--past').forEach(el => {
      el.classList.remove('reader-sentence--past');
    });
  }

  function markSentencePast(globalIndex: number) {
    const el = findOverlaySentence(globalIndex) ?? readerView.querySelector(`[data-sentence-index="${globalIndex}"]`);
    if (el) el.classList.add('reader-sentence--past');
  }

  function applyHighlight(info: HighlightInfo) {
    if (
      lastHighlightedWord &&
      lastHighlightedWord.sentence === info.sentenceIndex &&
      lastHighlightedWord.word === info.wordIndex
    ) {
      return;
    }
    const sentence = findOverlaySentence(info.sentenceIndex) ?? readerView.querySelector(`[data-sentence-index="${info.sentenceIndex}"]`);
    if (!sentence) return;

    if (lastHighlightedWord && lastHighlightedWord.sentence !== info.sentenceIndex) {
      markSentencePast(lastHighlightedWord.sentence);
    }

    if (activeSentenceElement && activeSentenceElement !== sentence) {
      activeSentenceElement.classList.remove('reader-active-sentence');
    }
    activeSentenceElement?.querySelector('.reader-active-word')?.classList.remove('reader-active-word');

    sentence.classList.add('reader-active-sentence');
    activeSentenceElement = sentence as HTMLElement;
    const word = sentence.querySelector(`[data-word-index="${info.wordIndex}"]`);
    word?.classList.add('reader-active-word');
    lastHighlightedWord = { sentence: info.sentenceIndex, word: info.wordIndex };
    word?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderReaderState(readerState: ReaderState) {
    let statusText = `${readerState.currentIndex + 1}/${readerState.totalChunks}`;
    if (readerState.totalChunks > 1 && readerState.bufferedIndex >= 0) {
      statusText += ` · buffered ${readerState.bufferedIndex + 1}/${readerState.totalChunks}`;
    }
    readerStatus.textContent = statusText;
    readerOverlayStatus.textContent = statusText;
    readerOverlayPause.textContent =
      readerState.status === 'playing'
        ? 'Pause'
        : readerState.needsUserGesture
          ? 'Click to play'
          : 'Resume';
    if (readerState.status === 'playing') {
      readBtn.style.display = 'none';
      pauseBtn.style.display = '';
      stopBtn.style.display = '';
      pauseBtn.textContent = 'Pause';
      openReaderOverlay();
    } else if (readerState.status === 'paused') {
      readBtn.style.display = 'none';
      pauseBtn.style.display = '';
      stopBtn.style.display = '';
      // If the browser blocked autoplay, the pause button is the user's
      // path forward. Label it accordingly so they know what clicking
      // will do.
      pauseBtn.textContent = readerState.needsUserGesture ? 'Click to play' : 'Resume';
    } else if (readerState.status === 'finished') {
      readBtn.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      readerStatus.textContent = 'Finished';
      readerOverlayStatus.textContent = 'Finished';
      clearHighlight();
    } else {
      readBtn.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      readerStatus.textContent = '';
      readerOverlayStatus.textContent = '';
      clearHighlight();
    }
  }

  readBtn.addEventListener('click', () => {
    const text = state.extractedDocument?.text?.trim();
    if (!text) return;
    if (text.length > 20000) {
      showStatus('error', 'Text is too long to read in one session. Paste a shorter excerpt.', true);
      return;
    }
    state.readerSession?.stop();
    clearHighlight();
    renderOverlay(text);
    state.readerSession = new DocumentReaderSession(state.engine!, text, {
      chunkSize: 300,
      lookahead: 2,
      speed: state.currentSpeed,
      onStateChange: renderReaderState,
      onHighlight: applyHighlight,
    });
    state.readerSession.start();
  });

  pauseBtn.addEventListener('click', () => {
    if (!state.readerSession) return;
    // resumeAfterGesture is a no-op if not in needsUserGesture state, so
    // it's safe to call from any click. This avoids a class of bugs where
    // resume() from a click that wasn't user-initiated (e.g. programmatic
    // .click() from another handler) silently fails again.
    if (state.readerSession.getState().status === 'playing') {
      state.readerSession.pause();
    } else {
      state.readerSession.resumeAfterGesture();
    }
  });

  stopBtn.addEventListener('click', () => {
    state.readerSession?.stop();
    clearHighlight();
    closeReaderOverlay();
  });

  readerOverlayPause.addEventListener('click', () => {
    if (!state.readerSession) return;
    if (state.readerSession.getState().status === 'playing') {
      state.readerSession.pause();
    } else {
      state.readerSession.resumeAfterGesture();
    }
  });
  readerOverlayStop.addEventListener('click', () => {
    state.readerSession?.stop();
    clearHighlight();
    closeReaderOverlay();
  });
  readerOverlayClose.addEventListener('click', () => {
    state.readerSession?.stop();
    clearHighlight();
    closeReaderOverlay();
  });
  readerOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.readerSession?.stop();
      clearHighlight();
      closeReaderOverlay();
    }
  });
}
