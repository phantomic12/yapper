/**
 * Bubble notes: a question the reader sets themselves, pinned to a word or a
 * paragraph, with an answer box that opens in place.
 *
 * The reader already has two note surfaces: a column-note rail pinned to
 * offsets, and highlight notes that float off a marked range. Neither asks
 * anything back, and a study document is mostly questions. A bubble note is
 * the same callout the highlight notes already use — the marker sits in the
 * text and the body floats beside it — but it carries a prompt and an answer
 * of its own, so it does not have to pretend to be a highlight to exist.
 *
 * Storage is localStorage for the same reason the other note rails use it:
 * a bubble is a few hundred characters, and it must be readable before an
 * IndexedDB open resolves. Blobs are the only thing that cannot live here.
 */

export type BubbleAnchorKind = 'word' | 'paragraph';

export interface DocumentBubbleNote {
  id: string;
  /** Character offset of the anchor: the word's first letter, the paragraph's first character. */
  offset: number;
  /** End of the anchored text, exclusive, so the rail can quote it. */
  anchorEnd: number;
  anchor: BubbleAnchorKind;
  /** The question or instruction. */
  prompt: string;
  /** The reader's answer, empty until written. */
  answer: string;
  createdAt: number;
  updatedAt: number;
}

const DOCUMENT_BUBBLES_PREFIX = 'yapper.document-bubbles.v1:';
const MAX_BUBBLES_PER_DOCUMENT = 200;
/** Prompts and answers are UI-sized, not document-sized: a bubble is a card. */
const MAX_PROMPT_CHARS = 400;
const MAX_ANSWER_CHARS = 4000;

