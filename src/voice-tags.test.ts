/**
 * Per-section voices, at the level that is easy to get wrong: character
 * ranges in, chunk plans out.
 *
 * The page must not move, no word may be cut in half, and every chunk has to
 * be speakable by exactly one voice. Those three promises are what these tests
 * hold onto; the highlighting promise is checked through `chunkWordPosition`,
 * which is the only thing the reader uses to find its way back from a
 * chunk-local word to a document word.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyVoiceTag,
  chunkWordCount,
  chunkWordPosition,
  documentVoiceTagsKey,
  loadVoiceTags,
  normalizeVoiceTags,
  paragraphRangeAt,
  removeVoiceTag,
  saveVoiceTags,
  voiceAt,
  type VoiceTag,
} from './voice-tags';
import { DocumentReaderSession, prepareReaderData, type ReaderChunk } from './reader';
import type { TTSEngine } from './engine';

const tag = (start: number, end: number, voiceId = 'af_bella', id = `t-${start}`): VoiceTag =>
  ({ id, start, end, voiceId });

/** Every word a chunk speaks, in order. */
function chunkWords(chunk: ReaderChunk): string[] {
  return chunk.segments.flatMap(segment =>
    segment.sentence.words.slice(segment.startWord, segment.endWord));
}

const allWords = (chunks: readonly ReaderChunk[]): string[] => chunks.flatMap(chunkWords);

describe('voiceAt', () => {
  const tags = [tag(10, 20, 'a'), tag(30, 40, 'b')];

  it('treats start as inclusive and end as exclusive', () => {
    expect(voiceAt(tags, 9)).toBeUndefined();
    expect(voiceAt(tags, 10)).toBe('a');
    expect(voiceAt(tags, 19)).toBe('a');
    expect(voiceAt(tags, 20)).toBeUndefined();
    expect(voiceAt(tags, 30)).toBe('b');
  });

  it('returns undefined in the gap between tags — the default voice', () => {
    expect(voiceAt(tags, 25)).toBeUndefined();
  });

  it('lets a nested tag win over the one that contains it', () => {
    const nested = [tag(0, 100, 'outer'), tag(40, 50, 'inner')];
    expect(voiceAt(nested, 10)).toBe('outer');
    expect(voiceAt(nested, 45)).toBe('inner');
    expect(voiceAt(nested, 60)).toBe('outer');
  });
});

describe('normalizeVoiceTags', () => {
  it('drops ranges that cannot describe text', () => {
    const tags = [
      tag(10, 10), // empty
      tag(20, 15), // backwards
      tag(-1, 5), // negative
      { ...tag(1, 5), voiceId: '  ' }, // no voice
      tag(0, 5, 'ok'),
    ];
    expect(normalizeVoiceTags(tags).map(t => t.voiceId)).toEqual(['ok']);
  });

  it('orders by position in the document', () => {
    const ordered = normalizeVoiceTags([tag(50, 60), tag(5, 10), tag(20, 30)]);
    expect(ordered.map(t => t.start)).toEqual([5, 20, 50]);
  });

  it('does not mutate the input', () => {
    const original = tag(5, 10);
    const input = [original];
    normalizeVoiceTags(input);
    expect(input[0]).toBe(original);
    expect(original.start).toBe(5);
  });
});

describe('applyVoiceTag', () => {
  it('trims an older tag that overlaps the new one', () => {
    const result = applyVoiceTag([tag(0, 100, 'old', 'old')], tag(40, 50, 'new', 'new'));
    expect(result.map(t => [t.start, t.end, t.voiceId])).toEqual([
      [0, 40, 'old'],
      [40, 50, 'new'],
      [50, 100, 'old'],
    ]);
  });

  it('drops an older tag entirely inside the new range', () => {
    const result = applyVoiceTag([tag(20, 30, 'old', 'old')], tag(0, 100, 'new', 'new'));
    expect(result).toHaveLength(1);
    expect(result[0].voiceId).toBe('new');
  });

  it('leaves disjoint tags alone', () => {
    const result = applyVoiceTag([tag(0, 10, 'a', 'a')], tag(20, 30, 'b', 'b'));
    expect(result).toHaveLength(2);
  });
});

