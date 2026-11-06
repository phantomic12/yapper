/**
 * Per-section voice tagging: the UI half of `voice-tags.ts`.
 *
 * Three affordances, because those are the three things a reader actually
 * wants to say: "this paragraph is somebody else", "this passage I selected is
 * somebody else", and "forget it, read the whole thing in one voice". The
 * voice list is the active model's own list — offering a voice the loaded
 * model does not have would only produce a tag that cannot be honoured, and
 * the reader would then have to refuse to play.
 *
 * Tags are held per document, keyed the same way reading progress is keyed, so
 * they survive a reload and cost nothing for documents that never use them.
 * The panel also mirrors each change into the live reading session: tag a
 * paragraph while listening and the voice changes at the next chunk boundary
 * instead of at the next Play.
 */

import type { AppState } from '../app-state';
import { parseOffsetAttr } from '../document-html';
import {
  applyVoiceTag,
  documentVoiceTagsKey,
  loadVoiceTags,
  normalizeVoiceTags,
  paragraphRangeAt,
  removeVoiceTag,
  saveVoiceTags,
  type VoiceTag,
} from '../voice-tags';

/** The document the panel is tagging, or null when nothing is open. */
let documentFile: File | null = null;
let documentOpen = false;
let tags: VoiceTag[] = [];
let boundState: AppState | null = null;

/**
 * Identity used for a document that has no File behind it — the built-in
 * sample. It cannot be persisted (there is no file identity to key on), but
 * tagging it still works for the session, which keeps the sample usable as
 * the demo it is.
 */
const MEMORY_DOCUMENT_KEY = 'yapper.document-voices.v1:memory';

/**
 * Tell the panel which document is open. Called by the document panel's
 * `showDocument`, which is the one place that knows both the File and the
 * extracted text.
 */
export function setVoiceTagDocument(
  file: File | null,
  open: boolean = file !== null,
): void {
  documentFile = file;
  documentOpen = open;
  tags = file ? loadVoiceTags(documentVoiceTagsKey(file)) : [];
  if (boundState) render(boundState);
}

/** The tag list for the open document, in document order. */
export function currentVoiceTags(): VoiceTag[] {
  return tags.map(tag => ({ ...tag }));
}

/**
 * Identity of the open document, handed to the reader so the live session can
 * be told apart from a review script built from the same text.
 */
export function voiceTagDocumentId(): string | null {
  if (!documentOpen) return null;
  return documentFile ? documentVoiceTagsKey(documentFile) : MEMORY_DOCUMENT_KEY;
}

/** Wire the panel. Safe to call on a page that lacks the markup. */
export function bindVoiceTags(state: AppState): void {
  const container = document.getElementById('voice-tags');
  const select = document.getElementById('voice-tag-voice') as HTMLSelectElement | null;
  const paragraphBtn = document.getElementById('voice-tag-paragraph-btn');
  const selectionBtn = document.getElementById('voice-tag-selection-btn');
  const clearBtn = document.getElementById('voice-tag-clear-btn');
  const list = document.getElementById('voice-tag-list');
  if (!container || !select || !paragraphBtn || !selectionBtn || !clearBtn || !list) return;

  boundState = state;
  render(state);

  paragraphBtn.addEventListener('click', () => {
    const session = state.readerSession;
    if (!session) {
      setStatus('Start reading (silent works too) so the panel knows which paragraph you are on.');
      return;
    }
    const position = session.getPosition();
    const range = paragraphRangeAt(session.getSentences(), position.sentenceIndex);
    if (!range) {
      setStatus('This paragraph cannot be located in the text, so it cannot be tagged.');
      return;
    }
    addTag(state, range, 'paragraph');
  });

  selectionBtn.addEventListener('click', () => {
    const raw = selectionRange(state);
    if (!raw) {
      setStatus('Select some text in the document first, then tag it.');
      return;
    }
    const range = toDocumentRange(state, raw);
    if (!range) {
      setStatus('That selection is outside the document text.');
      return;
    }
    addTag(state, range, 'selection');
  });

  clearBtn.addEventListener('click', () => {
    if (!tags.length) {
      setStatus('There are no section voices to clear.');
      return;
    }
    commit(state, [], 'All section voices cleared — the document reads in one voice.');
  });

  list.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-voice-tag-remove]');
    if (!button) return;
    const id = button.dataset.voiceTagRemove ?? '';
    commit(state, removeVoiceTag(tags, id), 'Section voice removed.');
  });

  // The model (and therefore the voice list) can change while a document is
  // open. Rebuild the options when the picker is opened so the list is never
  // a snapshot from page load.
  select.addEventListener('focus', () => populateVoices(state, select));
}

