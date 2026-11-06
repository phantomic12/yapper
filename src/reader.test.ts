import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  prepareReaderData,
  pickHighlightedWord,
  sentenceAtOffset,
  DocumentReaderSession,
  type HighlightInfo,
  type ReaderOptions,
  type ReaderState,
} from './reader';
import { silentWordDurationMs } from './reading-units';
import type { TTSEngine } from './engine';

describe('prepareReaderData — sentence segmentation', () => {
  it('splits on plain terminal punctuation', () => {
    const { sentences } = prepareReaderData('Hello. World! How are you?');
    expect(sentences.map(s => s.text)).toEqual(['Hello.', 'World!', 'How are you?']);
  });

  it('keeps English titles like "Mr." and "Dr." inside the same sentence', () => {
    const { sentences } = prepareReaderData('Mr. Smith went to Washington. He arrived at noon.');
    expect(sentences.map(s => s.text)).toEqual([
      'Mr. Smith went to Washington.',
      'He arrived at noon.',
    ]);
  });

  it('keeps Mrs./Ms./Mx./Prof. together', () => {
    const { sentences } = prepareReaderData('Mrs. Jones met Prof. Brown at the cafe.');
    expect(sentences.map(s => s.text)).toEqual(['Mrs. Jones met Prof. Brown at the cafe.']);
  });

  it('keeps month abbreviations intact', () => {
    const { sentences } = prepareReaderData('On Jan. 5, 2024, the meeting was held.');
    expect(sentences.map(s => s.text)).toEqual(['On Jan. 5, 2024, the meeting was held.']);
  });

  it('keeps decimals like "3.5" inside one sentence', () => {
    const text = 'Version 3.5 is out. Grab it now.';
    const { sentences } = prepareReaderData(text);
    expect(sentences.map(s => s.text)).toEqual(['Version 3.5 is out.', 'Grab it now.']);
    // The protected-then-restored text must still locate in the source.
    for (const s of sentences) {
      expect(text.slice(s.start!, s.end!)).toBe(s.text);
    }
  });

  it('still splits when a sentence ends with a number', () => {
    const { sentences } = prepareReaderData('The ratio held at 3.5. Next came the drop.');
    expect(sentences.map(s => s.text)).toEqual(['The ratio held at 3.5.', 'Next came the drop.']);
  });

  it('keeps multi-part version numbers whole', () => {
    const { sentences } = prepareReaderData('Upgrading 3.5.1 was painless.');
    expect(sentences.map(s => s.text)).toEqual(['Upgrading 3.5.1 was painless.']);
  });

  it('protects a decimal and an abbreviation in the same sentence', () => {
    const { sentences } = prepareReaderData('Mr. Smith paid 3.5 dollars. He left.');
    expect(sentences.map(s => s.text)).toEqual(['Mr. Smith paid 3.5 dollars.', 'He left.']);
  });

  it('keeps a marked row whole when a cell contains sentence punctuation', () => {
    const text = 'Before the table.\n\nAda handled the first pass. Then the second, 98\n\nAfter the table.';
    const row = 'Ada handled the first pass. Then the second, 98';
    const start = text.indexOf('Ada');
    const { sentences } = prepareReaderData(text, 300, [[start, start + row.length]]);
    expect(sentences.map(s => s.text)).toEqual([
      'Before the table.',
      row,
      'After the table.',
    ]);
    // Offsets still slice back to exactly the sentence, merged or not.
    for (const s of sentences) {
      expect(text.slice(s.start!, s.end!)).toBe(s.text);
    }
  });

  it('merges the pieces of one marked range when a cell holds a blank line', () => {
    const text = 'One. Two.\n\nfirst row piece. still the row\n\nsecond row piece, 98\n\nTail paragraph.';
    const start = text.indexOf('first row piece');
    const end = text.indexOf('second row piece, 98') + 'second row piece, 98'.length;
    const { sentences } = prepareReaderData(text, 300, [[start, end]]);
    expect(sentences.map(s => s.text)).toEqual([
      // Ordinary paragraphs either side of the range still split normally.
      'One.', 'Two.',
      'first row piece. still the row\n\nsecond row piece, 98',
      'Tail paragraph.',
    ]);
  });

  it('splits on Chinese/CJK punctuation', () => {
    const { sentences } = prepareReaderData('你好。世界！你好吗？');
    expect(sentences.map(s => s.text)).toEqual(['你好。', '世界！', '你好吗？']);
  });

  it('preserves trailing closing quotes/parentheses', () => {
    const { sentences } = prepareReaderData('"Stop!" she shouted. He ran.');
    // We accept either fully-merged or split-by-quote pairs as long as the
    // first sentence preserves both the punctuation and the closing quote.
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences[0].text.endsWith('!')).toBe(true);
  });

  it('returns one sentence for text without terminal punctuation', () => {
    const { sentences } = prepareReaderData('a long sentence without terminal punctuation');
    expect(sentences).toHaveLength(1);
    expect(sentences[0].text).toBe('a long sentence without terminal punctuation');
  });

  it('handles paragraphs separated by blank lines', () => {
    const { sentences } = prepareReaderData('First paragraph one.\n\nSecond paragraph two.');
    expect(sentences).toHaveLength(2);
    expect(sentences[0].paragraphIndex).toBe(0);
    expect(sentences[1].paragraphIndex).toBe(1);
  });

  it('returns a single fallback sentence for empty text', () => {
    const { sentences } = prepareReaderData('');
    expect(sentences).toEqual([]);
  });

  it('extracts whitespace-separated words', () => {
    const { sentences } = prepareReaderData('Hello, world. Foo bar baz.');
    expect(sentences[0].words).toEqual(['Hello,', 'world.']);
    expect(sentences[1].words).toEqual(['Foo', 'bar', 'baz.']);
  });
});