describe('removeVoiceTag', () => {
  it('removes exactly one tag', () => {
    const result = removeVoiceTag([tag(0, 10, 'a', 'a'), tag(20, 30, 'b', 'b')], 'a');
    expect(result.map(t => t.id)).toEqual(['b']);
  });
});

describe('paragraphRangeAt', () => {
  it('spans every sentence of the paragraph', () => {
    const text = 'First one. First two.\n\nSecond paragraph.';
    const { sentences } = prepareReaderData(text);
    const range = paragraphRangeAt(sentences, sentences[0].globalIndex)!;
    expect(text.slice(range.start, range.end)).toBe('First one. First two.');
    const second = paragraphRangeAt(sentences, sentences[2].globalIndex)!;
    expect(text.slice(second.start, second.end)).toBe('Second paragraph.');
  });

  it('returns null for an unknown sentence', () => {
    expect(paragraphRangeAt([], 3)).toBeNull();
  });
});

// ─── Chunk splitting ────────────────────────────────────────────────

/** Offsets are hand-computed once so the boundary cases are readable. */
const ONE_CHUNK = 'One two three. Four five six. Seven eight nine.';
//    One 0, two 4, three. 8, Four 15, five 20, six. 25,
//    Seven 30, eight 36, nine. 42 — "Four" begins the second sentence.
const MATCHING_WORDS = ['One', 'two', 'three.', 'Four', 'five', 'six.', 'Seven', 'eight', 'nine.'];

function chunksOf(text: string, size = 300, tags: VoiceTag[] = []): ReaderChunk[] {
  return prepareReaderData(text, size, undefined, tags).chunks;
}

