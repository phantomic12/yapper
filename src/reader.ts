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
  private onDone?: (job: GenerationJob) => void;
  private onUpdate?: (job: GenerationJob) => void;
  private highlightRaf?: number;

  constructor(engine: TTSEngine, fullText: string, options: ReaderOptions = {}) {
    this.engine = engine;
    this.options = {
      chunkSize: options.chunkSize ?? 300,
      lookahead: options.lookahead ?? 2,
      speed: options.speed ?? 1,
      ...options,
    };
    this.sessionId = `read-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const { sentences, chunks } = prepareReaderData(fullText.trim(), this.options.chunkSize);
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
    this.audio.addEventListener('ended', () => this.advance());
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

  private setState(partial: Partial<ReaderState>) {
    this.state = { ...this.state, ...partial };
    this.options.onStateChange?.({ ...this.state });
  }

  /** Start playback. Returns immediately; synthesis happens in the background. */
  start() {
    if (this.chunks.length === 0) {
      this.setState({ status: 'finished' });
      return;
    }
    this.cancelHighlightLoop();
    this.subscribe();
    this.setState({ isPlaying: true, status: 'playing', currentIndex: 0, bufferedIndex: -1 });
    this.ensureBuffered(Math.min(this.options.lookahead! - 1, this.chunks.length - 1));
    this.tryPlayNext();
    this.scheduleHighlightLoop();
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
    this.setState({ isPlaying: true, status: 'playing' });
    this.ensureBuffered(Math.min(this.state.currentIndex + this.options.lookahead! - 1, this.chunks.length - 1));
    this.tryPlayNext();
    this.scheduleHighlightLoop();
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
    const parent = this.engine as any;
    this.onDone = (job: GenerationJob) => this.handleJobDone(job);
    this.onUpdate = (job: GenerationJob) => this.handleJobUpdate(job);
    parent.events = parent.events ?? {};
    parent.events.onJobDone = this.chain(parent.events.onJobDone, this.onDone);
    parent.events.onJobUpdate = this.chain(parent.events.onJobUpdate, this.onUpdate);
  }

  private unsubscribe() {
    const parent = this.engine as any;
    if (!parent.events) return;
    if (parent.events.onJobDone === this.onDone) parent.events.onJobDone = undefined;
    if (parent.events.onJobUpdate === this.onUpdate) parent.events.onJobUpdate = undefined;
  }

  private chain<T>(existing: ((x: T) => void) | undefined, next: (x: T) => void): (x: T) => void {
    return (x: T) => {
      existing?.(x);
      next(x);
    };
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
      this.setState({ error: `Playback failed: ${err.message}`, status: 'paused', isPlaying: false });
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

  private handleAudioError(e: Event) {
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

    const ratio = Math.min(1, Math.max(0, this.audio.currentTime / this.audio.duration));
    const targetWord = Math.min(Math.floor(ratio * totalWords), totalWords - 1);

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

// ─── Text segmentation helpers ─────────────────────────────────────

export interface PreparedReaderData {
  sentences: ReaderSentence[];
  chunks: ReaderChunk[];
}

/** Splits raw text into sentences and reading-order chunks. */
export function prepareReaderData(text: string, maxChars: number = 300): PreparedReaderData {
  const sentences = segmentSentences(text);
  const chunks = buildChunks(sentences, maxChars);
  return { sentences, chunks };
}

function segmentSentences(text: string): ReaderSentence[] {
  const paragraphs = text.split(/\n\s*\n/);
  let globalIndex = 0;
  const sentences: ReaderSentence[] = [];

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const raw = paragraphs[paragraphIndex].trim();
    if (!raw) continue;

    // Split after sentence-ending punctuation (including common CJK marks).
    const parts = raw.split(/(?<=[.!?。！？…]+(?:['"”’)]?)\s*)/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const words = trimmed.match(/\S+/g) ?? [trimmed];
      sentences.push({ text: trimmed, words, globalIndex, paragraphIndex });
      globalIndex++;
    }
  }

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