function addTag(state: AppState, range: { start: number; end: number }, kind: 'paragraph' | 'selection'): void {
  const select = document.getElementById('voice-tag-voice') as HTMLSelectElement | null;
  const voiceId = select?.value ?? '';
  if (!voiceId) {
    setStatus('Load a model with more than one voice (Kokoro or Kitten) to tag a section.');
    return;
  }
  const tag: VoiceTag = {
    id: `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    start: range.start,
    end: range.end,
    voiceId,
  };
  const name = voiceName(state, voiceId);
  const quote = quoteFor(state, range);
  commit(
    state,
    applyVoiceTag(tags, tag),
    `${kind === 'paragraph' ? 'Paragraph' : 'Selection'} tagged${quote ? `: “${quote}”` : ''} — reads as ${name}.`,
  );
}

/**
 * Save, mirror into the live session, and report.
 *
 * The status line prefers the session's own refusal over the cheerful
 * confirmation: if the tag was saved but the loaded model cannot speak it,
 * saying "saved" alone would be the silent lie this feature is meant to
 * avoid.
 */
function commit(state: AppState, next: readonly VoiceTag[], message: string): void {
  tags = normalizeVoiceTags(next);
  // A file-backed document is persisted; the sample lives for the session.
  if (documentFile) saveVoiceTags(documentVoiceTagsKey(documentFile), tags);
  const session = state.readerSession;
  const live = session && session.getDocumentId() === voiceTagDocumentId() ? session : null;
  if (live) live.applyVoiceTags(tags);
  render(state);
  setStatus(live?.getVoiceTagsError() ?? message);
}

function render(state: AppState): void {
  const select = document.getElementById('voice-tag-voice') as HTMLSelectElement | null;
  const container = document.getElementById('voice-tags');
  const list = document.getElementById('voice-tag-list');
  const clearBtn = document.getElementById('voice-tag-clear-btn');
  const paragraphBtn = document.getElementById('voice-tag-paragraph-btn');
  const selectionBtn = document.getElementById('voice-tag-selection-btn');
  if (!select || !container || !list || !clearBtn || !paragraphBtn || !selectionBtn) return;

  populateVoices(state, select);
  const hasVoices = select.options.length > 1;
  const hasDocument = documentOpen;
  paragraphBtn.toggleAttribute('disabled', !hasVoices || !hasDocument);
  selectionBtn.toggleAttribute('disabled', !hasVoices || !hasDocument);
  clearBtn.toggleAttribute('disabled', !tags.length);
  container.dataset.voiceTags = String(tags.length);

  list.replaceChildren();
  for (const tag of tags) {
    const item = document.createElement('li');
    item.className = 'docbookmarks__item';
    item.dataset.voiceTagId = tag.id;

    const text = document.createElement('div');
    text.className = 'docbookmarks__text';
    const label = document.createElement('span');
    label.className = 'docbookmarks__label-text';
    const quote = quoteFor(state, tag);
    label.textContent = `${quote || `At ${tag.start}`} — ${voiceName(state, tag.voiceId)}`;
    text.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'docbookmarks__actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'document-btn';
    remove.dataset.voiceTagRemove = tag.id;
    remove.textContent = 'Remove';
    actions.appendChild(remove);

    item.append(text, actions);
    list.appendChild(item);
  }

  if (!tags.length) {
    const empty = document.createElement('li');
    empty.className = 'voice-tags__empty';
    empty.textContent = hasDocument
      ? 'No section voices yet — the whole document reads in the selected voice.'
      : 'Open a document to give one of its sections a different voice.';
    list.appendChild(empty);
  }
}

/** Fill the voice picker from the active model, keeping the current choice. */
function populateVoices(state: AppState, select: HTMLSelectElement): void {
  const voices = state.engine?.getCurrentModel()?.voices ?? [];
  const previous = select.value;
  select.replaceChildren();
  if (!voices.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Default voice';
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.name;
    select.appendChild(option);
  }
  if (previous && voices.some(voice => voice.id === previous)) select.value = previous;
  // A model's default voice is the honest starting point: a tag means "not
  // this one", and the first entry is normally the default.
  else select.value = state.selectedVoiceId && voices.some(v => v.id === state.selectedVoiceId)
    ? state.selectedVoiceId
    : voices[0].id;
}

function voiceName(state: AppState, voiceId: string): string {
  return state.engine?.getCurrentModel()?.voices?.find(voice => voice.id === voiceId)?.name ?? voiceId;
}

/** Untrimmed text offset → the trimmed text the reader speaks. */
function toDocumentRange(
  state: AppState,
  range: { start: number; end: number },
): { start: number; end: number } | null {
  const raw = state.extractedDocument?.text ?? '';
  const lead = raw.length - raw.trimStart().length;
  const length = raw.trim().length;
  const start = Math.max(0, Math.min(length, range.start - lead));
  const end = Math.max(0, Math.min(length, range.end - lead));
  return end > start ? { start, end } : null;
}

/** A short quotation of a tagged range, for the list and the status line. */
function quoteFor(state: AppState, range: { start: number; end: number }): string {
  const raw = state.extractedDocument?.text ?? '';
  const lead = raw.length - raw.trimStart().length;
  const text = raw.slice(range.start + lead, range.end + lead).replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** The current selection as untrimmed document offsets. */
function selectionRange(state: AppState): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = documentOffsetOf(state, range.startContainer, range.startOffset);
  const end = documentOffsetOf(state, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

/**
 * Which document offset a DOM point sits at.
 *
 * Both reading views stamp their content, but with different attributes: the
 * page view carries `data-off` character spans, while the text view carries
 * `data-sentence-index` on each sentence. Both are honoured, because the panel
 * must work whichever view the reader is using.
 */
function documentOffsetOf(state: AppState, node: Node, nodeOffset: number): number | null {
  const element = node.nodeType === Node.TEXT_NODE
    ? node.parentElement
    : (node as Element | null);
  if (!element) return null;

  const stamped = element.closest<HTMLElement>('[data-off]');
  const stamp = stamped ? parseOffsetAttr(stamped.dataset.off) : null;
  if (stamped && stamp) {
    const within = textOffsetIn(stamped, node, nodeOffset);
    if (within === null) return null;
    return Math.max(stamp.start, Math.min(stamp.end, stamp.start + within));
  }

  const sentenceEl = element.closest<HTMLElement>('[data-sentence-index]');
  if (sentenceEl) {
    const sentence = (state.readerSession?.getSentences() ?? []).find(
      candidate => candidate.globalIndex === Number(sentenceEl.dataset.sentenceIndex),
    );
    if (sentence?.start !== undefined) {
      const within = textOffsetIn(sentenceEl, node, nodeOffset) ?? 0;
      const limit = (sentence.end ?? sentence.start) - sentence.start;
      return sentence.start + Math.min(within, limit);
    }
  }
  return null;
}

/** Characters between the start of `root` and a DOM point. */
function textOffsetIn(root: Element, node: Node, nodeOffset: number): number | null {
  let seen = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === node) return seen + nodeOffset;
    seen += current.textContent?.length ?? 0;
  }
  return null;
}

function setStatus(message: string): void {
  const status = document.getElementById('voice-tag-status');
  if (status) status.textContent = message;
}