describe('splitChunksByVoice — boundary positions', () => {
  it('only splits at a boundary that falls inside a chunk', () => {
    const chunks = chunksOf(ONE_CHUNK, 300, [tag(15, 47)]);
    expect(chunks.map(chunk => chunk.text)).toEqual([
      'One two three.',
      'Four five six. Seven eight nine.',
    ]);
    expect(chunks.map(chunk => chunk.voiceId)).toEqual([undefined, 'af_bella']);
  });

  it('leaves a chunk whose start is the boundary alone', () => {
    // Two chunks: "Alpha beta gamma. Delta epsilon zeta." / "Eta theta iota. …"
    const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.';
    const etaAt = text.indexOf('Eta');
    const chunks = chunksOf(text, 40, [tag(etaAt, text.length)]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].voiceId).toBeUndefined();
    expect(chunks[1].voiceId).toBe('af_bella');
    // No split: the second chunk already began in the tagged section.
    expect(chunks[1].text).toBe('Eta theta iota. Kappa lambda mu.');
  });

  it('does not split when the boundary sits exactly at a chunk end', () => {
    const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.';
    const endOfFirstChunk = text.indexOf('Eta') - 2; // end of "zeta." + the space
    const chunks = chunksOf(text, 40, [tag(0, endOfFirstChunk)]);
    expect(chunks).toHaveLength(2);
    expect(chunks.map(chunk => chunk.voiceId)).toEqual(['af_bella', undefined]);
    expect(chunks[1].text).toBe('Eta theta iota. Kappa lambda mu.');
  });

  it('splits at the next word when the boundary falls mid-word', () => {
    // 16 is between the "F" and the "o" of "Four" (which starts at 15).
    const chunks = chunksOf(ONE_CHUNK, 300, [tag(16, 47)]);
    expect(chunks.map(chunk => chunk.text)).toEqual([
      'One two three. Four',
      'five six. Seven eight nine.',
    ]);
    // A word is never cut: the word that started before the boundary stays
    // whole and in the previous voice.
    expect(chunkWords(chunks[0])).toEqual(['One', 'two', 'three.', 'Four']);
    expect(chunks[1].voiceId).toBe('af_bella');
  });

  it('splits when a tag starts on the final word of the document', () => {
    const chunks = chunksOf(ONE_CHUNK, 300, [tag(42, 47)]);
    expect(chunks.map(chunk => chunk.text)).toEqual([
      'One two three. Four five six. Seven eight',
      'nine.',
    ]);
    expect(chunks.map(chunk => chunk.voiceId)).toEqual([undefined, 'af_bella']);
  });

  it('applies one voice to every chunk when the tag spans the document', () => {
    const plain = chunksOf(ONE_CHUNK, 60);
    const tagged = chunksOf(ONE_CHUNK, 60, [tag(0, ONE_CHUNK.length)]);
    expect(tagged).toHaveLength(plain.length);
    expect(tagged.map(chunk => chunk.voiceId)).toEqual(plain.map(() => 'af_bella'));
    expect(tagged.map(chunk => chunk.text)).toEqual(plain.map(chunk => chunk.text));
  });

  it('ignores a tag that covers only the whitespace between sentences', () => {
    // [14, 15) is the single space after "three." — no word starts inside it.
    const chunks = chunksOf(ONE_CHUNK, 300, [tag(14, 15)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].voiceId).toBeUndefined();
    expect(chunks[0].text).toBe(ONE_CHUNK);
  });

  it('handles a tag in the middle of a sentence with two chunks on each side', () => {
    // Tag on "five six." only (20..29).
    const chunks = chunksOf(ONE_CHUNK, 300, [tag(20, 29)]);
    expect(chunks.map(chunk => chunk.text)).toEqual([
      'One two three. Four',
      'five six.',
      'Seven eight nine.',
    ]);
    expect(chunks.map(chunk => chunk.voiceId)).toEqual([undefined, 'af_bella', undefined]);
  });

  it('never produces an empty chunk', () => {
    for (const chunk of chunksOf(ONE_CHUNK, 300, [tag(0, 47)])) {
      expect(chunkWordCount(chunk)).toBeGreaterThan(0);
      expect(chunk.text.trim()).not.toBe('');
    }
  });
});

describe('splitChunksByVoice — properties at every word boundary', () => {
  /** Absolute offset of every word start in the text. */
  function wordStarts(): number[] {
    const { sentences } = prepareReaderData(ONE_CHUNK);
    return sentences.flatMap(sentence => {
      const starts: number[] = [];
      const pattern = /\S+/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(sentence.text)) !== null) {
        starts.push(sentence.start! + match.index);
      }
      return starts;
    });
  }

  /** Absolute offset of the first word a chunk speaks. */
  function firstWordOffset(chunk: ReaderChunk): number | null {
    const segment = chunk.segments[0];
    if (!segment) return null;
    const { sentence } = segment;
    const pattern = /\S+/g;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = pattern.exec(sentence.text)) !== null) {
      if (index === segment.startWord) return sentence.start! + match.index;
      index++;
    }
    return null;
  }

  it('leaves the spoken word sequence unchanged at every boundary', () => {
    const expected = allWords(chunksOf(ONE_CHUNK, 300));
    expect(expected).toEqual(MATCHING_WORDS);

    for (const start of wordStarts()) {
      const chunks = chunksOf(ONE_CHUNK, 300, [tag(start, ONE_CHUNK.length)]);
      // Same words, same order, no duplicates and nothing lost.
      expect(allWords(chunks)).toEqual(expected);
      for (const chunk of chunks) {
        expect(chunkWordCount(chunk)).toBeGreaterThan(0);
      }
    }
  });

  it('never lets one chunk speak two voices', () => {
    const starts = wordStarts();
    for (const start of starts) {
      const tags = [tag(start, ONE_CHUNK.length)];
      const chunks = chunksOf(ONE_CHUNK, 300, tags);
      // Word order is global, so chunk lengths walk the same offsets the
      // splitter saw. Every word inside a chunk must agree with the voice the
      // chunk begins in — that is what "no chunk straddles two voices" means.
      let cursor = 0;
      for (const chunk of chunks) {
        const count = chunkWordCount(chunk);
        for (const offset of starts.slice(cursor, cursor + count)) {
          expect(voiceAt(tags, offset)).toBe(chunk.voiceId);
        }
        cursor += count;
      }
      expect(cursor).toBe(starts.length);
      expect(chunks.map(chunk => chunk.index)).toEqual(chunks.map((_, index) => index));
    }
  });

  it('assigns each chunk the voice in force at its first word', () => {
    for (const start of wordStarts()) {
      const tags = [tag(start, ONE_CHUNK.length)];
      for (const chunk of chunksOf(ONE_CHUNK, 300, tags)) {
        const offset = firstWordOffset(chunk);
        expect(offset).not.toBeNull();
        expect(chunk.voiceId).toBe(voiceAt(tags, offset!));
      }
    }
  });
});