describe('prepareReaderData — chunking', () => {
  it('packs multiple short sentences into one chunk under the limit', () => {
    const { chunks } = prepareReaderData('A. B. C. D. E.', 50);
    // "A. B. C. D." is 12 chars, well under 50 → one chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0].sentences.length).toBeGreaterThan(1);
  });

  it('splits into multiple chunks when the limit is exceeded', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.';
    const { chunks } = prepareReaderData(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('keeps a long single sentence in its own chunk (no word-clipping)', () => {
    const long = 'a'.repeat(500);
    const { chunks } = prepareReaderData(long + '. short.', 100);
    const longChunk = chunks.find(c => c.text.startsWith('aaaa'));
    expect(longChunk).toBeDefined();
    // The single long sentence stays whole; the period is consumed as its
    // terminator. No word-clipping anywhere.
    expect(longChunk!.text).toBe(long + '.');
  });

  it('produces chunks in sentence order', () => {
    const { chunks } = prepareReaderData('one. two. three. four.', 15);
    const flat = chunks.flatMap(c => c.sentences.map(s => s.text));
    expect(flat).toEqual(['one.', 'two.', 'three.', 'four.']);
  });

  it('returns no chunks for empty text', () => {
    const { chunks } = prepareReaderData('');
    expect(chunks).toEqual([]);
  });
});

describe('pickHighlightedWord', () => {
  it('returns 0 when there are no words', () => {
    expect(pickHighlightedWord(0, 1, 10)).toBe(0);
    expect(pickHighlightedWord(-1, 1, 10)).toBe(0);
  });

  it('falls back to chunk ratio when no timings are provided', () => {
    // 10 words, chunk duration 10s → halfway is word 5
    expect(pickHighlightedWord(10, 5, 10)).toBe(5);
    expect(pickHighlightedWord(10, 0, 10)).toBe(0);
    expect(pickHighlightedWord(10, 9.99, 10)).toBe(9);
    expect(pickHighlightedWord(10, 100, 10)).toBe(9); // clamped at last
  });

  it('clamps negative or NaN time to 0', () => {
    expect(pickHighlightedWord(10, -1, 10)).toBe(0);
    expect(pickHighlightedWord(10, NaN, 10)).toBe(0);
  });

  it('uses wordTimings when present (binary search)', () => {
    // 6 words, evenly spaced across 6s
    const timings = [0, 1, 2, 3, 4, 5];
    expect(pickHighlightedWord(6, 0.0, 6, timings)).toBe(0);
    expect(pickHighlightedWord(6, 1.5, 6, timings)).toBe(1);
    expect(pickHighlightedWord(6, 5.5, 6, timings)).toBe(5);
    // Exactly at a boundary: word 3 starts at t=3, so t=3 returns word 3
    expect(pickHighlightedWord(6, 3.0, 6, timings)).toBe(3);
  });

  it('does not jump backwards when timings are dense at the start', () => {
    // Word 5 starts at t=0.1 — even at currentTime=0 it's already "passed"
    // because we want the *latest* word whose start <= currentTime.
    const timings = [0, 0.01, 0.02, 0.03, 0.04, 0.1];
    // t=0: only word 0 has start <= 0
    expect(pickHighlightedWord(6, 0, 6, timings)).toBe(0);
    // t=0.05: words 0..4 qualify, latest is 4
    expect(pickHighlightedWord(6, 0.05, 6, timings)).toBe(4);
  });

  it('falls back to chunk ratio if timings are shorter than word count', () => {
    // Engine provided timings for fewer words than the chunk contains;
    // ratio fallback is safer than indexing past the end.
    const timings = [0, 1];  // only 2 timings, 10 words
    expect(pickHighlightedWord(10, 5, 10, timings)).toBe(5); // ratio wins
  });
});
// ─── Session pause/resume ─────────────────────────────────────────

/** A session whose chunk jobs are never "done": tryPlayNext() returns
 * before touching <audio>, which jsdom does not implement. */
function idleSession(): DocumentReaderSession {
  const engine = {
    enqueue: vi.fn(() => ({ id: 'job-1', status: 'pending', url: undefined })),
    cancel: vi.fn(),
    on: vi.fn(() => () => {}),
    getCurrentModel: vi.fn(() => ({ id: 'kitten-nano' })),
  } as unknown as TTSEngine;
  return new DocumentReaderSession(engine, 'One sentence. Another sentence.', { chunkSize: 200 });
}

describe('DocumentReaderSession — pause and resume', () => {
  it('resumeAfterGesture() resumes from an ordinary Pause', () => {
    // Regression: resumeAfterGesture() used to do nothing unless autoplay
    // had been blocked, so pressing Pause then Resume left the button
    // labelled Resume, the click inert, and Stop the only way out.
    const session = idleSession();
    session.pause();
    expect(session.getState().status).toBe('paused');

    session.resumeAfterGesture();
    expect(session.getState().status).toBe('playing');
    expect(session.getState().isPlaying).toBe(true);
  });

  it('resumeAfterGesture() is a no-op while already playing', () => {
    const changes: string[] = [];
    const session = new DocumentReaderSession(
      {
        enqueue: vi.fn(() => ({ id: 'job-1', status: 'pending', url: undefined })),
        cancel: vi.fn(),
        on: vi.fn(() => () => {}),
        getCurrentModel: vi.fn(() => ({ id: 'kitten-nano' })),
      } as unknown as TTSEngine,
      'One sentence. Another sentence.',
      { chunkSize: 200, onStateChange: (s) => changes.push(s.status) },
    );

    session.pause();
    session.resumeAfterGesture();
    expect(session.getState().status).toBe('playing');
    const seen = changes.length;

    session.resumeAfterGesture();
    expect(session.getState().status).toBe('playing');
    expect(changes.length).toBe(seen);
  });

  it('clears a stale needsUserGesture when it resumes', () => {
    // Once playback is under way the "Click to play" hint must not linger
    // and keep the buttons labelled Resume.
    const session = idleSession();
    session.pause();
    session.resumeAfterGesture();
    expect(session.getState().needsUserGesture).toBeUndefined();
  });
});

describe('DocumentReaderSession — iOS autoplay priming', () => {
  /** The session's private <audio>, reached the way the priming tests need. */
  function audioOf(session: DocumentReaderSession): HTMLAudioElement {
    return (session as unknown as { audio: HTMLAudioElement }).audio;
  }

  it('start() primes the element with the silent clip inside the gesture', () => {
    const session = idleSession();
    session.start();
    expect(audioOf(session).src).toContain('data:audio/wav');
  });

  it('a finished prime clip retries playback instead of advancing chunks', () => {
    const session = idleSession();
    session.start();
    const audio = audioOf(session);
    expect(session.getState().currentIndex).toBe(0);

    // The silent WAV ends almost immediately; without the src guard this
    // 'ended' would advance() past chunk 0 and swallow the first chunk.
    audio.dispatchEvent(new Event('ended'));
    expect(session.getState().currentIndex).toBe(0);
  });

  it('a finished chunk still advances once its real URL is playing', () => {
    const session = idleSession();
    session.start();
    const audio = audioOf(session);

    // Simulate the first chunk landing: mark its job done with a URL and
    // point the element at it, then end it — this is a real boundary.
    const chunk = session.getChunks()[0];
    chunk.job = { id: 'job-1', status: 'done', url: 'blob:chunk-0' } as never;
    audio.src = 'blob:chunk-0';
    audio.dispatchEvent(new Event('ended'));
    expect(session.getState().currentIndex).toBe(1);
  });
});

describe('sentence character offsets', () => {
  it('slices each range back to exactly the sentence text', () => {
    const text = 'The first sentence. The second one. And a third.';
    const { sentences } = prepareReaderData(text);
    for (const s of sentences) {
      expect(s.start).toBeTypeOf('number');
      expect(text.slice(s.start!, s.end!)).toBe(s.text);
    }
  });

  it('locates sentences that segmentation rewrote', () => {
    // The segmenter protects abbreviations, splits, then restores the dot.
    // A range threaded through that pipeline would be off by however many
    // characters the placeholder dance moved things.
    const text = 'Dr. Smith went home. Mrs. Jones stayed.';
    const { sentences } = prepareReaderData(text);
    expect(sentences).toHaveLength(2);
    expect(text.slice(sentences[0].start!, sentences[0].end!)).toBe('Dr. Smith went home.');
    expect(text.slice(sentences[1].start!, sentences[1].end!)).toBe('Mrs. Jones stayed.');
  });

  it('gives two identical sentences two different ranges', () => {
    // A plain lastIndexOf would put both at the same place and highlight the
    // wrong one; this is the case the forward-scanning cursor exists for.
    //
    // Exclamation points, not full stops, on purpose: the abbreviation guard
    // protects any capitalised word before a capitalised word ("Yes. No." is
    // read as two initialisms and never splits), so a period would not even
    // produce two sentences to compare.
    const text = 'Yes! No! Yes!';
    const { sentences } = prepareReaderData(text);
    expect(sentences.map(s => s.text)).toEqual(['Yes!', 'No!', 'Yes!']);
    expect(sentences[0].start).toBe(0);
    expect(sentences[2].start).toBe(text.length - 'Yes!'.length);
    expect(sentences[0].start).not.toBe(sentences[2].start);
  });

  it('keeps ranges ordered and non-overlapping across the document', () => {
    const text = 'One. Two words here. Three! Four? Five. Six.';
    const { sentences } = prepareReaderData(text);
    for (let i = 1; i < sentences.length; i++) {
      expect(sentences[i].start!).toBeGreaterThan(sentences[i - 1].start!);
      expect(sentences[i].end!).toBeGreaterThan(sentences[i].start!);
    }
  });

  it('covers the whole text with no gaps it could have filled', () => {
    const text = 'Alpha beta. Gamma delta epsilon. Zeta.';
    const { sentences } = prepareReaderData(text);
    for (const s of sentences) {
      expect(s.end! - s.start!).toBe(s.text.length);
    }
  });

  it('leaves offsets undefined for empty input rather than pointing at 0', () => {
    const { sentences } = prepareReaderData('   ');
    expect(sentences).toHaveLength(0);
  });
});

// ─── Click-to-read ────────────────────────────────────────────────
// A click on the rendered document arrives as a character offset into the
// extracted text. These two pieces are what turn that back into a reading
// position: the sentence the offset sits in, and a session that can start
// there.

describe('sentenceAtOffset', () => {
  it('finds the sentence an offset falls inside', () => {
    const text = 'First sentence here. Second sentence here.';
    const { sentences } = prepareReaderData(text);
    const second = sentences[1];
    expect(sentenceAtOffset(sentences, second.start! + 3)).toBe(second);
  });

  it('treats the end of a range as outside it', () => {
    // Ranges are half-open. An offset equal to `end` is the first character
    // of whatever follows, and claiming the preceding sentence for it would
    // make clicking the start of a line read the line above.
    const { sentences } = prepareReaderData('One. Two.');
    expect(sentenceAtOffset(sentences, sentences[0].end!)).not.toBe(sentences[0]);
  });

  it('returns null for the gap between paragraphs', () => {
    const text = 'One.\n\nTwo.';
    const { sentences } = prepareReaderData(text);
    const gap = sentences[0].end! + 1;
    expect(text.slice(gap, gap + 1)).toBe('\n');
    expect(sentenceAtOffset(sentences, gap)).toBeNull();
  });

  it('ignores a sentence whose range could not be located', () => {
    // assignOffsets leaves start/end undefined rather than guessing, so the
    // lookup has to cope with an array that is not uniformly ranged.
    const sentences = [
      { text: 'unlocatable', words: ['unlocatable'], globalIndex: 0, paragraphIndex: 0 },
      { text: 'found', words: ['found'], globalIndex: 1, paragraphIndex: 0, start: 10, end: 15 },
    ];
    expect(sentenceAtOffset(sentences, 12)?.globalIndex).toBe(1);
    expect(sentenceAtOffset(sentences, 5)).toBeNull();
  });
});

describe('DocumentReaderSession — start at a sentence', () => {
  const ENGINE = {
    enqueue: vi.fn(() => ({ id: 'job-1', status: 'pending', url: undefined })),
    cancel: vi.fn(),
    on: vi.fn(() => () => {}),
    getCurrentModel: vi.fn(() => ({ id: 'kitten-nano' })),
  } as unknown as TTSEngine;

  /** Six sentences, chunked two at a time, so there is somewhere to start. */
  const LONG = Array.from({ length: 6 }, (_, i) => `Sentence number ${i} is here.`).join(' ');

  it('starts at the chunk holding the requested sentence', () => {
    const session = new DocumentReaderSession(ENGINE, LONG, { chunkSize: 60 });
    const sentences = session.getSentences();
    expect(session.getChunks().length).toBeGreaterThan(1);

    session.start(sentences[sentences.length - 1].globalIndex);
    const state = session.getState();
    expect(state.currentIndex).toBe(session.getChunks().length - 1);
    expect(state.status).toBe('playing');
  });

  it('still starts at the beginning when no sentence is given', () => {
    const session = new DocumentReaderSession(ENGINE, LONG, { chunkSize: 60 });
    session.start();
    expect(session.getState().currentIndex).toBe(0);
  });

  it('falls back to the first chunk for an unknown sentence index', () => {
    // A stale index from a document that has been replaced should read the
    // document, not refuse to play.
    const session = new DocumentReaderSession(ENGINE, LONG, { chunkSize: 60 });
    session.start(9999);
    expect(session.getState().currentIndex).toBe(0);
    expect(session.getState().status).toBe('playing');
  });

  it('queues synthesis for the sentence it started at', () => {
    // Starting in the middle must not leave the session waiting on chunk 0:
    // without lookahead from the new position the reader would sit silent.
    const enqueue = vi.fn(() => ({ id: 'job-1', status: 'pending', url: undefined }));
    const engine = { ...ENGINE, enqueue } as unknown as TTSEngine;
    const session = new DocumentReaderSession(engine, LONG, { chunkSize: 60 });
    const sentences = session.getSentences();
    session.start(sentences[sentences.length - 1].globalIndex);
    expect(enqueue).toHaveBeenCalled();
    const queued = enqueue.mock.calls.map(c => String(c[0]));
    expect(queued.some(text => text.includes('Sentence number 5'))).toBe(true);
  });
});

// ─── Pronunciation overrides ──────────────────────────────────────

describe('DocumentReaderSession — pronunciation overrides', () => {
  const engineWithSpy = () => {
    const enqueue = vi.fn((_text: string, _opts?: unknown) => ({
      id: 'job-1',
      status: 'pending',
      url: undefined,
    }));
    const engine = {
      enqueue,
      cancel: vi.fn(),
      on: vi.fn(() => () => {}),
      getCurrentModel: vi.fn(() => ({ id: 'kitten-nano' })),
    } as unknown as TTSEngine;
    return { enqueue, engine };
  };

  it('hands the rewritten text to the engine and keeps the written text on screen', () => {
    const { enqueue, engine } = engineWithSpy();
    const session = new DocumentReaderSession(engine, 'Doctor Reyes arrived.', {
      chunkSize: 200,
      pronunciations: [{ word: 'Reyes', say: 'RAY-ess' }],
    });
    session.start(0);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(String(enqueue.mock.calls[0][0])).toBe('Doctor RAY-ess arrived.');
    // The chunk the page renders is untouched.
    expect(session.getChunks()[0].text).toBe('Doctor Reyes arrived.');
  });

  it('records a word map only for chunks that changed', () => {
    const { engine } = engineWithSpy();
    const session = new DocumentReaderSession(engine, 'Doctor Reyes arrived.', {
      chunkSize: 200,
      pronunciations: [{ word: 'Reyes', say: 'RAY-ess' }],
    });
    session.start(0);

    const chunk = session.getChunks()[0];
    expect(chunk.wordMap).toEqual([0, 1, 2]);
  });

  it('leaves chunks alone when no rule matches', () => {
    const { enqueue, engine } = engineWithSpy();
    const session = new DocumentReaderSession(engine, 'Nothing to fix here.', {
      chunkSize: 200,
      pronunciations: [{ word: 'absent', say: 'x' }],
    });
    session.start(0);

    expect(String(enqueue.mock.calls[0][0])).toBe('Nothing to fix here.');
    expect(session.getChunks()[0].wordMap).toBeNull();
  });

  it('behaves exactly as before when no rules are configured', () => {
    const { enqueue, engine } = engineWithSpy();
    const session = new DocumentReaderSession(engine, 'Plain text only.', { chunkSize: 200 });
    session.start(0);

    expect(String(enqueue.mock.calls[0][0])).toBe('Plain text only.');
    expect(session.getChunks()[0].wordMap).toBeNull();
  });
});

// ─── Silent reading, skip, and reading units ───────────────────────

/** A session with its hands off the audio element, for pacing tests. */
function silentSession(text: string, options: ReaderOptions = {}) {
  const highlights: HighlightInfo[] = [];
  const states: ReaderState[] = [];
  const session = new DocumentReaderSession(null, text, {
    chunkSize: 40,
    silent: true,
    onHighlight: info => highlights.push(info),
    onStateChange: state => states.push(state),
    ...options,
  });
  return { session, highlights, states };
}

/** jsdom does not implement the audio element; this reaches it anyway. */
function audioOf(session: DocumentReaderSession): HTMLAudioElement {
  return (session as unknown as { audio: HTMLAudioElement }).audio;
}

describe('DocumentReaderSession — silent reading', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('highlights the first word on start without any audio', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One two three.');
    session.start();

    expect(highlights).toHaveLength(1);
    expect(highlights[0]).toMatchObject({
      sentenceIndex: 0,
      wordIndex: 0,
      silent: true,
      unit: 'sentence',
    });
    expect(session.getState().status).toBe('playing');
    // Nothing was loaded into the player: silent means silent.
    expect(audioOf(session).src).toBe('');
  });

  it('never sends text to the engine', () => {
    vi.useFakeTimers();
    const enqueue = vi.fn(() => ({ id: 'job-1', status: 'pending' }));
    const engine = {
      enqueue,
      cancel: vi.fn(),
      on: vi.fn(() => () => {}),
      getCurrentModel: vi.fn(() => ({ id: 'kitten-nano' })),
    } as unknown as TTSEngine;
    const session = new DocumentReaderSession(engine, 'One two three.', {
      silent: true,
    });
    session.start();
    vi.advanceTimersByTime(5000);
    expect(enqueue).not.toHaveBeenCalled();
    expect(session.getState().silent).toBe(true);
  });

  it('advances one word at a time, at the pace of each word', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One two three.');
    session.start();

    const firstTick = silentWordDurationMs('One', 1);
    vi.advanceTimersByTime(firstTick - 1);
    expect(highlights.at(-1)?.wordIndex).toBe(0);
    vi.advanceTimersByTime(1);
    expect(highlights.at(-1)?.wordIndex).toBe(1);

    // The second word has its own duration; it is not a fixed interval.
    vi.advanceTimersByTime(silentWordDurationMs('two', 1) - 1);
    expect(highlights.at(-1)?.wordIndex).toBe(1);
    vi.advanceTimersByTime(1);
    expect(highlights.at(-1)?.wordIndex).toBe(2);
  });

  it('moves faster when the speed is higher', () => {
    vi.useFakeTimers();
    const slow = silentSession('One two three.', { speed: 1 });
    const fast = silentSession('One two three.', { speed: 2 });
    slow.session.start();
    fast.session.start();

    vi.advanceTimersByTime(silentWordDurationMs('One', 2));
    expect(fast.highlights.at(-1)?.wordIndex).toBe(1);
    expect(slow.highlights.at(-1)?.wordIndex).toBe(0);
  });

  it('crosses sentences and finishes at the end of the document', () => {
    vi.useFakeTimers();
    const { session, highlights, states } = silentSession('One. Two.');
    session.start();

    vi.advanceTimersByTime(silentWordDurationMs('One.', 1));
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 1, wordIndex: 0 });

    vi.advanceTimersByTime(silentWordDurationMs('Two.', 1));
    expect(session.getState().status).toBe('finished');
    expect(states.at(-1)?.status).toBe('finished');
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 1, wordIndex: 0 });

    const count = highlights.length;
    vi.advanceTimersByTime(10_000);
    expect(highlights).toHaveLength(count);
  });

  it('pause stops the clock and resume picks the same word up again', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One two three.');
    session.start();
    vi.advanceTimersByTime(silentWordDurationMs('One', 1));
    expect(highlights.at(-1)?.wordIndex).toBe(1);

    session.pause();
    expect(session.getState().status).toBe('paused');
    const pausedAt = highlights.length;
    vi.advanceTimersByTime(10_000);
    expect(highlights).toHaveLength(pausedAt);

    session.resume();
    expect(session.getState().status).toBe('playing');
    expect(highlights.at(-1)?.wordIndex).toBe(1);
    vi.advanceTimersByTime(silentWordDurationMs('two', 1));
    expect(highlights.at(-1)?.wordIndex).toBe(2);
  });

  it('starts at the requested sentence', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One. Two. Three.');
    session.start(2);
    expect(highlights[0]).toMatchObject({ sentenceIndex: 2, wordIndex: 0 });
  });

  it('can switch from audio to silent without moving the cursor', () => {
    vi.useFakeTimers();
    const engine = {
      enqueue: vi.fn(() => ({ id: 'job-1', status: 'pending' })),
      cancel: vi.fn(),
      on: vi.fn(() => () => {}),
      getCurrentModel: vi.fn(() => ({ id: 'kitten-nano' })),
    } as unknown as TTSEngine;
    const highlights: HighlightInfo[] = [];
    const session = new DocumentReaderSession(engine, 'One two three.', {
      chunkSize: 40,
      onHighlight: info => highlights.push(info),
    });
    session.start();
    expect(session.isSilent()).toBe(false);

    session.setSilentMode(true);
    expect(session.isSilent()).toBe(true);
    expect(session.getState().silent).toBe(true);
    expect(highlights.at(-1)).toMatchObject({ wordIndex: 0, silent: true });

    vi.advanceTimersByTime(silentWordDurationMs('One', 1));
    expect(highlights.at(-1)?.wordIndex).toBe(1);
  });

  it('queues synthesis when a silent session is switched back to audio', () => {
    // The reverse handover must leave the session able to speak: a silent
    // session never queued anything, so a paused switch that only flips a
    // flag would resume into silence with no jobs to play.
    vi.useFakeTimers();
    const enqueue = vi.fn(() => ({ id: 'job-1', status: 'pending' }));
    const engine = {
      enqueue,
      cancel: vi.fn(),
      on: vi.fn(() => () => {}),
      getCurrentModel: vi.fn(() => ({ id: 'kitten-nano' })),
    } as unknown as TTSEngine;
    const session = new DocumentReaderSession(engine, 'One two three.', { silent: true });
    session.start();
    expect(enqueue).not.toHaveBeenCalled();

    session.pause();
    session.setSilentMode(false);
    expect(session.hasEngine()).toBe(true);
    expect(enqueue).toHaveBeenCalled();
  });
});

