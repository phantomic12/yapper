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
import {
  loadDocumentProgress,
  saveDocumentProgress,
  documentProgressKey,
  loadDocumentBookmarks,
  saveDocumentBookmarks,
  documentBookmarksKey,
  loadDocumentHighlights,
  saveDocumentHighlights,
  documentHighlightsKey,
  loadRecentDocuments,
  recordRecentDocument,
  type DocumentBookmark,
  type DocumentHighlight,
  type DocumentReadingProgress,
} from '../persistence';
import { mountHtmlView, mountPdfView, type DocumentView } from './document-view';
import { paginateIntoPages, type PagePagination } from './pagination';
import { isFlowableMime } from '../document-types';
import { parseOffsetAttr } from '../document-html';
import { findMatches, matchSnippet } from './document-search';
import { countWords, formatStatusBar, positionPercent } from './document-stats';
import { buildExport, buildNotesExport, type ExportFile, type ExportFormat } from './document-export';
import { ReadAloudController } from './read-aloud';
import { wordIndexAtChar, wordSpanInDocument } from '../karaoke';
import { createAudiobookBundle } from '../audiobook';
import {
  buildReviewScript,
  reviewScriptText,
  type ReviewScriptText,
  type ReviewSegment,
} from './document-review';

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
  const bookmarkPanel = document.getElementById('docbookmarks') as HTMLElement;
  const bookmarkAddBtn = document.getElementById('bookmark-add-btn') as HTMLButtonElement;
  const bookmarkForm = document.getElementById('bookmark-form') as HTMLFormElement;
  const bookmarkName = document.getElementById('bookmark-name') as HTMLInputElement;
  const bookmarkNote = document.getElementById('bookmark-note') as HTMLTextAreaElement;
  const bookmarkCancelBtn = document.getElementById('bookmark-cancel-btn') as HTMLButtonElement;
  const bookmarkList = document.getElementById('bookmark-list') as HTMLElement;
  const highlightPanel = document.getElementById('dochighlights') as HTMLElement;
  const highlightAddBtn = document.getElementById('highlight-add-btn') as HTMLButtonElement;
  const highlightForm = document.getElementById('highlight-form') as HTMLFormElement;
  const highlightColor = document.getElementById('highlight-color') as HTMLSelectElement;
  const highlightNote = document.getElementById('highlight-note') as HTMLTextAreaElement;
  const highlightCancelBtn = document.getElementById('highlight-cancel-btn') as HTMLButtonElement;
  const highlightList = document.getElementById('highlight-list') as HTMLElement;
  const statusBar = document.getElementById('doc-statusbar') as HTMLElement | null;
  const recentPanel = document.getElementById('docrecent') as HTMLElement;
  const recentList = document.getElementById('docrecent-list') as HTMLElement;
  const sessionSearchInput = document.getElementById('docsearch-input') as HTMLInputElement;
  const sessionSearchResults = document.getElementById('docsearch-results') as HTMLElement;
  const readaloudBtn = document.getElementById('readaloud-btn') as HTMLButtonElement;
  const readaloudSpeedBtn = document.getElementById('readaloud-speed-btn') as HTMLButtonElement;
  const reviewBtn = document.getElementById('review-notes-btn') as HTMLButtonElement;
  const audiobookBtn = document.getElementById('export-audiobook-btn') as HTMLButtonElement;
  const shortcutsBtn = document.getElementById('shortcuts-btn') as HTMLButtonElement;
  const shortcutHelp = document.getElementById('shortcut-help') as HTMLElement;
  const shortcutHelpClose = document.getElementById('shortcut-help-close') as HTMLButtonElement;
  const blackout = document.getElementById('blackout') as HTMLElement;

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
  let progressKey: string | null = null;
  let savedProgress: ReturnType<typeof loadDocumentProgress> = null;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let lastProgressOffset = 0;
  let activeFileRequest = 0;
  let bookmarksKey: string | null = null;
  let bookmarks: DocumentBookmark[] = [];
  let highlightsKey: string | null = null;
  let highlights: DocumentHighlight[] = [];
  /** Offset to jump to once the next document finishes mounting. */
  let pendingGoToOffset: number | null = null;
  /** Range captured by the highlight form while its note is being written. */
  let pendingHighlight: { start: number; end: number } | null = null;
  let sessionSearchTimer: ReturnType<typeof setTimeout> | undefined;

  const QUICK_RATES = [0.75, 1, 1.25, 1.5];
  let quickRateIndex = 1;
  /** The review script currently being spoken, for follow-along painting. */
  let reviewSegments: ReviewSegment[] = [];
  /**
   * Which document the model session is speaking, if one is: 'document' for
   * the file's own text (quick read / Read button), 'review' for the notes
   * script. The browser-voice paths leave this null.
   */
  let modelSpeechKind: 'document' | 'review' | null = null;
  /** Sessions cap here — the same limit the Read button enforces. */
  const MAX_MODEL_READ_CHARS = 20000;

  const fileIdentity = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
  /** Everything opened this session, so search can span documents. */
  const sessionDocs = new Map<string, { file: File; doc: ExtractedDocument }>();
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

  /**
   * The reading surfaces as page sheets.
   *
   * The text view and the reading overlay are the places the document is
   * actually read (and where the live highlight moves), so they lay their
   * paragraphs out as pages rather than one endless column. The flow is kept
   * per surface and re-run on every render: paragraphs are rebuilt from
   * scratch, but the observer that re-pages them when they become visible
   * does not need to be.
   */
  const pageFlows = new Map<HTMLElement, PagePagination>();
  function paginateTarget(target: HTMLElement) {
    const flow = pageFlows.get(target);
    if (flow) {
      flow.layout();
    } else {
      pageFlows.set(target, paginateIntoPages(target));
    }
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
    paginateTarget(target);
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
    scheduleProgressSave();
  }

  function scheduleProgressSave(position?: {
    page?: number;
    offset?: number;
    scale?: number;
    theme?: DocumentReadingProgress['theme'];
    fontFamily?: DocumentReadingProgress['fontFamily'];
  }) {
    if (position?.offset !== undefined) lastProgressOffset = position.offset;
    updateStatusBar();
    if (!progressKey) return;
    savedProgress = {
      offset: position?.offset ?? lastProgressOffset,
      page: position?.page ?? docView?.activePage ?? savedProgress?.page,
      scale: position?.scale ?? docView?.scale ?? savedProgress?.scale,
      viewMode: docViewMode,
      theme: position?.theme ?? docView?.theme ?? savedProgress?.theme,
      fontFamily: position?.fontFamily ?? docView?.fontFamily ?? savedProgress?.fontFamily,
    };
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      if (progressKey && savedProgress) saveDocumentProgress(progressKey, savedProgress);
      // Keep the shelf's progress figure honest as the user reads.
      if (sourceFile && state.extractedDocument) {
        recordRecentDocument({
          name: sourceFile.name,
          size: sourceFile.size,
          lastModified: sourceFile.lastModified,
          mimeType: state.extractedDocument.mimeType,
          charCount: state.extractedDocument.text.length,
          offset: lastProgressOffset,
          openedAt: Date.now(),
        });
      }
    }, 300);
  }

  for (const btn of docViewBtns) {
    btn.addEventListener('click', () => {
      if (btn.dataset.docview === 'document' && !hasDocView) return;
      setDocViewMode(btn.dataset.docview === 'document' ? 'document' : 'text');
      if (btn.dataset.docview === 'document') docViewHost.focus();
      else readerView.focus();
    });
  }

  /**
   * Bookmarks: named places in the document, kept per uploaded file.
   * Labels and notes are rendered with textContent, never markup — they are
   * the user's own words and must not become HTML.
   */
  function renderBookmarks() {
    bookmarkPanel.hidden = !bookmarksKey;
    bookmarkList.replaceChildren();
    for (const bookmark of bookmarks) {
      const item = document.createElement('li');
      item.className = 'docbookmarks__item';
      item.dataset.bookmarkId = bookmark.id;
      const text = document.createElement('div');
      text.className = 'docbookmarks__text';
      const label = document.createElement('span');
      label.className = 'docbookmarks__label-text';
      label.textContent = bookmark.label;
      text.appendChild(label);
      if (bookmark.note) {
        const note = document.createElement('p');
        note.className = 'docbookmarks__note-text';
        note.textContent = bookmark.note;
        text.appendChild(note);
      }
      const actions = document.createElement('div');
      actions.className = 'docbookmarks__actions';
      for (const [action, caption] of [['go', 'Go'], ['remove', 'Remove']] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'document-btn';
        button.dataset.action = action;
        button.textContent = caption;
        actions.appendChild(button);
      }
      item.append(text, actions);
      bookmarkList.appendChild(item);
    }
  }

  bookmarkAddBtn.addEventListener('click', () => {
    const opening = bookmarkForm.hidden;
    bookmarkForm.hidden = !opening;
    bookmarkAddBtn.setAttribute('aria-expanded', String(opening));
    if (opening) {
      const snippet = state.extractedDocument?.text
        .slice(lastProgressOffset, lastProgressOffset + 32).trim();
      bookmarkName.value = snippet
        ? (state.extractedDocument!.text.length > lastProgressOffset + 32 ? `${snippet}…` : snippet)
        : `Position ${lastProgressOffset}`;
      bookmarkName.focus();
    }
  });

  bookmarkCancelBtn.addEventListener('click', () => {
    bookmarkForm.hidden = true;
    bookmarkAddBtn.setAttribute('aria-expanded', 'false');
    bookmarkName.value = '';
    bookmarkNote.value = '';
    bookmarkAddBtn.focus();
  });

  bookmarkForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!bookmarksKey) return;
    const note = bookmarkNote.value.trim();
    bookmarks = [...bookmarks, {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label: bookmarkName.value.trim() || `Bookmark at ${lastProgressOffset}`,
      offset: lastProgressOffset,
      ...(note ? { note } : {}),
      createdAt: Date.now(),
    }];
    saveDocumentBookmarks(bookmarksKey, bookmarks);
    bookmarkName.value = '';
    bookmarkNote.value = '';
    bookmarkForm.hidden = true;
    bookmarkAddBtn.setAttribute('aria-expanded', 'false');
    renderBookmarks();
  });

  bookmarkList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    const item = button?.closest<HTMLElement>('[data-bookmark-id]');
    if (!button || !item) return;
    const bookmark = bookmarks.find(entry => entry.id === item.dataset.bookmarkId);
    if (!bookmark) return;
    if (button.dataset.action === 'go') {
      lastProgressOffset = bookmark.offset;
      docView?.goToOffset(bookmark.offset);
      const sentence = readerSentences.find(s => s.start !== undefined
        && s.start <= bookmark.offset && (s.end ?? 0) > bookmark.offset);
      const el = sentence
        ? readerView.querySelector(`[data-sentence-index="${sentence.globalIndex}"]`)
        : null;
      (el ?? readerView).scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    } else if (button.dataset.action === 'remove') {
      bookmarks = bookmarks.filter(entry => entry.id !== bookmark.id);
      if (bookmarksKey) saveDocumentBookmarks(bookmarksKey, bookmarks);
      renderBookmarks();
    }
  });

  /** Position, size, and reading time for the status bar under the panels. */
  function updateStatusBar() {
    if (!statusBar) return;
    const doc = state.extractedDocument;
    if (!doc) {
      statusBar.textContent = '';
      return;
    }
    statusBar.textContent = formatStatusBar(
      positionPercent(lastProgressOffset, doc.text.length),
      countWords(doc.text),
    );
  }

  /** The session shelf: what was opened, and how far it got. */
  function renderRecentDocuments() {
    const entries = loadRecentDocuments();
    recentPanel.hidden = entries.length === 0;
    recentList.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement('li');
      item.className = 'docrecent__item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'document-btn docrecent__open';
      button.textContent = entry.name;
      // A File cannot be reopened without the user, so the button opens the
      // picker; progress is restored automatically once the same file lands.
      button.title = 'Choose this file again to reopen it at your place';
      button.addEventListener('click', () => input.click());
      const meta = document.createElement('span');
      meta.className = 'docrecent__meta';
      meta.textContent = `${positionPercent(entry.offset, entry.charCount)}% read · `
        + `${new Date(entry.openedAt).toLocaleDateString()}`;
      item.append(button, meta);
      recentList.appendChild(item);
    }
  }

  /** Search every document opened this session, grouped per document. */
  function runSessionSearch() {
    const query = sessionSearchInput.value.trim();
    sessionSearchResults.replaceChildren();
    if (!query) return;
    for (const [identity, entry] of sessionDocs) {
      const summary = findMatches(entry.doc.text, query, {}, 200);
      if (!summary.matches.length) continue;
      const group = document.createElement('div');
      group.className = 'docsearch__group';
      const head = document.createElement('div');
      head.className = 'docsearch__doc';
      head.textContent = `${entry.doc.name} · ${summary.matches.length} match${summary.matches.length === 1 ? '' : 'es'}${summary.truncated ? '+' : ''}`;
      group.appendChild(head);
      for (const match of summary.matches.slice(0, 5)) {
        const snippet = matchSnippet(entry.doc.text, match);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'docsearch__result';
        button.textContent = `${snippet.before}${snippet.match}${snippet.after}`;
        button.addEventListener('click', () => jumpToSessionResult(identity, match.start));
        group.appendChild(button);
      }
      sessionSearchResults.appendChild(group);
    }
    if (!sessionSearchResults.childElementCount) {
      const none = document.createElement('p');
      none.className = 'docsearch__none';
      none.textContent = 'No matches in open documents.';
      sessionSearchResults.appendChild(none);
    }
  }

  function jumpToSessionResult(identity: string, offset: number) {
    const entry = sessionDocs.get(identity);
    if (!entry) return;
    if (identity === (sourceFile ? fileIdentity(sourceFile) : null)) {
      lastProgressOffset = offset;
      docView?.goToOffset(offset);
      scheduleProgressSave({ offset });
    } else {
      // Re-open the file's document and land on the match once it mounts.
      pendingGoToOffset = offset;
      handleFile(entry.file);
    }
  }

  /**
   * Map a DOM position to an offset in the extracted text.
   *
   * Both views stamp their content with document offsets — `data-off` ranges
   * in the visual view, sentence indices in the text view — so a selection
   * resolves to text coordinates instead of view coordinates, and highlights
   * survive switching views and reloading the file.
   */
  function textOffsetIn(root: Element, node: Node, nodeOffset: number): number | null {
    let seen = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      if (current === node) return seen + nodeOffset;
      seen += current.textContent?.length ?? 0;
      current = walker.nextNode();
    }
    return null;
  }

  function documentOffsetOf(node: Node, nodeOffset: number): number | null {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element | null;
    if (!el) return null;
    const stamped = el.closest<HTMLElement>('[data-off]');
    const stamp = stamped ? parseOffsetAttr(stamped.dataset.off) : null;
    if (stamped && stamp) {
      const within = textOffsetIn(stamped, node, nodeOffset);
      if (within === null) return null;
      return Math.max(stamp.start, Math.min(stamp.end, stamp.start + within));
    }
    const sentenceEl = el.closest<HTMLElement>('[data-sentence-index]');
    if (sentenceEl) {
      const sentence = readerSentences.find(s =>
        s.globalIndex === Number(sentenceEl.dataset.sentenceIndex));
      if (sentence?.start !== undefined) {
        const within = textOffsetIn(sentenceEl, node, nodeOffset) ?? 0;
        const limit = (sentence.end ?? sentence.start) - sentence.start;
        return sentence.start + Math.min(within, limit);
      }
    }
    return null;
  }

  function resolveSelection(): { start: number; end: number } | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const start = documentOffsetOf(range.startContainer, range.startOffset);
    const end = documentOffsetOf(range.endContainer, range.endOffset);
    if (start === null || end === null || !(end > start)) return null;
    return { start, end };
  }

  /** Paint the stored highlights into the mounted view. */
  function applyAnnotationsToView() {
    docView?.setAnnotations(highlights.map(({ start, end, color }) => ({ start, end, color })));
  }

  function renderHighlights() {
    highlightPanel.hidden = !highlightsKey;
    highlightList.replaceChildren();
    for (const highlight of highlights) {
      const item = document.createElement('li');
      item.className = 'docbookmarks__item';
      item.dataset.highlightId = highlight.id;
      const text = document.createElement('div');
      text.className = 'docbookmarks__text';
      const label = document.createElement('span');
      label.className = 'docbookmarks__label-text';
      // The user's own words (and the document's) are text, never markup.
      const quote = state.extractedDocument?.text.slice(highlight.start, highlight.end).replace(/\s+/g, ' ').trim() ?? '';
      label.textContent = quote
        ? `${quote.length > 80 ? `${quote.slice(0, 80)}…` : quote} (${highlight.color})`
        : `Highlight at ${highlight.start} (${highlight.color})`;
      text.appendChild(label);
      if (highlight.note) {
        const note = document.createElement('p');
        note.className = 'docbookmarks__note-text';
        note.textContent = highlight.note;
        text.appendChild(note);
      }
      const actions = document.createElement('div');
      actions.className = 'docbookmarks__actions';
      for (const [action, caption] of [['go', 'Go'], ['remove', 'Remove']] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'document-btn';
        button.dataset.action = action;
        button.textContent = caption;
        actions.appendChild(button);
      }
      item.append(text, actions);
      highlightList.appendChild(item);
    }
  }

  function downloadFile(file: ExportFile) {
    downloadBlob(file.filename, new Blob([file.content], { type: file.mime }));
  }

  function downloadBlob(filename: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * The audiobook bundle: the current reading session's generated clips as
   * one zip — merged WAV, document-wide captions, and a karaoke page. Only
   * what has actually been synthesised goes in; stopping early gives a
   * shorter book, not a broken one.
   */
  async function exportAudiobook() {
    const session = state.readerSession;
    const clips = state.currentJobs
      .filter(job => job.status === 'done' && job.audio && job.sampleRate
        && session && job.readerSessionId === session.getSessionId())
      .sort((a, b) => (a.readerIndex ?? 0) - (b.readerIndex ?? 0))
      .map(job => ({
        text: job.text,
        audio: job.audio!,
        sampleRate: job.sampleRate!,
        wordTimings: job.wordTimings,
      }));
    if (!clips.length) {
      showReaderNotice('Read the document aloud first — the audiobook is assembled from the generated audio.');
      return;
    }
    try {
      const doc = state.extractedDocument;
      const name = doc?.name.replace(/\.[^./\\]+$/, '') || 'audiobook';
      // Section offsets are into the extracted text, so the text has to come
      // along: the chapter map is a lookup in what was read, not arithmetic.
      const bundle = await createAudiobookBundle(clips, {
        name,
        sections: doc?.sections,
        documentText: doc?.text ?? '',
      });
      downloadBlob(`${name}-audiobook.zip`, bundle.zip);
    } catch (err) {
      showReaderNotice(`Could not assemble the audiobook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function exportDocument(format: ExportFormat) {
    const doc = state.extractedDocument;
    if (!doc) return;
    downloadFile(buildExport({ name: doc.name, text: doc.text, html: doc.html }, format));
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
   * PDFs render from their anchors; structured formats render their stamped
   * markup, tables, or slides. Plain text has no visual form, so the switch
   * stays hidden rather than offering a Document tab that would show nothing.
   */
  async function mountDocumentView(doc: ExtractedDocument, request: number) {
    destroyDocView();
    const mountHost = document.createElement('div');
    const pdfFile = sourceFile;
    let mountedView: DocumentView | null = null;
    try {
      if (pdfFile && (doc.anchors?.length || doc.mimeType === 'application/pdf')) {
        mountedView = await mountPdfView(mountHost, pdfFile, doc.anchors ?? [], {
          initialPage: savedProgress?.page,
          initialScale: savedProgress?.scale,
          initialTheme: savedProgress?.theme,
          text: doc.text,
          onNavigate: scheduleProgressSave,
          onError: (err, page) => {
            // A page that will not rasterise is a real problem the user can
            // see, so it is said out loud rather than left as a blank page.
            console.warn(`[reader] page ${page} failed to render`, err);
          },
          onPick: readFromOffset,
          // A scanned PDF has no text layer, so search asks for one on
          // demand: OCR runs the first time the user searches and hands the
          // view text plus page geometry to highlight against.
          ...(doc.text.trim() ? {} : {
            loadSearchText: async onProgress => {
              const indexed = await extractDocument(pdfFile, {
                useOcr: true,
                ocrMode: state.ocrMode,
                onProgress,
              });
              return { text: indexed.text, anchors: indexed.anchors ?? [] };
            },
          }),
        });
      } else if (doc.html) {
        mountedView = mountHtmlView(mountHost, doc.html, doc.name, {
          onPick: readFromOffset,
          paginated: isFlowableMime(doc.mimeType),
          sections: doc.sections,
          text: doc.text,
          initialScale: savedProgress?.scale,
          initialTheme: savedProgress?.theme,
          fontFamily: savedProgress?.fontFamily,
          onNavigate: scheduleProgressSave,
        });
      } else {
        // No visual form of its own: the paginated text view is the reading
        // surface, so make sure it is the one on show.
        applyDocViewMode();
        return;
      }
      if (request !== activeFileRequest || !mountedView) {
        mountedView?.destroy();
        return;
      }
      docViewHost.replaceChildren(mountHost);
      docView = mountedView;
      hasDocView = true;
      applyDocViewMode();
      if (savedProgress?.viewMode) setDocViewMode(savedProgress.viewMode);
      if (lastProgressOffset > 0) docView.goToOffset(lastProgressOffset);
      applyAnnotationsToView();
      // A document opened while the reader is already part-way through should
      // not start with its highlight missing.
      if (lastHighlightedWord) {
        const s = readerSentences.find(x => x.globalIndex === lastHighlightedWord!.sentence);
        if (s?.start !== undefined && s.end !== undefined) docView.highlight(s.start, s.end);
      }
    } catch (err) {
      // Falling back to the text view is a working reader with fewer pixels,
      // which beats an error page for the whole document.
      mountedView?.destroy();
      if (request !== activeFileRequest) return;
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
    const request = ++activeFileRequest;
    // Speech about the old document must not follow the new one on screen.
    quickRead.stop();
    reviewRead.stop();
    state.extractedDocument = doc;
    sourceFile = file;
    progressKey = file ? documentProgressKey(file) : null;
    savedProgress = progressKey ? loadDocumentProgress(progressKey) : null;
    lastProgressOffset = savedProgress?.offset ?? 0;
    bookmarksKey = file ? documentBookmarksKey(file) : null;
    bookmarks = bookmarksKey ? loadDocumentBookmarks(bookmarksKey) : [];
    renderBookmarks();
    highlightsKey = file ? documentHighlightsKey(file) : null;
    highlights = highlightsKey ? loadDocumentHighlights(highlightsKey) : [];
    pendingHighlight = null;
    highlightForm.hidden = true;
    renderHighlights();
    // A cross-document search result sets the landing spot before extraction.
    if (pendingGoToOffset !== null) {
      lastProgressOffset = pendingGoToOffset;
      pendingGoToOffset = null;
    }
    if (file) {
      sessionDocs.set(fileIdentity(file), { file, doc });
      recordRecentDocument({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        mimeType: doc.mimeType,
        charCount: doc.text.length,
        offset: lastProgressOffset,
        openedAt: Date.now(),
      });
      renderRecentDocuments();
    }
    updateStatusBar();
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
    void mountDocumentView(doc, request);
    readerView.focus();
  }

  sampleBtn.addEventListener('click', () => {
    clearReaderError();
    setProgress('Loading sample…');
    // No file: the sample is a plain-text document, so it is read on the
    // paginated text view and the switch stays hidden.
    showDocument({ ...SAMPLE_DOCUMENT }, null);
  });

  function handleFile(file: File) {
    const request = ++activeFileRequest;
    if (file.size > 25 * 1024 * 1024) {
      showStatus('error', 'File is too large. Maximum size is 25 MB.');
      return;
    }
    destroyDocView();
    hasDocView = false;
    applyDocViewMode();
    clearReaderError();
    setProgress('Extracting text…');
    const useOcr = ocrToggle.checked && file.name.toLowerCase().endsWith('.pdf');
    extractDocument(file, {
      useOcr,
      ocrMode: state.ocrMode,
      onProgress: message => { if (request === activeFileRequest) setProgress(message); },
    })
      .then(doc => {
        if (request === activeFileRequest) showDocument(doc, file);
      })
      .catch(err => {
        if (request !== activeFileRequest) return;
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
    // The engine's word timings arrive as `wordIndex`, so the page gets a
    // karaoke word box inside a faint sentence trail instead of a fresh
    // sentence wash on every word.
    const active = readerSentences.find(s => s.globalIndex === info.sentenceIndex);
    if (active?.start !== undefined && active.end !== undefined) {
      lastProgressOffset = active.start;
      const word = wordSpanInDocument(active, info.wordIndex);
      if (word) {
        docView?.highlight(word.start, word.end, { start: active.start, end: active.end });
      } else {
        docView?.highlight(active.start, active.end);
      }
      scheduleProgressSave({ offset: active.start });
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
    updateSpeechButtons();
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
    if (text.length > MAX_MODEL_READ_CHARS) {
      showReaderNotice('Text is too long to read in one session. Paste a shorter excerpt.');
      return;
    }
    openOverlayOnPlay = overlay;
    state.readerSession?.stop();
    quickRead.stop();
    reviewRead.stop();
    clearHighlight();
    clearReaderError();
    renderOverlay(text);
    modelSpeechKind = 'document';
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
    lastProgressOffset = sentence.start ?? offset;
    scheduleProgressSave({ offset: lastProgressOffset });

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

  stopBtn.addEventListener('click', stopAllSpeech);

  readerOverlayPause.addEventListener('click', () => {
    if (!state.readerSession) return;
    if (state.readerSession.getState().status === 'playing') {
      state.readerSession.pause();
    } else {
      state.readerSession.resumeAfterGesture();
    }
  });
  readerOverlayStop.addEventListener('click', stopAllSpeech);
  readerOverlayClose.addEventListener('click', stopAllSpeech);
  readerOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      stopAllSpeech();
    }
  });

  // ── Highlights: user-made marked ranges with optional notes ──
  highlightAddBtn.addEventListener('click', () => {
    const range = resolveSelection();
    if (!range) {
      showReaderNotice('Select some text in the document first, then highlight it.');
      return;
    }
    pendingHighlight = range;
    highlightForm.hidden = false;
    highlightAddBtn.setAttribute('aria-expanded', 'true');
    highlightNote.focus();
  });

  highlightCancelBtn.addEventListener('click', () => {
    pendingHighlight = null;
    highlightForm.hidden = true;
    highlightAddBtn.setAttribute('aria-expanded', 'false');
    highlightAddBtn.focus();
  });

  highlightForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!highlightsKey || !pendingHighlight) return;
    const note = highlightNote.value.trim();
    highlights = [...highlights, {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      start: pendingHighlight.start,
      end: pendingHighlight.end,
      color: highlightColor.value as DocumentHighlight['color'],
      ...(note ? { note } : {}),
      createdAt: Date.now(),
    }];
    saveDocumentHighlights(highlightsKey, highlights);
    pendingHighlight = null;
    highlightNote.value = '';
    highlightForm.hidden = true;
    highlightAddBtn.setAttribute('aria-expanded', 'false');
    renderHighlights();
    applyAnnotationsToView();
  });

  highlightList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    const item = button?.closest<HTMLElement>('[data-highlight-id]');
    if (!button || !item) return;
    const highlight = highlights.find(entry => entry.id === item.dataset.highlightId);
    if (!highlight) return;
    if (button.dataset.action === 'go') {
      lastProgressOffset = highlight.start;
      docView?.goToOffset(highlight.start);
      docView?.highlight(highlight.start, highlight.end);
      scheduleProgressSave({ offset: highlight.start });
    } else if (button.dataset.action === 'remove') {
      highlights = highlights.filter(entry => entry.id !== highlight.id);
      if (highlightsKey) saveDocumentHighlights(highlightsKey, highlights);
      renderHighlights();
      applyAnnotationsToView();
    }
  });

  // ── Exports ────────────────────────────────────────────────
  document.getElementById('export-md-btn')?.addEventListener('click', () => exportDocument('markdown'));
  document.getElementById('export-html-btn')?.addEventListener('click', () => exportDocument('html'));
  document.getElementById('export-txt-btn')?.addEventListener('click', () => exportDocument('text'));
  document.getElementById('export-notes-btn')?.addEventListener('click', () => {
    const doc = state.extractedDocument;
    if (!doc) return;
    downloadFile(buildNotesExport({ name: doc.name, text: doc.text }, bookmarks, highlights));
  });
  audiobookBtn.addEventListener('click', () => {
    void exportAudiobook();
  });

  // ── Quick read: the loaded model's voice when ready, the browser's
  // voice otherwise. Either way the highlight follows the spoken sentence. ──
  const quickRead = new ReadAloudController({
    onSentence: index => {
      const sentence = readerSentences[index];
      if (sentence?.start !== undefined && sentence.end !== undefined) {
        lastProgressOffset = sentence.start;
        docView?.highlight(sentence.start, sentence.end);
        scheduleProgressSave({ offset: sentence.start });
      }
    },
    // Where the browser reports word boundaries, the highlight goes
    // word-by-word (karaoke) instead of washing the whole sentence.
    onWord: (index, charIndex) => {
      const sentence = readerSentences[index];
      if (!sentence || sentence.start === undefined || sentence.end === undefined) return;
      const wordIndex = wordIndexAtChar(sentence.words, charIndex);
      if (wordIndex < 0) return;
      const span = wordSpanInDocument(sentence, wordIndex);
      if (span) docView?.highlight(span.start, span.end, { start: sentence.start, end: sentence.end });
    },
    onStateChange: () => updateSpeechButtons(),
    onError: message => showReaderNotice(message),
  });

  function sessionLive(): boolean {
    const status = state.readerSession?.getState().status;
    return status === 'playing' || status === 'paused';
  }

  /** The model can speak this much text; beyond it, fall back to the browser. */
  function canUseModelVoice(spokenChars: number): boolean {
    return state.engine?.getEngineState() === 'ready' && spokenChars <= MAX_MODEL_READ_CHARS;
  }

  function updateSpeechButtons() {
    const documentSpeech = quickRead.getState() !== 'idle'
      || (sessionLive() && modelSpeechKind !== 'review');
    const reviewSpeech = reviewRead.getState() !== 'idle'
      || (sessionLive() && modelSpeechKind === 'review');
    readaloudBtn.textContent = documentSpeech ? '■ Stop quick read' : '▶ Quick read';
    reviewBtn.textContent = reviewSpeech ? '■ Stop review' : '▶ Review notes';
  }

  /** Stop every speech path at once: model session, quick read, review. */
  function stopAllSpeech() {
    quickRead.stop();
    reviewRead.stop();
    state.readerSession?.stop();
    state.readerSession = null;
    modelSpeechKind = null;
    clearHighlight();
    closeReaderOverlay();
    updateSpeechButtons();
  }

  readaloudBtn.addEventListener('click', () => {
    if (quickRead.getState() !== 'idle' || (modelSpeechKind === 'document' && sessionLive())) {
      stopAllSpeech();
      return;
    }
    if (!readerSentences.length) return;
    const text = state.extractedDocument?.text ?? '';
    const from = sentenceAtOffset(readerSentences, lastProgressOffset)?.globalIndex ?? 0;
    if (canUseModelVoice(text.length)) {
      // The same session the Read button uses, minus the overlay: the
      // model's voice, starting at the current sentence.
      beginReading(from, false);
      return;
    }
    reviewRead.stop();
    state.readerSession?.stop();
    quickRead.speak(
      readerSentences.map(sentence => ({ text: sentence.words.join(' ') })),
      from,
      { rate: QUICK_RATES[quickRateIndex] },
    );
  });

  readaloudSpeedBtn.addEventListener('click', () => {
    quickRateIndex = (quickRateIndex + 1) % QUICK_RATES.length;
    quickRead.setRate(QUICK_RATES[quickRateIndex]);
    reviewRead.setRate(QUICK_RATES[quickRateIndex]);
    readaloudSpeedBtn.textContent = `${QUICK_RATES[quickRateIndex]}×`;
  });

  // ── Review notes: speak the highlights and bookmarks back ──
  const reviewRead = new ReadAloudController({
    onSentence: index => {
      const segment = reviewSegments[index];
      if (!segment || segment.start === undefined || segment.end === undefined) return;
      lastProgressOffset = segment.start;
      docView?.goToOffset(segment.start);
      docView?.highlight(segment.start, segment.end);
      scheduleProgressSave({ offset: segment.start });
    },
    onStateChange: () => updateSpeechButtons(),
    onError: message => showReaderNotice(message),
  });

  /** Speak the review through the loaded model, painting each note as it plays. */
  function speakReviewWithModel(script: ReviewSegment[], built: ReviewScriptText) {
    modelSpeechKind = 'review';
    openOverlayOnPlay = false;
    state.readerSession?.stop();
    quickRead.stop();
    clearHighlight();
    clearReaderError();
    const session = new DocumentReaderSession(state.engine!, built.text, {
      chunkSize: 300,
      lookahead: 2,
      speed: state.currentSpeed,
      onStateChange: renderReaderState,
      onHighlight: info => {
        // The session reports sentence indexes into the script text; the
        // script's ranges say which note (and document span) that is.
        const sentence = session.getSentences()[info.sentenceIndex];
        if (sentence?.start === undefined) return;
        const index = built.ranges.findIndex(range =>
          sentence.start! >= range.start && sentence.start! < range.end);
        const segment = index >= 0 ? script[index] : null;
        if (!segment || segment.start === undefined || segment.end === undefined) return;
        lastProgressOffset = segment.start;
        docView?.highlight(segment.start, segment.end);
        scheduleProgressSave({ offset: segment.start });
      },
    });
    state.readerSession = session;
    session.start(0);
  }

  reviewBtn.addEventListener('click', () => {
    if (reviewRead.getState() !== 'idle' || (modelSpeechKind === 'review' && sessionLive())) {
      stopAllSpeech();
      return;
    }
    const doc = state.extractedDocument;
    if (!doc) return;
    const script = buildReviewScript({ name: doc.name, text: doc.text }, bookmarks, highlights);
    if (!script.length) {
      showReaderNotice('No highlights or bookmarks to review yet.');
      return;
    }
    reviewSegments = script;
    const built = reviewScriptText(script);
    if (canUseModelVoice(built.text.length)) {
      speakReviewWithModel(script, built);
      return;
    }
    quickRead.stop();
    state.readerSession?.stop();
    reviewRead.speak(script.map(segment => ({ text: segment.text })), 0, {
      rate: QUICK_RATES[quickRateIndex],
    });
  });

  // ── Cross-document search ────────────────────────────────
  sessionSearchInput.addEventListener('input', () => {
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = setTimeout(runSessionSearch, 150);
  });

  // ── Shortcuts, blackout, and the cheat sheet ─────────────
  function toggleShortcutHelp() {
    shortcutHelp.hidden = !shortcutHelp.hidden;
    if (!shortcutHelp.hidden) shortcutHelpClose.focus();
    else shortcutsBtn.focus();
  }

  shortcutsBtn.addEventListener('click', toggleShortcutHelp);
  shortcutHelpClose.addEventListener('click', toggleShortcutHelp);

  document.addEventListener('keydown', (e) => {
    // A visible blackout swallows the next key: dismissing it is the action.
    if (!blackout.hidden) {
      blackout.hidden = true;
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT' || target.isContentEditable)) return;
    switch (e.key) {
      case '/':
        e.preventDefault();
        docView?.search?.focus();
        break;
      case 'n':
        docView?.search?.next();
        break;
      case 'N':
        docView?.search?.prev();
        break;
      case 'm':
        bookmarkAddBtn.click();
        break;
      case 'h':
        highlightAddBtn.click();
        break;
      case 't':
        docView?.cycleTheme();
        break;
      case 'o':
        docViewHost.querySelector<HTMLButtonElement>('[data-role="toggle-outline"]')?.click();
        break;
      case 's':
        docViewHost.querySelector<HTMLButtonElement>('[data-role="toggle-overview"]')?.click();
        break;
      case 'b':
        blackout.dataset.mode = 'black';
        blackout.hidden = false;
        break;
      case 'w':
        blackout.dataset.mode = 'white';
        blackout.hidden = false;
        break;
      case 'ArrowLeft':
        if (docView) {
          e.preventDefault();
          docView.prevPage();
        }
        break;
      case 'ArrowRight':
        if (docView) {
          e.preventDefault();
          docView.nextPage();
        }
        break;
      case '+':
      case '=':
        docView?.zoomIn();
        break;
      case '-':
        docView?.zoomOut();
        break;
      case 'q':
        readaloudBtn.click();
        break;
      case 'r':
        reviewBtn.click();
        break;
      case '?':
        toggleShortcutHelp();
        break;
      case 'Escape':
        if (!shortcutHelp.hidden) toggleShortcutHelp();
        break;
    }
  });

  blackout.addEventListener('click', () => {
    blackout.hidden = true;
  });

  renderRecentDocuments();
}