/** Bubbles share the identity key's shape: file name, size, and mtime. */
export function documentBubbleNotesKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${DOCUMENT_BUBBLES_PREFIX}${encodeURIComponent(file.name)}:${file.size}:${file.lastModified}`;
}

/** Characters that belong to the sentence, not to the word being anchored. */
const EDGE_PUNCTUATION = /[.,;:!?()[\]{}"'“”‘’«»—–…]/;

/**
 * The paragraphs of a text, as [start, end) ranges.
 *
 * A blank line — a line with nothing but whitespace — ends a paragraph. That
 * is the same rule the reader's own paragraph segmentation uses, and it is the
 * cheapest one a reader can predict: what looks like a gap on the page is a
 * gap here.
 */
export function paragraphRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    // Skip leading blank lines.
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor);
      const lineEnd = newline < 0 ? text.length : newline;
      if (text.slice(cursor, lineEnd).trim()) break;
      cursor = lineEnd + 1;
    }
    if (cursor >= text.length) break;
    const start = cursor;
    let end = text.length;
    for (;;) {
      const newline = text.indexOf('\n', cursor);
      if (newline < 0) break; // last line of the document
      const nextStart = newline + 1;
      const nextNewline = text.indexOf('\n', nextStart);
      const nextEnd = nextNewline < 0 ? text.length : nextNewline;
      cursor = nextStart;
      if (!text.slice(nextStart, nextEnd).trim()) {
        end = newline;
        break;
      }
    }
    if (end > start) ranges.push({ start, end });
    cursor = end + 1;
  }
  return ranges;
}

/**
 * Resolve a character offset to the span a bubble should hang off.
 *
 * The offset arrives from a click or the reading position, so it can land on
 * whitespace or punctuation. A word anchor walks out to the surrounding run of
 * non-space and trims the sentence's punctuation off both ends; a paragraph
 * anchor returns the whole block. Returning null is better than guessing: a
 * bubble at the wrong place is a note the reader will not find again.
 */
export function bubbleAnchorAt(
  text: string,
  offset: number,
  kind: BubbleAnchorKind,
): { start: number; end: number } | null {
  if (!text) return null;
  const at = Math.max(0, Math.min(text.length - 1, Math.floor(offset)));

  if (kind === 'paragraph') {
    const range = paragraphRanges(text).find(item => at >= item.start && at <= item.end);
    if (!range) return null;
    const block = text.slice(range.start, range.end);
    const leading = block.search(/\S/);
    if (leading < 0) return null;
    const trimmed = block.slice(leading).replace(/\s+$/, '');
    if (!trimmed) return null;
    return { start: range.start + leading, end: range.start + leading + trimmed.length };
  }

  let cursor = at;
  // A click in the gutter between two words belongs to the word after it, but
  // only within the same line — otherwise the next paragraph would own it.
  if (/\s/.test(text[cursor])) {
    let forward = cursor;
    while (forward < text.length && /[ \t]/.test(text[forward])) forward++;
    if (forward < text.length && !/[\r\n]/.test(text[forward])) cursor = forward;
    else {
      let backward = cursor;
      while (backward > 0 && /\s/.test(text[backward - 1])) backward--;
      cursor = Math.max(0, backward - 1);
    }
  }

  let start = cursor;
  let end = cursor + 1;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  while (end < text.length && !/\s/.test(text[end])) end++;
  while (start < end && (EDGE_PUNCTUATION.test(text[start]) || text[start] === '-')) start++;
  while (end > start && (EDGE_PUNCTUATION.test(text[end - 1]) || text[end - 1] === '-')) end--;
  // A run of punctuation or spaces is not a word; better no anchor than a
  // bubble that quotes a dash.
  return end > start && /\S/.test(text.slice(start, end)) ? { start, end } : null;
}

/** The document text a bubble points at, for the rail's cue line. */
export function bubbleAnchorText(text: string, note: Pick<DocumentBubbleNote, 'offset' | 'anchorEnd'>): string {
  return text.slice(note.offset, note.anchorEnd).replace(/\s+/g, ' ').trim();
}

/**
 * Validate one record read back from storage.
 *
 * Everything here came from localStorage, which any other tab (or an old
 * build) can have written, so a malformed record is dropped rather than
 * rendered as `undefined`. The offset is clamped to the text it claims to
 * anchor to: a bubble pointing past the end of the document would never be
 * findable again.
 */
export function normalizeBubbleNote(
  value: unknown,
  index: number,
  textLength = Number.POSITIVE_INFINITY,
): DocumentBubbleNote | null {
  const entry = value as Partial<DocumentBubbleNote> | null;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.prompt !== 'string' || !entry.prompt.trim()) return null;
  if (!Number.isFinite(entry.offset) || (entry.offset ?? -1) < 0) return null;
  if (textLength > 0 && (entry.offset ?? 0) > textLength) return null;
  const offset = Math.floor(entry.offset!);
  const anchor = entry.anchor === 'paragraph' ? 'paragraph' : 'word';
  const rawEnd = Number.isFinite(entry.anchorEnd) ? Math.floor(entry.anchorEnd!) : offset + 1;
  const anchorEnd = Math.max(offset + 1, Math.min(textLength, rawEnd));
  const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt! : 0;
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : `bubble-${index}`,
    offset,
    anchorEnd,
    anchor,
    prompt: entry.prompt.trim().slice(0, MAX_PROMPT_CHARS),
    answer: typeof entry.answer === 'string' ? entry.answer.slice(0, MAX_ANSWER_CHARS) : '',
    createdAt,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt! : createdAt,
  };
}

export function normalizeBubbleNotes(
  values: unknown,
  textLength = Number.POSITIVE_INFINITY,
): DocumentBubbleNote[] {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, MAX_BUBBLES_PER_DOCUMENT)
    .flatMap((value, index) => {
      const note = normalizeBubbleNote(value, index, textLength);
      return note ? [note] : [];
    })
    .sort((a, b) => a.offset - b.offset);
}

/**
 * Write an answer into a list, returning a new list and the updated note.
 *
 * Returns the same list when the answer is unchanged, so a debounced save
 * that fires after every keystroke does not rewrite the store for free.
 */
export function setBubbleAnswer(
  notes: readonly DocumentBubbleNote[],
  id: string,
  answer: string,
  now = Date.now(),
): { notes: DocumentBubbleNote[]; updated: DocumentBubbleNote | null } {
  const existing = notes.find(note => note.id === id);
  if (!existing || existing.answer === answer) {
    return { notes: [...notes], updated: null };
  }
  const updated = { ...existing, answer, updatedAt: now };
  return {
    notes: notes.map(note => (note.id === id ? updated : note)),
    updated,
  };
}

export function loadDocumentBubbleNotes(
  key: string,
  textLength = Number.POSITIVE_INFINITY,
): DocumentBubbleNote[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return normalizeBubbleNotes(JSON.parse(raw) as unknown, textLength);
  } catch {
    return [];
  }
}

export function saveDocumentBubbleNotes(key: string, notes: readonly DocumentBubbleNote[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(notes.slice(0, MAX_BUBBLES_PER_DOCUMENT)));
  } catch {
    // Best-effort: a blocked/full store must not interrupt reading.
  }
}