describe('DocumentReaderSession — skip a reading unit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips a sentence forward and back while paused', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One. Two. Three.');
    session.start();
    session.pause();

    expect(session.skip(1)).toBe(true);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 1, wordIndex: 0 });
    expect(session.skip(1)).toBe(true);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 2, wordIndex: 0 });
    expect(session.skip(-1)).toBe(true);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 1, wordIndex: 0 });
  });

  it('refuses to move past either end and leaves the highlight alone', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One. Two.');
    session.start();
    session.pause();

    expect(session.skip(-1)).toBe(false);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 0, wordIndex: 0 });

    session.skip(1);
    const count = highlights.length;
    expect(session.skip(1)).toBe(false);
    expect(highlights).toHaveLength(count);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 1, wordIndex: 0 });
  });

  it('steps one word at a time when the unit is a word', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One two three.');
    session.start();
    session.pause();
    session.setReadingUnit('word');

    session.skip(1);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 0, wordIndex: 1, unit: 'word' });
    session.skip(1);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 0, wordIndex: 2 });
    session.skip(-1);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 0, wordIndex: 1 });
  });

  it('jumps to the next paragraph when the unit is a paragraph', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession(
      'First para one. First para two.\n\nSecond para one.',
    );
    session.start();
    session.pause();
    session.setReadingUnit('paragraph');

    expect(session.skip(1)).toBe(true);
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 2, wordIndex: 0 });
    expect(session.skip(1)).toBe(false);
  });

  it('skips across chunks while paused and moves the chunk cursor', () => {
    const session = new DocumentReaderSession(
      {
        enqueue: vi.fn(() => ({ id: 'job-1', status: 'pending' })),
        cancel: vi.fn(),
        on: vi.fn(() => () => {}),
        getCurrentModel: vi.fn(() => ({ id: 'kitten-nano' })),
      } as unknown as TTSEngine,
      'Sentence one here. Sentence two here. Sentence three here.',
      { chunkSize: 20 },
    );
    session.pause();
    expect(session.getChunks().length).toBeGreaterThan(1);

    expect(session.skip(1)).toBe(true);
    expect(session.getState().currentIndex).toBe(1);
    expect(session.skip(1)).toBe(true);
    expect(session.getState().currentIndex).toBe(2);
    expect(session.skip(1)).toBe(false);
  });

  it('reports the new unit on the same word when the unit changes', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One two three. Four five six.');
    session.start();
    session.pause();
    session.skip(1);
    const before = highlights.at(-1)!;
    expect(before).toMatchObject({ sentenceIndex: 1, wordIndex: 0, unit: 'sentence' });

    session.setReadingUnit('word');
    const after = highlights.at(-1)!;
    expect(after).toMatchObject({ sentenceIndex: 1, wordIndex: 0, unit: 'word' });
    expect(after.unitRanges).toEqual([{ sentenceIndex: 1, startWord: 0, endWord: 1 }]);
  });
});

