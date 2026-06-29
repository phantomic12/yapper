import type { GenerationJob, TTSEngine } from './engine';

export interface ReaderOptions {
  /** Approximate maximum characters per TTS chunk. */
  chunkSize?: number;
  /** Playback speed passed to the engine. */
  speed?: number;
  /** Called whenever the reader state changes. */
  onStateChange?: (state: ReaderState) => void;
}

export interface ReaderState {
  isPlaying: boolean;
  currentIndex: number;
  totalChunks: number;
  status: 'idle' | 'playing' | 'paused' | 'finished';
  error?: string;
}

export interface ReaderChunk {
  text: string;
  index: number;
  job?: GenerationJob;
}

/**
 * Reads a long document aloud by chunking it, queueing each chunk through the
 * TTS engine, and auto-advancing a hidden `<audio>` player as chunks finish.
 *
 * The queue is sequential, so chunks finish in order. If the user pauses,
 * already-generated audio is kept but auto-advance stops.
 */
export class DocumentReaderSession {
  private engine: TTSEngine;
  private sessionId: string;
  private chunks: ReaderChunk[] = [];
  private audio: HTMLAudioElement;
  private state: ReaderState;
  private options: ReaderOptions;
  private onDone?: (job: GenerationJob) => void;
  private onUpdate?: (job: GenerationJob) => void;

  constructor(engine: TTSEngine, fullText: string, options: ReaderOptions = {}) {
    this.engine = engine;
    this.options = options;
    this.sessionId = `read-${crypto.randomUUID()}`;
    this.chunks = splitIntoChunks(fullText.trim(), options.chunkSize ?? 700).map((text, index) => ({
      text,
      index,
    }));
    this.state = {
      isPlaying: false,
      currentIndex: 0,
      totalChunks: this.chunks.length,
      status: 'idle',
    };
    this.audio = new Audio();
    this.audio.addEventListener('ended', () => this.advance());
    this.audio.addEventListener('error', (e) => this.handleAudioError(e));
  }

  getState(): ReaderState {
    return { ...this.state };
  }

  /** Start playback. Returns immediately; synthesis happens in the background. */
  start() {
    if (this.chunks.length === 0) {
      this.setState({ status: 'finished' });
      return;
    }
    this.setState({ isPlaying: true, status: 'playing' });
    this.subscribe();
    const modelId = this.engine.getCurrentModel()?.id ?? '';
    for (const chunk of this.chunks) {
      const job = this.engine.enqueue(chunk.text, {
        modelId,
        readerSessionId: this.sessionId,
        readerIndex: chunk.index,
        speed: this.options.speed ?? 1.0,
      });
      chunk.job = job;
    }
    // The first chunk may already be done by the time we enqueue all of them.
    this.tryPlayNext();
  }

  /** Pause playback at the current chunk. */
  pause() {
    this.audio.pause();
    this.setState({ isPlaying: false, status: 'paused' });
  }

  /** Resume from the current chunk. */
  resume() {
    if (this.state.status === 'finished') return;
    this.setState({ isPlaying: true, status: 'playing' });
    this.tryPlayNext();
  }

  /** Stop and tear everything down. */
  stop() {
    this.pause();
    this.setState({ currentIndex: 0, status: 'idle' });
    this.unsubscribe();
    // Cancel any pending reader jobs that haven't generated yet.
    for (const chunk of this.chunks) {
      if (chunk.job && (chunk.job.status === 'pending' || chunk.job.status === 'generating')) {
        this.engine.cancel(chunk.job.id);
      }
    }
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
    this.tryPlayNext();
  }

  private handleJobDone(job: GenerationJob) {
    if (job.readerSessionId !== this.sessionId) return;
    this.tryPlayNext();
  }

  private tryPlayNext() {
    if (!this.state.isPlaying) return;
    if (!this.audio.paused) return; // Already playing
    if (this.state.currentIndex >= this.chunks.length) {
      this.setState({ isPlaying: false, status: 'finished' });
      return;
    }
    const chunk = this.chunks[this.state.currentIndex];
    if (!chunk.job || chunk.job.status !== 'done' || !chunk.job.url) return;
    this.audio.src = chunk.job.url;
    this.audio.playbackRate = chunk.job.speed;
    this.audio.play().catch(err => {
      this.setState({ error: `Playback failed: ${err.message}`, status: 'paused', isPlaying: false });
    });
  }

  private advance() {
    this.setState({ currentIndex: this.state.currentIndex + 1 });
    this.tryPlayNext();
  }

  private handleAudioError(e: Event) {
    this.setState({ error: 'Audio player error', status: 'paused', isPlaying: false });
  }

  private setState(partial: Partial<ReaderState>) {
    this.state = { ...this.state, ...partial };
    this.options.onStateChange?.({ ...this.state });
  }
}

/**
 * Split text into reasonably-sized TTS chunks at sentence/line boundaries.
 * Keeps chunks under `maxChars` while preferring paragraph breaks, then
 * sentence terminators, then spaces.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxChars) {
      chunks.push(trimmed);
      continue;
    }
    // Split by sentence-like boundaries, then reassemble until maxChars.
    const sentences = trimmed.split(/(?<=[.!?。！？]+["']?\s+)/);
    let current = '';
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!s) continue;
      if ((current + ' ' + s).length <= maxChars) {
        current = current ? `${current} ${s}` : s;
      } else {
        if (current) chunks.push(current);
        if (s.length > maxChars) {
          // Fallback: hard break at word boundaries.
          const words = s.split(/\s+/);
          let wordBuf = '';
          for (const w of words) {
            if ((wordBuf + ' ' + w).length <= maxChars) {
              wordBuf = wordBuf ? `${wordBuf} ${w}` : w;
            } else {
              if (wordBuf) chunks.push(wordBuf);
              wordBuf = w;
            }
          }
          if (wordBuf) chunks.push(wordBuf);
          current = '';
        } else {
          current = s;
        }
      }
    }
    if (current) chunks.push(current);
  }

  return chunks.length ? chunks : [text.trim()];
}
