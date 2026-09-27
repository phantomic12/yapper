import { describe, it, expect, beforeEach } from 'vitest';
import { paintSpeakingLine } from './stream-player';
import { buildAppMarkup } from './layout';
import { splitAtWord } from '../karaoke';
import type { ReaderSentence } from '../reader';

function sentence(text: string): ReaderSentence {
  return { text, words: text.match(/\S+/g) ?? [], globalIndex: 0, paragraphIndex: 0 };
}

describe('paintSpeakingLine', () => {
  let speakingEl: HTMLElement;

  beforeEach(() => {
    // Render the real markup so the element under test is the one the app
    // binds to, not a hand-rolled stand-in.
    const root = document.createElement('div');
    root.innerHTML = buildAppMarkup({ capability: 'none', selectedModelId: 'kitten-nano' });
    speakingEl = root.querySelector<HTMLElement>('#stream-speaking')!;
  });

  it('marks the spoken word and preserves the surrounding text', () => {
    const s = sentence('the quick brown fox jumps');
    paintSpeakingLine(speakingEl, splitAtWord(s, 2));
    const mark = speakingEl.querySelector('mark')!;
    expect(mark.textContent).toBe('brown');
    expect(speakingEl.textContent).toBe('“the quick brown fox jumps”');
  });

  it('uses the class the stylesheet styles', () => {
    paintSpeakingLine(speakingEl, splitAtWord(sentence('hello there'), 0));
    const mark = speakingEl.querySelector('mark')!;
    expect(mark.className).toBe('stream-bar__word');
  });

  it('keeps quotes around the sentence and never leaves the line blank', () => {
    const s = sentence('one two three');
    for (let i = 0; i < s.words.length; i++) {
      paintSpeakingLine(speakingEl, splitAtWord(s, i));
      expect(speakingEl.textContent!.startsWith('“')).toBe(true);
      expect(speakingEl.textContent!.endsWith('”')).toBe(true);
      expect(speakingEl.textContent).not.toBe('“”');
    }
  });

  it('shows the whole sentence unmarked when the word is out of range', () => {
    const s = sentence('no words here');
    paintSpeakingLine(speakingEl, splitAtWord(s, 42));
    expect(speakingEl.querySelector('mark')).toBeNull();
    expect(speakingEl.textContent).toBe('“no words here”');
  });

  it('empties the line when the session ends', () => {
    paintSpeakingLine(speakingEl, splitAtWord(sentence('goodbye'), 0));
    paintSpeakingLine(speakingEl, null);
    expect(speakingEl.textContent).toBe('');
    expect(speakingEl.childNodes.length).toBe(0);
  });
});
