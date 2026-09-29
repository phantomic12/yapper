import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkForSpeech, ReadAloudController, readAloudSupported } from './read-aloud';

/** Minimal controllable speech-synthesis double. */
interface FakeUtterance {
  text: string;
  lang?: string;
  rate?: number;
  onend?: (() => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onboundary?: ((event: unknown) => void) | null;
}

function installFakeSpeech() {
  const spoken: FakeUtterance[] = [];
  const calls: string[] = [];
  const synth = {
    speak(u: FakeUtterance) {
      spoken.push(u);
      calls.push('speak');
    },
    cancel() { calls.push('cancel'); },
    pause() { calls.push('pause'); },
    resume() { calls.push('resume'); },
  };
  class FakeUtteranceImpl implements FakeUtterance {
    constructor(public text: string) {}
  }
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtteranceImpl);
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  return { spoken, calls };
}

describe('chunkForSpeech', () => {
  it('splits long text at word boundaries', () => {
    const chunks = chunkForSpeech('one two three four five', 9);
    expect(chunks).toEqual(['one two', 'three', 'four five']);
  });

  it('returns short text whole and ignores empties', () => {
    expect(chunkForSpeech('hello world', 100)).toEqual(['hello world']);
    expect(chunkForSpeech('   ', 100)).toEqual([]);
  });
});

describe('ReadAloudController', () => {
  beforeEach(() => installFakeSpeech());
  afterEach(() => {
    vi.unstubAllGlobals();
    // jsdom keeps speechSynthesis once defined; remove for later files.
    delete (window as Partial<Window> & { speechSynthesis?: unknown }).speechSynthesis;
  });

  it('reports support when the API exists', () => {
    expect(readAloudSupported()).toBe(true);
  });

  it('speaks sentence by sentence, following along', () => {
    const { spoken } = installFakeSpeech();
    const seen: number[] = [];
    const states: string[] = [];
    const controller = new ReadAloudController({
      onSentence: index => seen.push(index),
      onStateChange: state => states.push(state),
    });
    controller.speak([{ text: 'One.' }, { text: 'Two.' }], 0);
    expect(seen).toEqual([0]);
    expect(spoken[0].text).toBe('One.');

    // Finish the first sentence; the chain advances to the second.
    spoken[0].onend?.();
    expect(seen).toEqual([0, 1]);
    expect(spoken[1].text).toBe('Two.');

    // Finish the second; playback ends idle.
    spoken[1].onend?.();
    expect(states).toEqual(['playing', 'idle']);
    expect(controller.getState()).toBe('idle');
  });

  it('honours rate and start index', () => {
    const { spoken } = installFakeSpeech();
    const controller = new ReadAloudController();
    controller.speak([{ text: 'a' }, { text: 'b' }, { text: 'c' }], 2, { rate: 1.5, lang: 'en-US' });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('c');
    expect(spoken[0].rate).toBe(1.5);
    expect(spoken[0].lang).toBe('en-US');
  });

  it('pause/resume/stop drive the synthesis', () => {
    const { calls, spoken } = installFakeSpeech();
    const controller = new ReadAloudController();
    controller.speak([{ text: 'long sentence here' }]);
    controller.pause();
    controller.resume();
    controller.stop();
    // speak() cancels anything queued first, so the chain starts with cancel.
    expect(calls).toEqual(['cancel', 'speak', 'pause', 'resume', 'cancel']);
    // A late onend from the cancelled utterance must not advance anything.
    spoken[0].onend?.();
    expect(controller.getState()).toBe('idle');
  });

  it('reports word boundaries as sentence-relative character offsets', () => {
    const { spoken } = installFakeSpeech();
    const seen: Array<[number, number]> = [];
    const controller = new ReadAloudController({
      onWord: (sentenceIndex, charIndex) => seen.push([sentenceIndex, charIndex]),
    });
    const text = 'alpha '.repeat(60).trim();
    controller.speak([{ text }], 0);
    const chunks = chunkForSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);

    spoken[0].onboundary?.({ charIndex: 3 });
    expect(seen).toEqual([[0, 3]]);

    // The second chunk's offsets continue the sentence, spaces included.
    spoken[0].onend?.();
    spoken[1].onboundary?.({ charIndex: 0 });
    expect(seen[1]).toEqual([0, chunks[0].length + 1]);

    // Events without a charIndex (some engines' sentence events) are ignored.
    spoken[1].onboundary?.({ name: 'sentence' });
    expect(seen).toHaveLength(2);
  });

  it('continues past an errored utterance', () => {
    const { spoken } = installFakeSpeech();
    const errors: string[] = [];
    const controller = new ReadAloudController({ onError: message => errors.push(message) });
    controller.speak([{ text: 'first' }, { text: 'second' }]);
    spoken[0].onerror?.(new Error('boom'));
    expect(errors).toHaveLength(1);
    expect(spoken[1].text).toBe('second');
  });
});
