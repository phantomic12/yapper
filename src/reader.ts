import type { GenerationJob, TTSEngine } from './engine';

export interface ReaderSentence {
  /** Clean sentence text. */
  text: string;
  /** Word tokens (whitespace-separated). */
  words: string[];
  /** Index across the whole document. */
  globalIndex: number;
  /** Which paragraph this sentence belongs to. */
  paragraphIndex: number;
  /**
   * Character offsets into the document text this sentence was segmented from.
   *
   * These are what let the document view draw the read-aloud highlight over
   * the real page: a sentence is located in the document by where its text
   * sits, and that is meaningless without a character range. Absent means the
   * sentence could not be located (a document with no geometry), and callers
   * must degrade to highlighting nothing rather than highlighting page one.
   */
  start?: number;
  end?: number;
}

export interface ReaderChunk {
  /** Text sent to the TTS engine. */
  text: string;
  /** Chunk order. */
  index: number;
  /** Sentences that make up this chunk, in order. */
  sentences: ReaderSentence[];
  /** Assigned generation job once queued. */
  job?: GenerationJob;
}

export interface ReaderState {
  isPlaying: boolean;
  currentIndex: number;
  totalChunks: number;
  /** Highest chunk index that is ready to play (or already playing). */
  bufferedIndex: number;
  status: 'idle' | 'playing' | 'paused' | 'finished';
  error?: string;
  /**
   * Set to true when the browser refused to autoplay because no user
   * gesture was present. The UI surfaces a "Click to play" button and
   * the next user click on the document triggers `play()` again.
   */
  needsUserGesture?: boolean;
}

export interface HighlightInfo {
  sentenceIndex: number;
  wordIndex: number;
  chunkIndex: number;
}

export interface ReaderOptions {
  /** Approximate maximum characters per TTS chunk. Smaller chunks start faster
   *  and are easier on slower machines. Default: 300. */
  chunkSize?: number;
  /** How many upcoming chunks to queue for synthesis while reading.
   *  Lower = less memory/work, higher = more buffer. Default: 2. */
  lookahead?: number;
  /** Playback speed passed to the engine. */
  speed?: number;
  /**
   * Character ranges of the text that must be spoken as one sentence —
   * table rows, so a period inside a cell cannot split the row.
   */
  atomicRanges?: ReadonlyArray<readonly [number, number]>;
  /** Called whenever the reader state changes. */
  onStateChange?: (state: ReaderState) => void;
  /** Called continuously while audio plays with the current sentence/word. */
  onHighlight?: (info: HighlightInfo) => void;
}

/**
 * Reads a long document aloud by chunking it into sentences, queueing chunks
 * through the TTS engine, and auto-advancing a hidden `<audio>` player as
 * chunks finish. Only a small lookahead of chunks is synthesized at a time,
 * so playback starts as soon as the first chunk is ready and weak machines are
 * not overwhelmed.
 */
export class DocumentReaderSession {
  private engine: TTSEngine;
  private sessionId: string;
  private chunks: ReaderChunk[] = [];
  private allSentences: ReaderSentence[] = [];
  private audio: HTMLAudioElement;
  private state: ReaderState;
  private options: ReaderOptions;
  /** Unsubscribers returned from engine.on(); called on stop()/destroy. */
  private unsubscribes: Array<() => void> = [];
  private highlightRaf?: number;
  /** Set once the audio element has played inside a user gesture (iOS unlock). */
  private audioPrimed = false;