describe('chunkWordPosition', () => {
  it('maps the second half of a split sentence back to its real word indices', () => {
    const chunks = chunksOf(ONE_CHUNK, 300, [tag(15, 47)]);
    const second = chunks[1];

    expect(chunkWordCount(second)).toBe(6);
    expect(chunkWordPosition(second, 0)).toEqual({ sentenceIndex: 1, wordIndex: 0 });
    expect(chunkWordPosition(second, 2)).toEqual({ sentenceIndex: 1, wordIndex: 2 });
    expect(chunkWordPosition(second, 3)).toEqual({ sentenceIndex: 2, wordIndex: 0 });
    expect(chunkWordPosition(second, 5)).toEqual({ sentenceIndex: 2, wordIndex: 2 });
  });

  it('returns null past the end rather than clamping', () => {
    const chunks = chunksOf(ONE_CHUNK, 300, [tag(15, 47)]);
    expect(chunkWordPosition(chunks[1], 6)).toBeNull();
    expect(chunkWordPosition(chunks[1], -1)).toBeNull();
  });
});

// ─── Reader integration ────────────────────────────────────────────

describe('DocumentReaderSession — section voices', () => {
  const VOICES = [
    { id: 'af_heart', name: 'Heart' },
    { id: 'am_adam', name: 'Adam' },
  ];

  function engineWithVoices(voices: Array<{ id: string; name: string }> = VOICES) {
    const enqueue = vi.fn((_text: string, _options?: { voiceId?: string }) => ({
      id: `job-${enqueue.mock.calls.length}`,
      status: 'pending' as const,
      url: undefined,
    }));
    const engine = {
      enqueue,
      cancel: vi.fn(),
      on: vi.fn(() => () => {}),
      getCurrentModel: vi.fn(() => ({
        id: 'kokoro-82m',
        name: 'Kokoro-82M',
        voices,
        defaultVoiceId: voices[0]?.id,
      })),
    };
    return { enqueue, engine };
  }

  it('queues the tagged half with the tagged voice and the rest with the default', async () => {
    const { enqueue, engine } = engineWithVoices();
    const session = new DocumentReaderSession(engine as unknown as TTSEngine, ONE_CHUNK, {
      chunkSize: 300,
      voiceTags: [tag(15, 47, 'am_adam')],
    });
    session.start(0);

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0][1]?.voiceId).toBeUndefined();
    expect(enqueue.mock.calls[1][1]?.voiceId).toBe('am_adam');
    expect(String(enqueue.mock.calls[1][0])).toBe('Four five six. Seven eight nine.');
    session.stop();
  });

  it('uses the session voice for untagged chunks', () => {
    const { enqueue, engine } = engineWithVoices();
    const session = new DocumentReaderSession(engine as unknown as TTSEngine, ONE_CHUNK, {
      chunkSize: 300,
      voiceId: 'af_heart',
      voiceTags: [tag(15, 47, 'am_adam')],
    });
    session.start(0);
    expect(enqueue.mock.calls[0][1]?.voiceId).toBe('af_heart');
    expect(enqueue.mock.calls[1][1]?.voiceId).toBe('am_adam');
    session.stop();
  });

  it('refuses to play when the model cannot speak a tagged voice', () => {
    const { enqueue, engine } = engineWithVoices([]);
    const session = new DocumentReaderSession(engine as unknown as TTSEngine, ONE_CHUNK, {
      chunkSize: 300,
      voiceTags: [tag(15, 47, 'am_adam')],
    });
    session.start(0);

    expect(session.getState().status).toBe('paused');
    expect(session.getState().error).toMatch(/single fixed voice/i);
    expect(session.getVoiceTagsError()).toMatch(/single fixed voice/i);
    // Nothing was queued in the wrong voice.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a voice the model does not offer', () => {
    const { engine } = engineWithVoices();
    const session = new DocumentReaderSession(engine as unknown as TTSEngine, ONE_CHUNK, {
      chunkSize: 300,
      voiceTags: [tag(15, 47, 'not-a-voice')],
    });
    session.start(0);
    expect(session.getState().status).toBe('paused');
    expect(session.getState().error).toContain('not-a-voice');
  });

  it('does not block silent reading, which has no voice to honour', () => {
    const session = new DocumentReaderSession(null, ONE_CHUNK, {
      silent: true,
      voiceTags: [tag(15, 47, 'am_adam')],
    });
    session.start(0);
    expect(session.getState().status).toBe('playing');
    expect(session.getVoiceTagsError()).toBeNull();
  });

  it('re-plans mid-session without losing the position', () => {
    const { enqueue, engine } = engineWithVoices();
    const session = new DocumentReaderSession(engine as unknown as TTSEngine, ONE_CHUNK, {
      chunkSize: 300,
    });
    session.start(0);
    expect(session.getChunks()).toHaveLength(1);

    const before = session.getPosition();
    session.applyVoiceTags([tag(15, 47, 'am_adam')]);

    expect(session.getChunks()).toHaveLength(2);
    expect(session.getState().totalChunks).toBe(2);
    // Same cursor, but now in the chunk that holds that word.
    expect(session.getPosition()).toEqual(before);
    expect(session.getState().currentIndex).toBe(0);
    expect(enqueue).toHaveBeenCalled();
    session.stop();
  });
});

