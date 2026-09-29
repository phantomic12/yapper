/**
 * Instant read-aloud through the browser's speech synthesis.
 *
 * The model-based reader (reader.ts) is the high-quality path but needs a
 * loaded model; this is the "press play, hear it now" path. One utterance
 * per sentence is deliberate: `onSentence` then fires exactly when the
 * spoken word crosses into that sentence, which is what drives the
 * follow-along highlight, and a per-sentence utterance is the only reliable
 * boundary signal across browsers (`onboundary` is inconsistent and silent
 * in several engines).
 */

export type ReadAloudState = 'idle' | 'playing' | 'paused';

export interface ReadAloudCallbacks {
  /** Fired before each sentence starts, with its index into the list. */
  onSentence?: (index: number) => void;
  /**
   * Fired when the engine crosses into a word, where the browser reports it.
   * `charIndex` is relative to the sentence's text (chunks rejoin with single
   * spaces), so a consumer can walk the sentence's words directly. Engines
   * without boundary events simply never fire this.
   */
  onWord?: (sentenceIndex: number, charIndex: number) => void;
  onStateChange?: (state: ReadAloudState) => void;
  onError?: (message: string) => void;
  /** Fired when the last sentence finishes naturally. */
  onEnd?: () => void;
}

export interface SpeakOptions {
  rate?: number;
  /** BCP-47 language tag hint, e.g. 'en-US'. */
  lang?: string;
}

/**
 * Split text for speech at word boundaries under `maxChars`.
 *
 * Some engines silently drop the tail of very long utterances (Chrome's
 * ~15s cutoff is the famous one), so long sentences are broken up while
 * still being reported as one sentence to the highlight.
 */
export function chunkForSpeech(text: string, maxChars = 200): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const chunks: string[] = [];
  let current = '';
  for (const word of clean.split(/\s+/)) {
    if (current && current.length + 1 + word.length > maxChars) {
      chunks.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

interface SpeechUtteranceLike {
  text: string;
  lang?: string;
  rate?: number;
  onend?: (() => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onboundary?: ((event: unknown) => void) | null;
}

interface SpeechSynthesisLike {
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
}

/** True where the browser offers speech synthesis at all. */
export function readAloudSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as Partial<Window> & { speechSynthesis?: unknown }).speechSynthesis === 'object'
    && typeof (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'function';
}

export class ReadAloudController {
  private sentences: Array<{ text: string }> = [];
  private index = 0;
  private token = 0;
  private state: ReadAloudState = 'idle';
  private options: SpeakOptions = {};
  private callbacks: ReadAloudCallbacks = {};

  constructor(callbacks: ReadAloudCallbacks = {}) {
    this.callbacks = callbacks;
  }

  getState(): ReadAloudState {
    return this.state;
  }

  getCurrentIndex(): number {
    return this.index;
  }

  /**
   * Start speaking `sentences` from `fromIndex`, cancelling any current
   * speech. The token guards against a cancelled utterance's late `onend`
   * advancing a new session's index.
   */
  speak(sentences: Array<{ text: string }>, fromIndex = 0, options: SpeakOptions = {}): void {
    const synth = this.synthesis();
    if (!synth) {
      this.callbacks.onError?.('This browser does not support speech synthesis.');
      return;
    }
    if (!sentences.length) return;
    this.stop();
    this.token++;
    this.sentences = sentences;
    this.index = Math.max(0, Math.min(sentences.length - 1, fromIndex));
    this.options = options;
    this.setState('playing');
    this.speakCurrent(synth);
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.synthesis()?.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.synthesis()?.resume();
    this.setState('playing');
  }

  stop(): void {
    this.token++;
    this.synthesis()?.cancel();
    this.index = 0;
    if (this.state !== 'idle') this.setState('idle');
  }

  /** Change the rate for the current and following sentences. */
  setRate(rate: number): void {
    this.options.rate = rate;
  }

  getRate(): number {
    return this.options.rate ?? 1;
  }

  private synthesis(): SpeechSynthesisLike | null {
    if (!readAloudSupported()) return null;
    return (window as Window & { speechSynthesis: SpeechSynthesisLike }).speechSynthesis;
  }

  private setState(next: ReadAloudState): void {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private speakCurrent(synth: SpeechSynthesisLike): void {
    const token = this.token;
    const sentence = this.sentences[this.index];
    if (!sentence) {
      this.setState('idle');
      this.callbacks.onEnd?.();
      return;
    }
    this.callbacks.onSentence?.(this.index);
    const chunks = chunkForSpeech(sentence.text);
    // Chunks rejoin with single spaces, so a chunk's offset in the sentence
    // is just the sum of the earlier chunks plus their spaces.
    const chunkBases = chunks.map((_, i) =>
      chunks.slice(0, i).reduce((total, part) => total + part.length + 1, 0));
    const speakChunk = (chunkIndex: number): void => {
      if (token !== this.token) return;
      const text = chunks[chunkIndex];
      if (text === undefined) {
        this.index++;
        this.speakCurrent(synth);
        return;
      }
      const utterance = new (globalThis as unknown as {
        SpeechSynthesisUtterance: new (text: string) => SpeechUtteranceLike;
      }).SpeechSynthesisUtterance(text);
      if (this.options.rate !== undefined) utterance.rate = this.options.rate;
      if (this.options.lang) utterance.lang = this.options.lang;
      utterance.onend = () => speakChunk(chunkIndex + 1);
      utterance.onboundary = event => {
        if (token !== this.token) return;
        const charIndex = (event as { charIndex?: number } | undefined)?.charIndex;
        if (typeof charIndex !== 'number') return;
        this.callbacks.onWord?.(this.index, chunkBases[chunkIndex] + charIndex);
      };
      utterance.onerror = () => {
        if (token !== this.token) return;
        // A failed utterance must not stall the chain silently.
        this.callbacks.onError?.('Speech playback failed for one sentence.');
        speakChunk(chunkIndex + 1);
      };
      synth.speak(utterance);
    };
    speakChunk(0);
  }
}
