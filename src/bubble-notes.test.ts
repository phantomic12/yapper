/**
 * Bubble-note anchoring and serialisation.
 *
 * Anchoring is the part that goes wrong quietly: a note stored at the wrong
 * offset still renders, just next to the paragraph the reader was *not*
 * asking about. The storage cases matter for the same reason — these records
 * are read back from localStorage, which nothing validates on the way in.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  bubbleAnchorAt,
  bubbleAnchorText,
  documentBubbleNotesKey,
  loadDocumentBubbleNotes,
  normalizeBubbleNote,
  normalizeBubbleNotes,
  paragraphRanges,
  saveDocumentBubbleNotes,
  setBubbleAnswer,
  type DocumentBubbleNote,
} from './bubble-notes';

const note = (overrides: Partial<DocumentBubbleNote> = {}): DocumentBubbleNote => ({
  id: 'b1',
  offset: 4,
  anchorEnd: 9,
  anchor: 'word',
  prompt: 'What does this mean?',
  answer: '',
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

describe('bubble-notes — paragraph boundaries', () => {
  it('splits on blank lines and keeps wrapped lines together', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\nStill second.\n\nThird.';
    expect(paragraphRanges(text).map(range => text.slice(range.start, range.end)))
      .toEqual(['First paragraph.', 'Second paragraph.\nStill second.', 'Third.']);
  });

  it('treats a line of spaces as a paragraph break', () => {
    const text = 'One.\n   \nTwo.';
    expect(paragraphRanges(text).map(range => text.slice(range.start, range.end)))
      .toEqual(['One.', 'Two.']);
  });

  it('has no ranges for blank text', () => {
    expect(paragraphRanges('  \n\n ')).toEqual([]);
  });
});

describe('bubble-notes — anchoring to a word', () => {
  const text = 'The quick brown fox.';

  it('returns the word under the offset', () => {
    expect(bubbleAnchorAt(text, 4, 'word')).toEqual({ start: 4, end: 9 });
    expect(bubbleAnchorText(text, { offset: 4, anchorEnd: 9 })).toBe('quick');
  });

  it('moves forward to the word after a gap in the same line', () => {
    expect(bubbleAnchorAt(text, 9, 'word')).toEqual({ start: 10, end: 15 });
  });

  it('strips the sentence punctuation off the word', () => {
    expect(bubbleAnchorAt(text, 19, 'word')).toEqual({ start: 16, end: 19 });
    expect(bubbleAnchorAt('(hello)', 2, 'word')).toEqual({ start: 1, end: 6 });
  });

  it('keeps an internal hyphen and drops a trailing one', () => {
    expect(bubbleAnchorText('a well-known fact', { offset: 2, anchorEnd: 12 }))
      .toBe('well-known');
    expect(bubbleAnchorAt('well-known', 5, 'word')).toEqual({ start: 0, end: 10 });
    expect(bubbleAnchorAt('stop —', 0, 'word')).toEqual({ start: 0, end: 4 });
  });

  it('clamps an offset outside the text instead of returning nonsense', () => {
    expect(bubbleAnchorAt(text, -20, 'word')).toEqual({ start: 0, end: 3 });
    expect(bubbleAnchorAt(text, 900, 'word')).toEqual({ start: 16, end: 19 });
    expect(bubbleAnchorAt('', 0, 'word')).toBeNull();
    expect(bubbleAnchorAt('   ', 1, 'word')).toBeNull();
  });
});

describe('bubble-notes — anchoring to a paragraph', () => {
  const text = 'First paragraph.\n\n  Second paragraph.\nStill second.\n\nThird.';

  it('returns the whole block, trimmed', () => {
    const anchor = bubbleAnchorAt(text, 20, 'paragraph');
    expect(anchor).not.toBeNull();
    expect(text.slice(anchor!.start, anchor!.end))
      .toBe('Second paragraph.\nStill second.');
  });

  it('returns null for an offset on a blank line', () => {
    expect(bubbleAnchorAt('One.\n\nTwo.', 5, 'paragraph')).toBeNull();
  });
});

describe('bubble-notes — validating stored records', () => {
  it('accepts a well-formed record', () => {
    expect(normalizeBubbleNote(note(), 0, 500)).toEqual(note());
  });

  it('drops a record with no question', () => {
    expect(normalizeBubbleNote({ ...note(), prompt: '   ' }, 0, 500)).toBeNull();
    expect(normalizeBubbleNote(null, 0, 500)).toBeNull();
    expect(normalizeBubbleNote('nope', 0, 500)).toBeNull();
  });

  it('drops a record anchored outside the document', () => {
    expect(normalizeBubbleNote({ ...note(), offset: 900 }, 0, 500)).toBeNull();
    expect(normalizeBubbleNote({ ...note(), offset: -1 }, 0, 500)).toBeNull();
  });

  it('repairs the pieces that can be defaulted rather than dropping the note', () => {
    const repaired = normalizeBubbleNote({
      ...note(),
      id: '',
      anchor: 'sentence',
      anchorEnd: 2,
      answer: undefined,
      prompt: '  Say it again  ',
    }, 3, 500)!;
    expect(repaired.id).toBe('bubble-3');
    expect(repaired.anchor).toBe('word');
    expect(repaired.anchorEnd).toBe(5);
    expect(repaired.answer).toBe('');
    expect(repaired.prompt).toBe('Say it again');
  });

  it('sorts a stored list by offset and drops the invalid entries', () => {
    const list = normalizeBubbleNotes([
      { ...note({ id: 'b2', offset: 90, anchorEnd: 95 }) },
      { ...note({ id: 'b1', offset: 10, anchorEnd: 15 }) },
      { prompt: '' },
    ], 500);
    expect(list.map(item => item.id)).toEqual(['b1', 'b2']);
  });
});

describe('bubble-notes — answers', () => {
  it('writes an answer and bumps the update time', () => {
    const { notes, updated } = setBubbleAnswer([note()], 'b1', 'It means fast.', 500);
    expect(updated?.answer).toBe('It means fast.');
    expect(updated?.updatedAt).toBe(500);
    expect(notes[0].answer).toBe('It means fast.');
  });

  it('leaves the list alone when the answer has not changed', () => {
    const list = [note({ answer: 'same' })];
    const { notes, updated } = setBubbleAnswer(list, 'b1', 'same', 500);
    expect(updated).toBeNull();
    expect(notes[0]).toBe(list[0]);
  });

  it('ignores an unknown id', () => {
    const list = [note()];
    const { updated } = setBubbleAnswer(list, 'nope', 'text', 500);
    expect(updated).toBeNull();
  });
});

describe('bubble-notes — storage', () => {
  beforeEach(() => localStorage.clear());

  it('keys notes by file identity, never by content', () => {
    const key = documentBubbleNotesKey({ name: 'My Notes.pdf', size: 2048, lastModified: 99 });
    expect(key).toContain('yapper.document-bubbles.v1:');
    expect(key).toContain(encodeURIComponent('My Notes.pdf'));
    expect(key.endsWith(':2048:99')).toBe(true);
  });

  it('round-trips a list', () => {
    const key = 'test:bubbles';
    saveDocumentBubbleNotes(key, [note({ id: 'b2', offset: 40, anchorEnd: 50 }), note()]);
    expect(loadDocumentBubbleNotes(key).map(item => item.id)).toEqual(['b1', 'b2']);
  });

  it('reads a corrupt or missing store as empty', () => {
    localStorage.setItem('test:corrupt', '{not json');
    expect(loadDocumentBubbleNotes('test:corrupt')).toEqual([]);
    expect(loadDocumentBubbleNotes('test:missing')).toEqual([]);
  });
});
