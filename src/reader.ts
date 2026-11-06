import type { GenerationJob, TTSEngine } from './engine';
import { applyPronunciations, toWrittenWordIndex, type PronunciationEntry } from './pronunciation';
import {
  buildReadingUnits,
  nextReadingUnitIndex,
  readingUnitAt,
  silentWordDurationMs,
  type ReadingUnit,
  type ReadingUnitSpan,
  type UnitRange,
} from './reading-units';

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
  /**
   * spoken-word index → written-word index, present only when a
   * pronunciation rule fired for this chunk. Highlighting translates
   * through it so the page lights up the word the reader is hearing.
   */
  wordMap?: number[] | null;
}

export interface ReaderState {
  isPlaying: boolean;
  currentIndex: number;
  totalChunks: number;
  /** Highest chunk index that is ready to play (or already playing). */
  bufferedIndex: number;
  status: 'idle' | 'playing' | 'paused' | 'finished';
  /**
   * True while the highlight is driven by the silent clock rather than by
   * audio. The UI says so in the status line, because "paused" and "reading
   * silently" look identical otherwise — a moving highlight with no sound.
   */
  silent: boolean;
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
  /** The reading unit that was active when this highlight was produced. */
  unit: ReadingUnit;
  /**
   * The ranges the active reading unit covers. A paragraph unit spans
   * several sentences, so this is a list rather than one box — the UI paints
   * every range and the document view draws its trail from the first word of
   * the first range to the last word of the last.
   */
  unitRanges: UnitRange[];
  /** True when a silent clock produced this, not audio playback. */
  silent: boolean;
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
   * Start silent: advance the highlight on a text-derived clock without
   * synthesising or playing anything. Silent sessions need no engine at all.
   */
  silent?: boolean;
  /** How much text one highlight covers and one skip moves over. */
  readingUnit?: ReadingUnit;
  /** Approximate characters per display line for the 'line' unit. */
  lineChars?: number;
  /**
   * Character ranges of the text that must be spoken as one sentence —
   * table rows, so a period inside a cell cannot split the row.
   */
  atomicRanges?: ReadonlyArray<readonly [number, number]>;
  /**
   * Say-as overrides applied to the text handed to the engine. The page
   * keeps showing what the author wrote; only the voice hears the
   * substitution. See `pronunciation.ts`.
   */
  pronunciations?: readonly PronunciationEntry[];
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
  /** Null for a silent session: nothing is synthesised, so nothing is queued. */
  private engine: TTSEngine | null;
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
  /** Where the reading cursor is, in document coordinates. */
  private position: { sentenceIndex: number; wordIndex: number } = { sentenceIndex: 0, wordIndex: 0 };
  /** The active unit list, rebuilt when the unit choice changes. */
  private units: ReadingUnitSpan[] = [];
  private readingUnit: ReadingUnit;
  private silent: boolean;
  /** Silent-mode pacing timer. A timeout, not a frame loop: a word lasts
   *  hundreds of milliseconds, and a timeout keeps ticking in a background
   *  tab where requestAnimationFrame is throttled to near-zero. */
  private silentTimer?: ReturnType<typeof setTimeout>;
  /**
   * A word to seek to once the current chunk's metadata is available.
   *
   * Skip can land inside a chunk whose audio has not loaded yet, where
   * `duration` is NaN and `currentTime` cannot be set meaningfully. Holding
   * the target here lets the same seek run from `loadedmetadata` instead of
   * being silently dropped.
   */
  private pendingSeekWord: number | null = null;