  constructor(engine: TTSEngine, fullText: string, options: ReaderOptions = {}) {
    this.engine = engine;
    this.options = {
      chunkSize: options.chunkSize ?? 300,
      lookahead: options.lookahead ?? 2,
      speed: options.speed ?? 1,
      ...options,
    };
    this.sessionId = `read-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const { sentences, chunks } = prepareReaderData(fullText.trim(), this.options.chunkSize, this.options.atomicRanges);
    this.allSentences = sentences;
    this.chunks = chunks;
    this.state = {
      isPlaying: false,
      currentIndex: 0,
      totalChunks: this.chunks.length,
      bufferedIndex: -1,
      status: 'idle',
    };
    this.audio = new Audio();
    this.audio.addEventListener('ended', () => {
      // Only a finished *chunk* may advance the reader. The silent prime
      // clip (see primeAudioForAutoplay) and anything else that is not the
      // current chunk's URL ends here instead — then we retry tryPlayNext
      // so a prime that was still playing doesn't stall the session.
      const chunk = this.chunks[this.state.currentIndex];
      if (chunk?.job?.url && this.audio.src === chunk.job.url) {
        this.advance();
      } else {
        this.tryPlayNext();
      }
    });
    this.audio.addEventListener('error', (e) => this.handleAudioError(e));
    this.audio.addEventListener('loadedmetadata', () => this.updateHighlight());
  }

  getChunks(): ReaderChunk[] {
    return this.chunks;
  }

  getSentences(): ReaderSentence[] {
    return this.allSentences;
  }

  getState(): ReaderState {
    return { ...this.state };
  }

  /** Identifies this session's jobs, so its clips can be exported together. */
  getSessionId(): string {
    return this.sessionId;
  }

  private setState(partial: Partial<ReaderState>) {
    this.state = { ...this.state, ...partial };
    this.options.onStateChange?.({ ...this.state });
  }

  /**
   * Start playback. Returns immediately; synthesis happens in the background.
   *
   * `fromSentenceIndex` starts at the chunk holding that sentence, which is how
   * clicking a sentence in the document view reads from there. It defaults to
   * the beginning, so existing callers that just want to play are unchanged.
   */
  start(fromSentenceIndex = 0) {
    if (this.chunks.length === 0) {
      this.setState({ status: 'finished' });
      return;
    }
    this.primeAudioForAutoplay();
    this.cancelHighlightLoop();
    this.subscribe();
    const from = this.chunkIndexForSentence(fromSentenceIndex);
    this.setState({ isPlaying: true, status: 'playing', currentIndex: from, bufferedIndex: -1 });
    this.ensureBuffered(Math.min(from + this.options.lookahead! - 1, this.chunks.length - 1));
    this.tryPlayNext();
    this.scheduleHighlightLoop();
  }

  /**
   * The position of the chunk holding a sentence, or 0 if it holds none.
   *
   * Falls back to the start rather than failing: a sentence index that no
   * longer resolves — a document replaced under an old click — should read the
   * document from the top, not refuse to play at all.
   */
  private chunkIndexForSentence(globalIndex: number): number {
    for (const chunk of this.chunks) {
      if (chunk.sentences.some(s => s.globalIndex === globalIndex)) return chunk.index;
    }
    return 0;
  }

  /** Pause playback at the current chunk. */
  pause() {
    this.audio.pause();
    this.cancelHighlightLoop();
    this.setState({ isPlaying: false, status: 'paused' });
  }

  /** Resume from the current chunk. */
  resume() {
    if (this.state.status === 'finished') return;
    this.setState({ isPlaying: true, status: 'playing', needsUserGesture: undefined });
    this.ensureBuffered(Math.min(this.state.currentIndex + this.options.lookahead! - 1, this.chunks.length - 1));
    this.tryPlayNext();
    this.scheduleHighlightLoop();
  }

  /**
   * Resume from a real user-gesture handler (click, keypress).
   *
   * The name is about the *use*, not a precondition: being inside a user
   * gesture only means the resulting `audio.play()` is allowed, so this
   * resumes whether or not autoplay was ever blocked. Gating on
   * `needsUserGesture` (as this used to) made the Resume button dead after
   * an ordinary Pause — the label said Resume, the click did nothing, and
   * Stop was the only way out. If autoplay *is* blocked again, the play()
   * rejection path sets needsUserGesture and the buttons relabel.
   */
  resumeAfterGesture() {
    if (this.state.status === 'playing') return;
    this.primeAudioForAutoplay();
    this.resume();
  }

  /**
   * Unlock the audio element for gesture-free playback (iOS Safari).
   *
   * iOS only permits a media element to play() outside a user gesture once
   * that element has already been played *inside* one. Without this, the
   * first chunk — which lands seconds after the Play click, when the
   * gesture has expired — is always rejected with NotAllowedError and the
   * session opens on the "Click to play" CTA instead of just playing.
   *
   * start()/resumeAfterGesture() run inside click handlers, so a throwaway
   * play() of an inaudible clip here marks the element unlocked for every
   * later chunk on the same element. If this call itself isn't in a
   * gesture (a programmatic resume), play() rejects, audioPrimed stays
   * false so the next real gesture retries, and the existing
   * needsUserGesture CTA covers it exactly as before.
   */
  private primeAudioForAutoplay() {
    if (this.audioPrimed) return;
    this.audio.src = READER_PRIME_URL;
    try {
      // jsdom and very old engines return undefined rather than a Promise —
      // treat a synchronous (or missing) resolution as a successful prime.
      const attempt = this.audio.play() as unknown as Promise<void> | undefined;
      if (attempt && typeof attempt.then === 'function') {
        attempt
          .then(() => { this.audioPrimed = true; })
          .catch(() => { /* outside a gesture — the CTA path handles it */ });
      } else {
        this.audioPrimed = true;
      }
    } catch {
      // Synchronous refusal — same story as a rejected promise.
    }
  }

  /** Stop and tear everything down. */
  stop() {
    this.pause();
    this.unsubscribe();
    // Cancel any pending reader jobs that haven't generated yet.
    for (const chunk of this.chunks) {
      if (chunk.job && (chunk.job.status === 'pending' || chunk.job.status === 'generating')) {
        this.engine.cancel(chunk.job.id);
      }
    }
    this.setState({ currentIndex: 0, bufferedIndex: -1, status: 'idle' });
  }

  private subscribe() {
    // Use the typed emitter API instead of monkey-patching engine.events.
    // The returned unsubscribe fn is captured so stop()/destroy can release
    // the listener without affecting other consumers.
    this.unsubscribes.push(
      this.engine.on('jobDone', (job) => this.handleJobDone(job)),
      this.engine.on('jobUpdate', (job) => this.handleJobUpdate(job)),
    );
  }

  private unsubscribe() {
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
  }

  private handleJobUpdate(job: GenerationJob) {
    if (job.readerSessionId !== this.sessionId) return;
    const chunk = this.chunks.find(c => c.index === job.readerIndex);
    if (chunk) chunk.job = job;
    this.updateBufferedIndex();
    this.tryPlayNext();
  }

  private handleJobDone(job: GenerationJob) {
    if (job.readerSessionId !== this.sessionId) return;
    this.updateBufferedIndex();
    this.tryPlayNext();
  }

  private updateBufferedIndex() {
    let i = this.state.bufferedIndex + 1;
    while (
      i < this.chunks.length &&
      this.chunks[i].job?.status === 'done' &&
      this.chunks[i].job?.url
    ) {
      i++;
    }
    this.setState({ bufferedIndex: i - 1 });
  }

  /** Queue synthesis for chunks [0 .. targetIndex] that don't have a job yet. */
  private ensureBuffered(targetIndex: number) {
    const modelId = this.engine.getCurrentModel()?.id ?? '';
    for (let i = 0; i <= targetIndex && i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (chunk.job) continue;
      chunk.job = this.engine.enqueue(chunk.text, {
        modelId,
        readerSessionId: this.sessionId,
        readerIndex: chunk.index,
        speed: this.options.speed ?? 1,
      });
    }
  }

  private tryPlayNext() {
    if (!this.state.isPlaying) return;
    if (!this.audio.paused) return;
    if (this.state.currentIndex >= this.chunks.length) {
      this.setState({ isPlaying: false, status: 'finished' });
      this.cancelHighlightLoop();
      return;
    }
    const chunk = this.chunks[this.state.currentIndex];
    if (!chunk.job || chunk.job.status !== 'done' || !chunk.job.url) return;

    if (this.audio.src !== chunk.job.url) {
      this.audio.src = chunk.job.url;
      this.audio.playbackRate = this.options.speed ?? 1;
    }
    this.audio.play().catch(err => {
      // Browsers throw NotAllowedError when play() is called outside a
      // user-gesture handler. We surface a "Click to play" CTA in that
      // case instead of silently failing. Other errors (decode failure,
      // missing source, etc.) keep the generic message.
      const isGestureRequired = err?.name === 'NotAllowedError';
      this.setState({
        error: isGestureRequired
          ? 'Browser blocked autoplay. Click play to continue.'
          : `Playback failed: ${err.message}`,
        status: 'paused',
        isPlaying: false,
        needsUserGesture: isGestureRequired || undefined,
      });
      this.cancelHighlightLoop();
    });
    this.updateHighlight();
  }

  private advance() {
    // Move to next chunk and try to continue playback.
    this.setState({ currentIndex: this.state.currentIndex + 1 });
    this.ensureBuffered(Math.min(this.state.currentIndex + this.options.lookahead! - 1, this.chunks.length - 1));
    this.tryPlayNext();
  }

  private handleAudioError(_e: Event) {
    this.setState({ error: 'Audio player error', status: 'paused', isPlaying: false });
    this.cancelHighlightLoop();
  }

  // ─── Word/sentence highlighting ────────────────────────────────────

  private scheduleHighlightLoop() {
    this.cancelHighlightLoop();
    this.highlightRaf = requestAnimationFrame(() => this.highlightTick());
  }

  private cancelHighlightLoop() {
    if (this.highlightRaf !== undefined) {
      cancelAnimationFrame(this.highlightRaf);
      this.highlightRaf = undefined;
    }
  }

  private highlightTick() {
    if (this.state.status !== 'playing') return;
    this.updateHighlight();
    this.highlightRaf = requestAnimationFrame(() => this.highlightTick());
  }

  private updateHighlight() {
    if (this.audio.paused || !this.audio.duration || !Number.isFinite(this.audio.duration)) return;
    if (this.state.currentIndex >= this.chunks.length) return;

    const chunk = this.chunks[this.state.currentIndex];
    if (!chunk.sentences.length) return;

    const totalWords = chunk.sentences.reduce((sum, s) => sum + s.words.length, 0);
    if (totalWords === 0) return;

    const targetWord = pickHighlightedWord(
      totalWords,
      this.audio.currentTime,
      this.audio.duration,
      chunk.job?.wordTimings,
    );

    let remaining = targetWord;
    for (const sentence of chunk.sentences) {
      if (remaining < sentence.words.length) {
        this.options.onHighlight?.({
          sentenceIndex: sentence.globalIndex,
          wordIndex: remaining,
          chunkIndex: chunk.index,
        });
        return;
      }
      remaining -= sentence.words.length;
    }
  }
}

// ─── iOS autoplay priming ──────────────────────────────────────────
/** 46-byte PCM16 WAV: RIFF header + 4 zero samples (~0.5 ms). Inaudible. */
const READER_PRIME_URL =
  'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQgAAAAAAAAAAAAAAA==';

// ─── Text segmentation helpers ─────────────────────────────────────

export interface PreparedReaderData {
  sentences: ReaderSentence[];
  chunks: ReaderChunk[];
}

/**
 * Resolve which word should be highlighted given a current time and an
 * optional per-word timing array. Exported so the highlight math can be
 * unit-tested without instantiating an Audio element.
 *
 * @param totalWords       number of whitespace tokens in the chunk
 * @param currentTime      the playing audio's currentTime, in seconds
 * @param chunkDuration    the audio's total duration, in seconds
 * @param wordTimings      optional per-word start times, in seconds. When
 *                         present, the latest word whose start ≤ currentTime
 *                         is highlighted; otherwise the chunk-position ratio
 *                         is used.
 */
export function pickHighlightedWord(
  totalWords: number,
  currentTime: number,
  chunkDuration: number,
  wordTimings?: number[],
): number {
  if (totalWords <= 0) return 0;
  // Treat NaN / Infinity / negative time as "not started yet" — the audio
  // element can report these before metadata loads. Returning 0 keeps the
  // highlight on the first word rather than producing NaN downstream.
  const safeTime = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
  if (wordTimings && wordTimings.length >= totalWords) {
    let lo = 0;
    let hi = totalWords - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (wordTimings[mid] <= safeTime) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }
  const ratio = Math.min(1, Math.max(0, safeTime / Math.max(chunkDuration, 1e-6)));
  return Math.min(Math.floor(ratio * totalWords), totalWords - 1);
}

/** Splits raw text into sentences and reading-order chunks.
 *
 * `atomicRanges` are character ranges of `text` that must stay whole —
 * table rows. Without them a period inside a cell cuts the row it sits in
 * into two reader sentences; the blank line between rows is what separates
 * rows, and nothing inside a row should.
 */
export function prepareReaderData(
  text: string,
  maxChars: number = 300,
  atomicRanges?: ReadonlyArray<readonly [number, number]>,
): PreparedReaderData {
  const sentences = segmentSentences(text, atomicRanges);
  assignOffsets(sentences, text);
  const chunks = buildChunks(sentences, maxChars);
  return { sentences, chunks };
}

/**
 * Give every sentence its character range in the source text.
 *
 * Not threaded through the segmentation itself, which would mean carrying an
 * offset past a `.trim()`, a paragraph split, and the abbreviation-protecting
 * replace/restore dance — four places to be off by one, each producing a
 * highlight on the wrong line and looking like a rendering bug.
 *
 * Instead: scan forward from the last known position. Segmentation emits
 * sentences in document order, so a moving cursor finds the right occurrence
 * even when a sentence's text appears twice in the document, and any
 * transformation the segmenter did to the text is already undone by the time
 * it lands in `sentence.text`.
 */
/**
 * The sentence containing a character offset of the document text.
 *
 * This is what turns a click on the rendered document into a reading position:
 * the document view reports where on the page you clicked as an offset into the
 * extracted text, and this maps it back to the sentence the reader knows how to
 * speak.
 *
 * A linear scan, deliberately. Binary search would need the array to be sorted
 * with no gaps, and `assignOffsets` may leave a sentence's range undefined when
 * its text cannot be located — so the invariant a binary search rests on is one
 * this array does not reliably have. A click happens once per gesture, so the
 * scan is free, and being obviously correct matters more than being clever.
 *
 * Returns null when the offset is not inside any sentence — the blank line
 * between two paragraphs — rather than snapping to a neighbour, because
 * silently reading a sentence the user did not click is worse than doing
 * nothing.
 */
export function sentenceAtOffset(
  sentences: ReaderSentence[],
  offset: number,
): ReaderSentence | null {
  for (const sentence of sentences) {
    if (sentence.start === undefined || sentence.end === undefined) continue;
    if (offset >= sentence.start && offset < sentence.end) return sentence;
  }
  return null;
}

function assignOffsets(sentences: ReaderSentence[], text: string): void {
  let cursor = 0;
  for (const sentence of sentences) {
    const at = text.indexOf(sentence.text, cursor);
    if (at === -1) {
      // Should not happen, but a sentence that cannot be located must not
      // silently claim a range that points at unrelated text.
      sentence.start = undefined;
      sentence.end = undefined;
      continue;
    }
    sentence.start = at;
    sentence.end = at + sentence.text.length;
    cursor = at + sentence.text.length;
  }
}

/** Common English abbreviations and titles that end with a period but
 *  should NOT be treated as sentence terminators. Matching is case-sensitive
 *  on the first letter so we don't accidentally swallow normal words
 *  ("dog." still splits correctly even though "DOG." would not).
 *  Match whole tokens — `Mr` matches `Mr.` but not `Mrs.` is handled by
 *  ordering: longer prefixes first. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'blvd',
  'co', 'corp', 'inc', 'ltd', 'llc', 'plc', 'govt',
  'vs', 'etc', 'eg', 'ie', 'cf', 'al', 'pp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'no', 'vol', 'pp', 'ed', 'eds', 'trans', 'rev',
]);

function isAbbreviation(token: string): boolean {
  return ABBREVIATIONS.has(token.replace(/\.+$/, '').toLowerCase());
}

/** Where one paragraph sits in the source: [start, end), separators excluded. */
interface ParagraphSpan {
  start: number;
  end: number;
}

/**
 * Split the text into paragraphs the way the blank-line rule always has,
 * but keep each one's offsets: atomic ranges are expressed in source
 * coordinates, so a piece has to say where it came from to be matched
 * against them.
 */
function paragraphSpans(text: string): ParagraphSpan[] {
  const spans: ParagraphSpan[] = [];
  const separator = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text))) {
    spans.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  spans.push({ start, end: text.length });
  return spans;
}

/**
 * The atomic range holding each paragraph, or -1.
 *
 * Every extractor emits its ranges in document order, but a sorted copy
 * makes the walk safe against any producer — and lets one pointer per side
 * match them in a single pass, because a spreadsheet can carry ten
 * thousand rows and as many paragraphs to match against.
 */
function atomicOwners(
  spans: ParagraphSpan[],
  atomicRanges?: ReadonlyArray<readonly [number, number]>,
): number[] {
  const owner = new Array<number>(spans.length).fill(-1);
  if (!atomicRanges?.length) return owner;
  const ranges = [...atomicRanges].sort((a, b) => a[0] - b[0]);
  let range = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    // Ranges are disjoint and both sides ascend, so a range that ends
    // before this paragraph starts can never hold a later one either.
    while (range < ranges.length && ranges[range][1] < span.start) range++;
    if (range < ranges.length
      && ranges[range][0] <= span.start
      && span.end <= ranges[range][1]) {
      owner[i] = range;
    }
  }
  return owner;
}

function segmentSentences(
  text: string,
  atomicRanges?: ReadonlyArray<readonly [number, number]>,
): ReaderSentence[] {
  const spans = paragraphSpans(text);
  const owner = atomicOwners(spans, atomicRanges);
  const paragraphs = spans.map(span => text.slice(span.start, span.end));
  let globalIndex = 0;
  const sentences: ReaderSentence[] = [];
  /**
   * The atomic row currently open. A cell can hold a blank line, which
   * makes one row several paragraphs — they still speak as one sentence,
   * so the pieces accumulate here until the row ends.
   */
  let open: { owner: number; start: number; end: number; paragraphIndex: number } | null = null;
  const flushOpen = () => {
    if (!open) return;
    const sentence = text.slice(open.start, open.end).trim();
    const words = sentence.match(/\S+/g) ?? [sentence];
    sentences.push({ text: sentence, words, globalIndex, paragraphIndex: open.paragraphIndex });
    globalIndex++;
    open = null;
  };

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const raw = paragraphs[paragraphIndex].trim();
    if (owner[paragraphIndex] !== -1) {
      // A marked paragraph speaks whole: the punctuation inside a table row
      // is the row's own business, not a sentence boundary.
      if (open && open.owner === owner[paragraphIndex]) {
        if (raw) open.end = spans[paragraphIndex].end;
        continue;
      }
      flushOpen();
      if (raw) {
        open = {
          owner: owner[paragraphIndex],
          start: spans[paragraphIndex].start,
          end: spans[paragraphIndex].end,
          paragraphIndex,
        };
      }
      continue;
    }
    flushOpen();
    if (!raw) continue;

    // Split on sentence-ending punctuation followed by a capital letter /
    // CJK char / opening quote / end-of-paragraph. We exclude periods that
    // follow a known abbreviation token (Mr., Dr., etc.) by pre-passing with
    // a placeholder.
    const PROTECTED = '\u0001';
    let protectedText = raw;
    // A period between digits is a decimal point, not a terminator —
    // "3.5" would otherwise split into "3." and "5", chopping one number
    // across two reader sentences ("Version 3." / "5 is out."). Same
    // placeholder, same restore as the abbreviation guard below.
    protectedText = protectedText.replace(/(?<=\d)\.(?=\d)/g, PROTECTED);
    // Protect abbreviations like "Mr." / "U.S." by replacing their dot with
    // a placeholder, then restoring it after splitting. The lookahead must
    // include digits (dates: "Jan. 5, 2024"), CJK chars (mixed-script text),
    // and opening quotes (dialogue).
    protectedText = protectedText.replace(
      /\b([A-Za-z]+)\.(?=\s+(?:[A-Z0-9]|[一-鿿]|[぀-ヿ]|[가-힯]|['"‘“]))/g,
      (match, word: string) => {
        if (isAbbreviation(word)) return `${word}${PROTECTED}`;
        return match;
      },
    );

    const parts = protectedText.split(/(?<=[.!?。！？…]+(?:['"”’)]?)\s*)/);
    for (const part of parts) {
      const restored = part.replace(new RegExp(PROTECTED, 'g'), '.').trim();
      if (!restored) continue;
      const words = restored.match(/\S+/g) ?? [restored];
      sentences.push({ text: restored, words, globalIndex, paragraphIndex });
      globalIndex++;
    }
  }
  flushOpen();

  // Fallback: if no sentences were produced, treat the whole text as one sentence.
  if (sentences.length === 0 && text.trim()) {
    const t = text.trim();
    sentences.push({ text: t, words: t.match(/\S+/g) ?? [t], globalIndex: 0, paragraphIndex: 0 });
  }

  return sentences;
}

function buildChunks(sentences: ReaderSentence[], maxChars: number): ReaderChunk[] {
  const chunks: ReaderChunk[] = [];
  let buffered: ReaderSentence[] = [];
  let bufferedLength = 0;

  const flush = () => {
    if (!buffered.length) return;
    chunks.push({
      text: buffered.map(s => s.text).join(' '),
      index: chunks.length,
      sentences: [...buffered],
    });
    buffered = [];
    bufferedLength = 0;
  };

  for (const sentence of sentences) {
    const extra = buffered.length ? 1 + sentence.text.length : sentence.text.length;
    if (bufferedLength + extra <= maxChars) {
      buffered.push(sentence);
      bufferedLength += extra;
    } else if (sentence.text.length > maxChars) {
      // Single sentence is too long for a chunk. Flush what we have, then
      // keep the long sentence as its own oversized chunk so we don't clip words.
      flush();
      chunks.push({
        text: sentence.text,
        index: chunks.length,
        sentences: [sentence],
      });
    } else {
      flush();
      buffered = [sentence];
      bufferedLength = sentence.text.length;
    }
  }
  flush();
  return chunks;
}