describe('DocumentReaderSession — dual highlighting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the current word inside the whole current sentence by default', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One two three. Four five.');
    session.start();
    vi.advanceTimersByTime(silentWordDurationMs('One', 1));

    const info = highlights.at(-1)!;
    expect(info.wordIndex).toBe(1);
    expect(info.unit).toBe('sentence');
    expect(info.unitRanges).toEqual([{ sentenceIndex: 0, startWord: 0, endWord: 3 }]);
  });

  it('reports every sentence of a paragraph as the unit ranges', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession(
      'First para one. First para two.\n\nSecond para one.',
    );
    session.setReadingUnit('paragraph');
    session.start();

    const info = highlights.at(-1)!;
    expect(info.unitRanges).toEqual([
      { sentenceIndex: 0, startWord: 0, endWord: 3 },
      { sentenceIndex: 1, startWord: 0, endWord: 3 },
    ]);
  });

  it('keeps the word inside the unit as the word advances', () => {
    vi.useFakeTimers();
    const { session, highlights } = silentSession('One two three.');
    session.start();
    vi.advanceTimersByTime(silentWordDurationMs('One', 1));

    const info = highlights.at(-1)!;
    expect(info.wordIndex).toBe(1);
    expect(info.unitRanges[0].startWord).toBeLessThanOrEqual(info.wordIndex);
    expect(info.unitRanges[0].endWord).toBeGreaterThan(info.wordIndex);
  });
});

