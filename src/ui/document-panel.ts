import { extractDocument, type ExtractedDocument } from '../document-reader';
import {
  DocumentReaderSession,
  prepareReaderData,
  sentenceAtOffset,
  type ReaderState,
  type HighlightInfo,
  type ReaderSentence,
} from '../reader';
import {
  classifyText,
  classifyLayoutBlocks,
  countKinds,
  kindLabel,
  renderBlockHtml,
  type ClassifiedBlock,
  type BlockKind,
} from '../document-classify';
import type { AppState } from '../app-state';
import { showStatus } from '../dom-utils';
import { SAMPLE_DOCUMENT } from '../sample-document';
import { mountHtmlView, mountPdfView, type DocumentView } from './document-view';

const MAX_RENDERED_BLOCKS = 60;

/**
 * Render the classified document structure (kind chips + per-block list
 * with a "Speak" action) into the Reader page's classify panel.
 */
function renderClassification(doc: ExtractedDocument): ClassifiedBlock[] {
  const panel = document.getElementById('classify-panel') as HTMLElement;
  const chips = document.getElementById('classify-chips') as HTMLElement;
  const list = document.getElementById('classify-list') as HTMLElement;
  const blocks = doc.layoutBlocks && doc.layoutBlocks.length > 0
    ? classifyLayoutBlocks(doc.layoutBlocks)
    : classifyText(doc.text);

  const counts = countKinds(blocks);
  chips.innerHTML = (Object.entries(counts) as [BlockKind, number][])
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `<span class="classify-chip classify-chip--${kind}">${kindLabel(kind)} · ${n}</span>`)
    .join('');

  list.innerHTML = blocks.slice(0, MAX_RENDERED_BLOCKS).map((b, i) => `
    <div class="classify-block classify-block--${b.kind}">
      <div class="classify-block__head">
        <span class="classify-badge classify-badge--${b.kind}">${kindLabel(b.kind)}</span>
        ${b.page ? `<span class="classify-block__page">page ${b.page}</span>` : ''}
        <button class="classify-block__speak" data-action="speak-block" data-block-index="${i}" type="button" title="Add this block to the queue">Speak</button>
      </div>
      <div class="classify-block__text">${renderBlockHtml(b.kind, b.text, { maxChars: 240 })}</div>
    </div>`).join('')
    + (blocks.length > MAX_RENDERED_BLOCKS
      ? `<p class="classify-more">…and ${blocks.length - MAX_RENDERED_BLOCKS} more blocks</p>`
      : '');

  panel.hidden = false;
  return blocks;
}

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
  const readerError = document.getElementById('reader-error') as HTMLElement;
  const readerOverlay = document.getElementById('reader-overlay') as HTMLElement;
  const readerOverlayContent = document.getElementById('reader-overlay-content') as HTMLElement;
  const readerOverlayStatus = document.getElementById('reader-overlay-status') as HTMLElement;
  const readerOverlayPause = document.getElementById('reader-overlay-pause') as HTMLButtonElement;
  const readerOverlayStop = document.getElementById('reader-overlay-stop') as HTMLButtonElement;
  const readerOverlayClose = document.getElementById('reader-overlay-close') as HTMLButtonElement;
  const layoutDetails = document.getElementById('layout-details') as HTMLDetailsElement;
  const layoutPre = document.getElementById('layout-pre') as HTMLPreElement;
  const sampleEl = document.getElementById('document-sample') as HTMLElement;
  const sampleBtn = document.getElementById('document-sample-btn') as HTMLButtonElement;
  const docViewHost = document.getElementById('document-view') as HTMLElement;
  const docViewSwitch = document.querySelector('.docview-switch') as HTMLElement | null;
  const docViewBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-docview]'),
  );

  /**
   * The file the reader is currently showing, kept so the document view can
   * re-open it. Deliberately not put on `ExtractedDocument`: that is the
   * result of reading a file, and handing it the file back would make every
   * stored/serialised document carry a File it has no use for.
   */
  let sourceFile: File | null = null;
  /** The mounted visual view, if the current document has one. */
  let docView: DocumentView | null = null;
  /** Sentences of the current document, so a highlight can be resolved to a
   *  character range and handed to the document view. */
  let readerSentences: ReaderSentence[] = [];
  /**
   * Whether the next play should take over the screen with the reading overlay.
   *
   * True for the Read button, false when reading was started by clicking a
   * sentence in the document. The overlay is the whole point of the text view,
   * and exactly the wrong thing when the user has just pointed at a page and
   * wants to watch the highlight move over it.
   */
  let openOverlayOnPlay = true;

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
    if (target === readerView) readerSentences = sentences;
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

  let classifiedBlocks: ClassifiedBlock[] = [];
  let docViewMode: 'document' | 'text' = 'text';
  let hasDocView = false;

  /**
   * Paint the Document/Text switch from state.
   *
   * The text view is hidden rather than emptied when the document view is on
   * top: it is the accessible view, and it is also what the reader's own
   * sentence lookup walks, so leaving it populated means switching back is a
   * repaint rather than a re-render.
   */
  function applyDocViewMode() {
    const showDoc = hasDocView && docViewMode === 'document';
    // No visual form worth showing means no switch at all. A "Document" tab
    // that renders nothing is worse than no tab: it invites a click that
    // appears to do nothing.
    if (docViewSwitch) docViewSwitch.hidden = !hasDocView;
    docViewHost.hidden = !showDoc;
    readerView.hidden = showDoc;
    for (const btn of docViewBtns) {
      const on = btn.dataset.docview === (showDoc ? 'document' : 'text');
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('docview-switch__btn--active', on);
    }
  }

  function setDocViewMode(mode: 'document' | 'text') {
    docViewMode = mode;
    applyDocViewMode();
  }

  for (const btn of docViewBtns) {
    btn.addEventListener('click', () => {
      if (btn.dataset.docview === 'document' && !hasDocView) return;
      setDocViewMode(btn.dataset.docview === 'document' ? 'document' : 'text');
      if (btn.dataset.docview === 'document') docViewHost.focus();
      else readerView.focus();
    });
  }

  /** Tear down the previous document's view before showing a new one. */
  function destroyDocView() {
    docView?.destroy();
    docView = null;
    hasDocView = false;
    docViewHost.replaceChildren();
  }

  /**
   * Mount the visual view for a document, if it has one.
   *
   * PDFs render from their anchors, DOCX and EPUB from stamped markup. A
   * plain-text or spreadsheet import has no visual form worth showing, so the
   * switch stays hidden and the reader keeps the text view it always had —
   * rather than offering a Document tab that would show nothing.
   */
  async function mountDocumentView(doc: ExtractedDocument) {
    destroyDocView();
    try {
      if (sourceFile && doc.anchors?.length) {
        docView = await mountPdfView(docViewHost, sourceFile, doc.anchors, {
          onError: (err, page) => {
            // A page that will not rasterise is a real problem the user can
            // see, so it is said out loud rather than left as a blank page.
            console.warn(`[reader] page ${page} failed to render`, err);
          },
          onPick: readFromOffset,
        });
      } else if (doc.html) {
        docView = mountHtmlView(docViewHost, doc.html, doc.name, {
          onPick: readFromOffset,
        });
      } else {
        return;
      }
      hasDocView = true;
      applyDocViewMode();
      // A document opened while the reader is already part-way through should
      // not start with its highlight missing.
      if (lastHighlightedWord) {
        const s = readerSentences.find(x => x.globalIndex === lastHighlightedWord!.sentence);
        if (s?.start !== undefined && s.end !== undefined) docView.highlight(s.start, s.end);
      }
    } catch (err) {
      // Falling back to the text view is a working reader with fewer pixels,
      // which beats an error page for the whole document.
      destroyDocView();
      setDocViewMode('text');
      console.warn('[reader] document view unavailable, showing text instead', err);
    }
  }

  /**
   * Show an extracted document in the Reader page. Shared by the upload path
   * and the built-in sample, so the sample goes through exactly the same
   * rendering as a real file instead of a simplified preview.
   */
  function showDocument(doc: ExtractedDocument, file: File | null) {
    state.extractedDocument = doc;
    sourceFile = file;
    renderReaderView(doc.text);
    classifiedBlocks = renderClassification(doc);
    preview.style.display = '';
    options.style.display = '';
    // The sample offer has done its job once there is a document to look at.
    sampleEl.hidden = true;
    layoutDetails.style.display = doc.layoutBlocks && doc.layoutBlocks.length ? '' : 'none';
    if (doc.layoutBlocks && doc.layoutBlocks.length) {
      layoutPre.textContent = JSON.stringify(doc.layoutBlocks.slice(0, 50), null, 2)
        + (doc.layoutBlocks.length > 50 ? '\n…' : '');
    }
    setProgress(`Loaded ${doc.name} · ${doc.text.length.toLocaleString()} chars`);
    // Reset the switch for the new document before mounting decides whether
    // one is even available; otherwise the previous file's choice would carry
    // over and hide the text of a file that has no visual view.
    docViewMode = 'document';
    destroyDocView();
    void mountDocumentView(doc);
    readerView.focus();
  }

  sampleBtn.addEventListener('click', () => {
    clearReaderError();
    setProgress('Loading sample…');
    // No file: the sample is a plain-text document, so there is nothing to
    // render as pages and the switch stays hidden.
    showDocument({ ...SAMPLE_DOCUMENT }, null);
  });

  function handleFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      showStatus('error', 'File is too large. Maximum size is 25 MB.');
      return;
    }
    clearReaderError();
    setProgress('Extracting text…');
    const useOcr = ocrToggle.checked && file.name.toLowerCase().endsWith('.pdf');
    extractDocument(file, { useOcr, ocrMode: state.ocrMode, onProgress: setProgress })
      .then(doc => {
        showDocument(doc, file);
      })
      .catch(err => {
        clearProgress();
        // Surface the failure in the reader panel itself, not just the
        // transient top banner: extraction errors (corrupt file, engine
        // missing Promise.try, stalled pdfjs worker) used to leave this
        // panel stuck on "Reading PDF file…" with no visible explanation.
        showReaderError(err instanceof Error ? err.message : String(err));
      });
  }

  function showReaderError(message: string) {
    readerError.textContent = `⚠️ ${message}`;
    readerError.hidden = false;
    showStatus('error', `Could not read document: ${message}`, true);
  }

  function clearReaderError() {
    readerError.hidden = true;
    readerError.textContent = '';
  }

  /**
   * Say something in the reader panel itself, in the current page's own words.
   *
   * Deliberately not `showStatus()`: that banner lives inside the Studio page,
   * so an action taken here writes a message the user cannot see and the
   * control just looks broken. Everything on the Reader page reports through
   * `reader-error` for the same reason `showReaderError` writes there too.
   */
  function showReaderNotice(message: string) {
    readerError.textContent = `⚠️ ${message}`;
    readerError.hidden = false;
  }

  // "Speak" on a classified block: queue just that block's text.
  document.getElementById('classify-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action="speak-block"]');
    if (!btn) return;
    const block = classifiedBlocks[Number(btn.dataset.blockIndex)];
    if (!block) return;
    if (!state.engine || state.engine.getEngineState() !== 'ready') {
      showReaderNotice('Load a model on the Studio page first.');
      return;
    }
    state.engine.enqueue(block.text, {
      modelId: state.selectedModel.id,
      voiceId: state.selectedVoiceId,
      speed: state.currentSpeed,
    });
    showStatus('success', `Queued ${kindLabel(block.kind).toLowerCase()} for speech.`);
  });

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
  // Reflect the (possibly restored-from-localStorage) mode into the radios:
  // the markup hardcodes `checked` on tesseract, so without this a saved
  // 'llm' choice renders visually as tesseract while state still holds llm.
  const ocrModeRadios = ocrModeSelector.querySelectorAll<HTMLInputElement>(
    'input[name="ocr-mode"]',
  );
  for (const radio of ocrModeRadios) {
    radio.checked = radio.value === state.ocrMode;
  }

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

    // Drive the document view from the same signal. The span comes from the
    // sentence segmentation rather than from anything view-specific, so the
    // text view and the rendered page always agree on where the reader is.
    const active = readerSentences.find(s => s.globalIndex === info.sentenceIndex);
    if (active?.start !== undefined && active.end !== undefined) {
      docView?.highlight(active.start, active.end);
    }
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
      if (openOverlayOnPlay) openReaderOverlay();
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

  /**
   * Start a reading session, beginning at the start or at one sentence.
   *
   * One place builds a session, so the Read button and a click on the document
   * cannot drift apart in chunk size, speed, or how the callbacks are wired —
   * the kind of difference that surfaces later as "clicking reads at a
   * different rate".
   */
  function beginReading(fromSentenceIndex: number, overlay: boolean) {
    const text = state.extractedDocument?.text?.trim();
    if (!text) return;
    if (text.length > 20000) {
      showReaderNotice('Text is too long to read in one session. Paste a shorter excerpt.');
      return;
    }
    openOverlayOnPlay = overlay;
    state.readerSession?.stop();
    clearHighlight();
    clearReaderError();
    renderOverlay(text);
    state.readerSession = new DocumentReaderSession(state.engine!, text, {
      chunkSize: 300,
      lookahead: 2,
      speed: state.currentSpeed,
      onStateChange: renderReaderState,
      onHighlight: applyHighlight,
    });
    state.readerSession.start(fromSentenceIndex);
  }

  /**
   * Read from wherever the user clicked on the document.
   *
   * A new session is started rather than the current one seeked, because
   * `stop()` cancels the queued synthesis for the old position: clicking into
   * chapter twelve should not keep generating chapter one in the background.
   *
   * Without a loaded model there is nothing to synthesise with, so the click
   * still moves the highlight and says why — a click that does nothing at all
   * reads as a broken document view rather than a missing model.
   */
  function readFromOffset(offset: number) {
    const sentence = sentenceAtOffset(readerSentences, offset);
    if (!sentence) return;

    // Move the highlight the moment the click happens. The session's own
    // highlight only arrives once the first chunk has been synthesised and
    // started playing, which on a CPU/WASM model is seconds later — long
    // enough for the click to look like it did nothing at all.
    if (sentence.start !== undefined && sentence.end !== undefined) {
      docView?.highlight(sentence.start, sentence.end);
    }

    if (state.engine?.getEngineState() !== 'ready') {
      showReaderNotice('Load a model on the Studio page first.');
      return;
    }
    beginReading(sentence.globalIndex, false);
  }

  readBtn.addEventListener('click', () => beginReading(0, true));

  pauseBtn.addEventListener('click', () => {
    if (!state.readerSession) return;
    // resumeAfterGesture() resumes from any paused state — including an
    // ordinary Pause, not just an autoplay block — and being in a real
    // click is what makes the play() permitted.
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