// ─── Storage ────────────────────────────────────────────────────────

describe('voice tag storage', () => {
  it('keys by file identity, never content', () => {
    const file = { name: 'A Tale.pdf', size: 42, lastModified: 1_700_000_000 };
    const key = documentVoiceTagsKey(file);
    expect(key).toContain(encodeURIComponent('A Tale.pdf'));
    expect(key).toContain(':42:1700000000');
    expect(documentVoiceTagsKey({ ...file, size: 43 })).not.toBe(key);
  });

  it('round-trips tags through localStorage', () => {
    localStorage.clear();
    const key = documentVoiceTagsKey({ name: 'x.txt', size: 1, lastModified: 2 });
    saveVoiceTags(key, [tag(5, 10)]);
    expect(loadVoiceTags(key)).toEqual([tag(5, 10)]);
  });

  it('drops corrupt saved entries instead of trusting them', () => {
    localStorage.clear();
    const key = 'yapper.document-voices.v1:broken';
    localStorage.setItem(key, JSON.stringify([
      { start: 0, end: 0, voiceId: 'a' },
      { start: 5, end: 2, voiceId: 'a' },
      { start: 1, end: 4 },
      { start: 1, end: 4, voiceId: 'ok' },
    ]));
    expect(loadVoiceTags(key).map(t => t.voiceId)).toEqual(['ok']);
  });

  it('returns nothing when the store is unreadable', () => {
    expect(loadVoiceTags('yapper.document-voices.v1:missing')).toEqual([]);
    localStorage.setItem('yapper.document-voices.v1:garbage', '{not json');
    expect(loadVoiceTags('yapper.document-voices.v1:garbage')).toEqual([]);
  });
});