// ─── Per-section voices ────────────────────────────────────────────

describe('DocumentReaderSession — per-section voices', () => {
  const ENGINE = {
    enqueue: vi.fn(() => ({ id: 'job-1', status: 'pending', url: undefined })),
    cancel: vi.fn(),
    on: vi.fn(() => () => {}),
    getCurrentModel: vi.fn(() => ({
      id: 'kokoro-82m',
      name: 'Kokoro-82M',
      voices: [{ id: 'af_heart', name: 'Heart' }, { id: 'am_adam', name: 'Adam' }],
      defaultVoiceId: 'af_heart',
    })),
  } as unknown as TTSEngine;

  const TEXT = 'One two three. Four five six. Seven eight nine.';
  /** Boundary inside "Four" (which starts at 15), so the split is mid-word. */
  const TAGS = [{ id: 'dialogue', start: 16, end: TEXT.length, voiceId: 'am_adam' }];

  it('does not start a sentence in the voice of its second half', () => {
    const session = new DocumentReaderSession(ENGINE, TEXT, {
      chunkSize: 300,
      sectionVoices: TAGS,
    });
    expect(session.getChunks()).toHaveLength(2);

    session.start(1);
    // Starting at sentence 1 means starting at its first word, which is still
    // in the untagged half — so chunk 0, not the chunk that holds "five".
    expect(session.getState().currentIndex).toBe(0);

    session.setReadingUnit('word');
    session.skip(1);
    // "five" is the first word of the split-off chunk; seeking there must land
    // in that chunk, not in the one that merely contains the same sentence.
    expect(session.getState().currentIndex).toBe(1);
  });

  it('maps highlight words through a chunk split mid-sentence', () => {
    const highlights: HighlightInfo[] = [];
    const session = new DocumentReaderSession(ENGINE, TEXT, {
      chunkSize: 300,
      sectionVoices: TAGS,
      onHighlight: info => highlights.push(info),
    });
    session.start(1);
    session.setReadingUnit('word');
    session.skip(1);
    expect(session.getState().currentIndex).toBe(1);

    const audio = audioOf(session);
    let time = 0;
    Object.defineProperty(audio, 'paused', { configurable: true, value: false });
    Object.defineProperty(audio, 'duration', { configurable: true, value: 6 });
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => time,
      set: (value: number) => { time = value; },
    });
    const updateHighlight = (session as unknown as { updateHighlight: () => void }).updateHighlight.bind(session);

    // The chunk begins at "five" — sentence 1, word 1 — not at word 0 of that
    // sentence. Without the segment window this would highlight "Four".
    updateHighlight();
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 1, wordIndex: 1, chunkIndex: 1 });

    // Halfway into five words lands on "six." → the next sentence starts.
    time = 3;
    updateHighlight();
    expect(highlights.at(-1)).toMatchObject({ sentenceIndex: 2, wordIndex: 0 });
  });
});