  constructor(engine: TTSEngine | null, fullText: string, options: ReaderOptions = {}) {
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
    this.silent = options.silent ?? false;
    this.readingUnit = options.readingUnit ?? 'sentence';
    this.units = buildReadingUnits(this.allSentences, this.readingUnit, this.options.lineChars);
    this.position = {
      sentenceIndex: this.allSentences[0]?.globalIndex ?? 0,
      wordIndex: 0,
    };
    this.state = {
      isPlaying: false,
      currentIndex: 0,
      totalChunks: this.chunks.length,
      bufferedIndex: -1,
      status: 'idle',
      silent: this.silent,
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

  getReadingUnit(): ReadingUnit {
    return this.readingUnit;
  }

  isSilent(): boolean {
    return this.silent;
  }

  /** Whether this session has an engine to speak with if silent mode ends. */
  hasEngine(): boolean {
    return this.engine !== null;
  }

  /**
   * Change how much text a highlight covers and how far skip moves.
   *
   * The current position is the anchor: switching from sentence to word must
   * keep the reader on the word being spoken, not restart the paragraph, so
   * the cursor is re-resolved against the new unit list and re-emitted
   * instead of being reset.
   */
  setReadingUnit(unit: ReadingUnit): void {
    if (unit === this.readingUnit) return;
    this.readingUnit = unit;
    this.units = buildReadingUnits(this.allSentences, unit, this.options.lineChars);
    this.emitPosition();
  }

  /**
   * Turn silent reading on or off mid-session.
   *
   * Handing over happens at the current word: silent-to-audio starts playback
   * from the chunk already loaded, and audio-to-silent pauses the element
   * before the clock takes over. The cursor does not move because the user
   * changed the *medium*, not the place in the document.
   */
  setSilentMode(on: boolean): void {
    if (on === this.silent) return;
    this.silent = on;
    this.setState({ silent: on });
    if (on) {
      if (this.state.status === 'playing') {
        this.audio.pause();
        this.cancelHighlightLoop();
        this.scheduleSilentTick();
      }
    } else {
      this.cancelSilentTimer();
      // Park the word the silent cursor reached so audio resumes there
      // rather than at the top of a chunk the eye is already past.
      this.pendingSeekWord = this.writtenWordIndexInChunk(
        this.chunks[this.state.currentIndex],
        this.position.sentenceIndex,
        this.position.wordIndex,
      );
      // A session that started silent never queued anything. Queueing is not
      // gated on "playing" because the handover may happen while paused, and
      // resuming then needs jobs already in flight.
      this.subscribe();
      this.ensureBuffered(
        Math.min(this.state.currentIndex + this.options.lookahead! - 1, this.chunks.length - 1),
      );
      if (this.state.status === 'playing') {
        this.scheduleHighlightLoop();
        this.tryPlayNext();
      }
    }
    this.emitPosition();
  }

  /**
   * Move one reading unit forward or back. Returns false at the document's
   * ends, where the cursor stays put rather than wrapping to the other end.
   *
   * Skipping while paused is a read-position change, so the highlight moves
   * immediately; skipping while playing also moves the audio, seeking inside
   * the current chunk and changing chunks when the target lies elsewhere.
   */
  skip(direction: 1 | -1): boolean {
    if (!this.units.length) return false;
    const current = readingUnitAt(this.units, this.position.sentenceIndex, this.position.wordIndex);
    const next = nextReadingUnitIndex(this.units, current, direction);
    if (next < 0 || next === current) return false;
    const target = this.units[next];
    const first = target.ranges[0];
    if (!first) return false;
    this.moveTo(first.sentenceIndex, first.startWord);
    return true;
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
   *
   * A silent session skips synthesis entirely: it positions the cursor,
   * emits one highlight and starts the pacing clock. No engine is touched, so
   * silent reading works with no model loaded and makes no audio at all.
   */
  start(fromSentenceIndex = 0) {
    if (this.chunks.length === 0) {
      this.setState({ status: 'finished' });
      return;
    }
    this.cancelHighlightLoop();
    this.cancelSilentTimer();
    const from = this.chunkIndexForSentence(fromSentenceIndex);
    const sentence = this.sentenceFor(fromSentenceIndex) ?? this.allSentences[0];
    this.position = { sentenceIndex: sentence?.globalIndex ?? 0, wordIndex: 0 };
    this.setState({
      isPlaying: true,
      status: 'playing',
      currentIndex: from,
      bufferedIndex: -1,
      silent: this.silent,
    });
    if (this.silent) {
      this.emitPosition();
      this.scheduleSilentTick();
      return;
    }
    this.primeAudioForAutoplay();
    this.subscribe();
    this.ensureBuffered(Math.min(from + this.options.lookahead! - 1, this.chunks.length - 1));
    this.tryPlayNext();
    this.scheduleHighlightLoop();
  }

  private sentenceFor(globalIndex: number): ReaderSentence | undefined {
    return this.allSentences.find(s => s.globalIndex === globalIndex);
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
    this.cancelSilentTimer();
    this.setState({ isPlaying: false, status: 'paused' });
  }

  /** Resume from the current chunk. */
  resume() {
    if (this.state.status === 'finished') return;
    this.setState({ isPlaying: true, status: 'playing', needsUserGesture: undefined });
    if (this.silent) {
      this.emitPosition();
      this.scheduleSilentTick();
      return;
    }
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
    if (!this.silent) this.primeAudioForAutoplay();
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
    this.pendingSeekWord = null;
    // Cancel any pending reader jobs that haven't generated yet. A silent
    // session never queued any.
    if (this.engine) {
      for (const chunk of this.chunks) {
        if (chunk.job && (chunk.job.status === 'pending' || chunk.job.status === 'generating')) {
          this.engine.cancel(chunk.job.id);
        }
      }
    }
    this.setState({ currentIndex: 0, bufferedIndex: -1, status: 'idle' });
  }

  private subscribe() {
    if (!this.engine) return;
    // One subscription per session: start() after a stop, or a silent-to-audio
    // handover, must not stack a second listener that would advance the
    // reader twice per finished job.
    if (this.unsubscribes.length) return;
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

  /**
   * Swap the say-as rules. Already-queued chunks keep the text they were
   * synthesized with; everything not yet sent to the engine uses the new
   * set. Used by the pronunciation editor when rules are saved mid-read.
   */
  setPronunciations(entries: readonly PronunciationEntry[]): void {
    this.options = { ...this.options, pronunciations: entries };
  }

  /** Queue synthesis for chunks [0 .. targetIndex] that don't have a job yet. */
  private ensureBuffered(targetIndex: number) {
    if (!this.engine) return;
    const modelId = this.engine.getCurrentModel()?.id ?? '';
    const pronunciations = this.options.pronunciations ?? [];
    for (let i = 0; i <= targetIndex && i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (chunk.job) continue;
      // Rewrite for the voice only. `chunk.text` stays the written text so
      // nothing on screen shifts; `wordMap` lets the highlight loop find its
      // way back to the written word.
      const spoken = applyPronunciations(chunk.text, pronunciations);
      chunk.wordMap = spoken.wordMap;
      chunk.job = this.engine.enqueue(spoken.text, {
        modelId,
        readerSessionId: this.sessionId,
        readerIndex: chunk.index,
        speed: this.options.speed ?? 1,
      });
    }
  }

  private tryPlayNext() {
    // A silent session has no clips to play; its clock is the only driver.
    if (this.silent) return;
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
    // A skip may have parked a word for this chunk while its audio was
    // still loading. Seeking here — after play() so the media pipeline
    // exists — lands on the skipped word instead of the chunk's first one.
    this.applyPendingSeek();
    this.updateHighlight();
  }

  private advance() {
    // The clip that just ended is behind us; a seek parked for it must not
    // be applied to the next chunk.
    this.pendingSeekWord = null;
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

  /**
   * Report where the cursor is, with the reading unit it sits in.
   *
   * Every highlight path funnels through here — audio ticks, the silent
   * clock, skip and unit changes — so the "current word" and the "current
   * unit" can never disagree about which step of the document is active.
   */
  private emitPosition(): void {
    const unitIndex = readingUnitAt(this.units, this.position.sentenceIndex, this.position.wordIndex);
    const unit = unitIndex >= 0 ? this.units[unitIndex] : null;
    this.options.onHighlight?.({
      sentenceIndex: this.position.sentenceIndex,
      wordIndex: this.position.wordIndex,
      chunkIndex: this.chunkIndexForSentence(this.position.sentenceIndex),
      unit: this.readingUnit,
      unitRanges: unit
        ? unit.ranges.map(range => ({ ...range }))
        : [{
          sentenceIndex: this.position.sentenceIndex,
          startWord: this.position.wordIndex,
          endWord: this.position.wordIndex + 1,
        }],
      silent: this.silent,
    });
  }

  /**
   * Move the cursor and bring the audio along when there is any.
   *
   * The chunk decides how the move happens. Inside a chunk the clip is
   * already loaded, so a seek lands exactly; across chunks the old clip
   * belongs to different audio and is paused, and the new chunk starts when
   * its job is ready. The seek is parked rather than dropped because
   * `duration` is unknown until that clip loads.
   */
  private moveTo(sentenceIndex: number, wordIndex: number): void {
    const previousChunk = this.state.currentIndex;
    const chunkIndex = this.chunkIndexForSentence(sentenceIndex);
    this.position = { sentenceIndex, wordIndex };
    if (chunkIndex !== previousChunk) {
      this.setState({ currentIndex: chunkIndex });
      if (!this.silent) {
        this.audio.pause();
        this.ensureBuffered(Math.min(chunkIndex + this.options.lookahead! - 1, this.chunks.length - 1));
      }
    }
    if (this.silent) {
      if (this.state.status === 'playing') this.scheduleSilentTick();
    } else {
      this.pendingSeekWord = this.writtenWordIndexInChunk(this.chunks[chunkIndex], sentenceIndex, wordIndex);
      if (this.state.status === 'playing') this.tryPlayNext();
      this.applyPendingSeek();
    }
    this.emitPosition();
  }

  /** The chunk-relative written-word index of a position, or null off-chunk. */
  private writtenWordIndexInChunk(
    chunk: ReaderChunk | undefined,
    sentenceIndex: number,
    wordIndex: number,
  ): number | null {
    if (!chunk) return null;
    let offset = 0;
    for (const sentence of chunk.sentences) {
      if (sentence.globalIndex === sentenceIndex) {
        return wordIndex >= 0 && wordIndex < sentence.words.length ? offset + wordIndex : null;
      }
      offset += sentence.words.length;
    }
    return null;
  }

  /**
   * Seek the current clip to the parked word.
   *
   * Word timings are used when the engine supplied them; otherwise the word's
   * share of the chunk duration is the best available estimate. A chunk with
   * no readable duration yet keeps the target parked until `loadedmetadata`
   * fires, or discards it when the target stopped making sense.
   */
  private applyPendingSeek(): void {
    if (this.pendingSeekWord === null) return;
    const current = this.chunks[this.state.currentIndex];
    if (!current?.job?.url || this.audio.src !== current.job.url) {
      // The element is not pointing at this chunk's clip yet. Leave the
      // target parked: tryPlayNext() sets the URL and calls this again, and
      // seeking the previous clip's duration would be meaningless audio.
      return;
    }
    const word = this.pendingSeekWord;
    const apply = () => {
      const chunk = this.chunks[this.state.currentIndex];
      const time = chunk ? this.timeForWord(chunk, word) : null;
      if (time === null) return;
      this.pendingSeekWord = null;
      try {
        this.audio.currentTime = time;
      } catch {
        // The element reset between the check and the write; the highlight
        // already moved, and the next loaded clip will start from its word.
      }
      this.updateHighlight();
    };
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
      apply();
    } else {
      // Duration is unknown until metadata arrives. Register the same seek
      // for that moment instead of dropping it: a skip into a chunk that is
      // still loading would otherwise land on the chunk's first word.
      this.audio.addEventListener('loadedmetadata', () => {
        if (this.pendingSeekWord !== null) apply();
      }, { once: true });
    }
  }

  /** Seconds into a chunk at which a written word starts. */
  private timeForWord(chunk: ReaderChunk, writtenWordIndex: number): number | null {
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const totalWritten = chunk.sentences.reduce((sum, s) => sum + s.words.length, 0);
    if (totalWritten <= 0) return null;
    const timings = chunk.job?.wordTimings;
    const totalSpoken = chunk.wordMap?.length ?? totalWritten;
    if (timings && timings.length >= totalSpoken) {
      // Timings index the spoken words. With a pronunciation rewrite the
      // written word the user skipped to may sit at a different spoken
      // index, so translate through the map before indexing. When the map
      // has no entry, the ratio estimate below is safer than word zero.
      let spoken = writtenWordIndex;
      if (chunk.wordMap) {
        const mapped = chunk.wordMap.indexOf(writtenWordIndex);
        if (mapped >= 0) spoken = mapped;
      }
      const timing = timings[Math.min(spoken, timings.length - 1)];
      if (timing !== undefined) return timing;
    }
    return (writtenWordIndex / totalWritten) * duration;
  }

  private scheduleSilentTick(): void {
    this.cancelSilentTimer();
    if (!this.silent || this.state.status !== 'playing') return;
    const word = this.sentenceFor(this.position.sentenceIndex)?.words[this.position.wordIndex] ?? '';
    this.silentTimer = setTimeout(
      () => this.silentTick(),
      silentWordDurationMs(word, this.options.speed ?? 1),
    );
  }

  private cancelSilentTimer(): void {
    if (this.silentTimer !== undefined) {
      clearTimeout(this.silentTimer);
      this.silentTimer = undefined;
    }
  }

  private silentTick(): void {
    this.silentTimer = undefined;
    if (!this.silent || this.state.status !== 'playing') return;
    if (!this.advanceSilent()) {
      this.setState({ isPlaying: false, status: 'finished' });
      return;
    }
    this.emitPosition();
    this.scheduleSilentTick();
  }

  /**
   * One word forward on the silent clock. False at the end of the document.
   *
   * Chunk boundaries are honoured even though nothing is playing: the state's
   * `currentIndex` is what the status line and the export path read, so a
   * silent read that crossed ten chunks must still say so.
   */
  private advanceSilent(): boolean {
    const sentence = this.sentenceFor(this.position.sentenceIndex);
    if (!sentence) return false;
    if (this.position.wordIndex + 1 < sentence.words.length) {
      this.position = { sentenceIndex: sentence.globalIndex, wordIndex: this.position.wordIndex + 1 };
      return true;
    }
    const next = this.allSentences.find(s => s.globalIndex > sentence.globalIndex);
    if (!next) return false;
    this.position = { sentenceIndex: next.globalIndex, wordIndex: 0 };
    const chunkIndex = this.chunkIndexForSentence(next.globalIndex);
    if (chunkIndex !== this.state.currentIndex) this.setState({ currentIndex: chunkIndex });
    return true;
  }

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
    if (this.silent) return;
    if (this.audio.paused || !this.audio.duration || !Number.isFinite(this.audio.duration)) return;
    if (this.state.currentIndex >= this.chunks.length) return;

    const chunk = this.chunks[this.state.currentIndex];
    if (!chunk.sentences.length) return;

    const totalWords = chunk.sentences.reduce((sum, s) => sum + s.words.length, 0);
    if (totalWords === 0) return;

    // When a pronunciation rule rewrote this chunk, the engine's timings
    // describe the spoken words, not the written ones. Search the spoken
    // sequence, then map the hit back to the word that is actually on the
    // page. Without a map this is the identity and costs nothing.
    const spokenWords = chunk.wordMap?.length ?? totalWords;
    const spokenIndex = pickHighlightedWord(
      spokenWords,
      this.audio.currentTime,
      this.audio.duration,
      chunk.job?.wordTimings,
    );
    const targetWord = chunk.wordMap ? toWrittenWordIndex(spokenIndex, chunk.wordMap) : spokenIndex;

    let remaining = targetWord;
    for (const sentence of chunk.sentences) {
      if (remaining < sentence.words.length) {
        this.position = { sentenceIndex: sentence.globalIndex, wordIndex: remaining };
        this.emitPosition();
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
