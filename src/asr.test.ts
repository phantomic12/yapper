import { describe, expect, it } from 'vitest';
import {
  ASR_SAMPLE_RATE,
  WHISPER_TINY_EN,
  WHISPER_TINY_MULTI,
  concat,
  conflate,
  downmix,
  insertAtCaret,
  isSilent,
  looksLikeSpeech,
  normalizeTranscript,
  peakLevel,
  pickAsrModel,
  resample,
  splitForWhisper,
  trimSilence,
} from './asr';

function ramp(length: number, step = 1): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i * step;
  return out;
}

describe('downmix', () => {
  it('returns a single channel untouched', () => {
    const mono = new Float32Array([0.1, -0.2, 0.3]);
    expect(downmix([mono])).toBe(mono);
  });

  it('averages stereo channels sample by sample', () => {
    const left = new Float32Array([1, 0, -1, 0.5]);
    const right = new Float32Array([0, 1, 1, -0.5]);
    expect(Array.from(downmix([left, right]))).toEqual([0.5, 0.5, 0, 0]);
  });

  it('truncates to the shortest channel rather than reading past it', () => {
    const long = new Float32Array([1, 1, 1, 1]);
    const short = new Float32Array([0, 0]);
    expect(downmix([long, short])).toHaveLength(2);
  });

  it('handles no channels', () => {
    expect(downmix([])).toHaveLength(0);
  });
});

describe('resample', () => {
  it('is a no-op at the same rate', () => {
    const samples = ramp(10);
    expect(resample(samples, 16000, 16000)).toBe(samples);
  });

  it('decimates 48k to 16k at one third the length', () => {
    const samples = ramp(4800);
    const out = resample(samples, 48000, 16000);
    expect(out).toHaveLength(1600);
  });

  it('preserves a constant signal exactly — the box filter has unity gain', () => {
    const samples = new Float32Array(4800).fill(0.25);
    const out = resample(samples, 48000, 16000);
    for (const value of out) expect(value).toBeCloseTo(0.25, 6);
  });

  it('averages a full cycle of a high-frequency signal toward zero', () => {
    // Alternating +1/-1 at 48k is 24k, far above the 8k Nyquist of the
    // 16k output. A correct anti-alias filter must not let it survive as
    // a loud tone; averaging over the 3-sample window does that.
    const samples = new Float32Array(4800);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 1 : -1;
    const out = resample(samples, 48000, 16000);
    const peak = peakLevel(out);
    expect(peak).toBeLessThan(0.4);
  });

  it('interpolates upward to the requested length', () => {
    const out = resample(new Float32Array([0, 1, 0, -1]), 8000, 16000);
    expect(out).toHaveLength(8);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
  });

  it('survives nonsense rates and empty input', () => {
    expect(resample(new Float32Array(4), 0, 16000)).toHaveLength(0);
    expect(resample(new Float32Array(0), 48000, 16000)).toHaveLength(0);
  });
});

describe('concat', () => {
  it('joins fragments in order', () => {
    const out = concat([new Float32Array([1, 2]), new Float32Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('handles an empty list', () => {
    expect(concat([])).toHaveLength(0);
  });
});

describe('levels', () => {
  it('reports the peak absolute amplitude', () => {
    expect(peakLevel(new Float32Array([0.1, -0.7, 0.2]))).toBeCloseTo(0.7);
  });

  it('treats a quiet recording as silent', () => {
    expect(isSilent(new Float32Array(100).fill(0.001))).toBe(true);
    expect(isSilent(new Float32Array(100).fill(0.2))).toBe(false);
  });
});

describe('looksLikeSpeech', () => {
  const rate = 16000;

  function steadyTone(seconds: number, amplitude = 0.3): Float32Array {
    const out = new Float32Array(rate * seconds);
    for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / rate);
    return out;
  }

  function syllabic(seconds: number): Float32Array {
    // Loudness that rises and falls a few times a second — what speech
    // looks like from the outside.
    const out = new Float32Array(rate * seconds);
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
      out[i] = envelope * 0.4 * Math.sin((2 * Math.PI * 220 * i) / rate);
    }
    return out;
  }

  it('rejects a steady tone, which Whisper transcribes as words', () => {
    expect(looksLikeSpeech(steadyTone(2), rate)).toBe(false);
  });

  it('rejects a constant-amplitude noise floor', () => {
    const noise = new Float32Array(rate * 2).fill(0.1);
    expect(looksLikeSpeech(noise, rate)).toBe(false);
  });

  it('accepts syllable-shaped audio', () => {
    expect(looksLikeSpeech(syllabic(2), rate)).toBe(true);
  });

  it('accepts speech recorded over a constant background hum', () => {
    const speech = syllabic(2);
    const hum = steadyTone(2, 0.05);
    for (let i = 0; i < speech.length; i++) speech[i] += hum[i];
    expect(looksLikeSpeech(speech, rate)).toBe(true);
  });

  it('gives very short clips the benefit of the doubt', () => {
    expect(looksLikeSpeech(new Float32Array(40), rate)).toBe(true);
  });

  it('rejects empty input', () => {
    expect(looksLikeSpeech(new Float32Array(0), rate)).toBe(false);
  });
});

describe('trimSilence', () => {
  it('removes leading and trailing quiet, keeping the spoken middle', () => {
    const samples = new Float32Array(1000);
    for (let i = 400; i < 600; i++) samples[i] = 0.5;
    const out = trimSilence(samples, 16000, 0.01, 0);
    expect(out.length).toBe(200);
    expect(out[0]).toBeCloseTo(0.5);
  });

  it('keeps the requested padding', () => {
    const samples = new Float32Array(1000);
    for (let i = 400; i < 600; i++) samples[i] = 0.5;
    // 10 ms at 16 kHz = 160 samples of margin on each side.
    const out = trimSilence(samples, 16000, 0.01, 10);
    expect(out.length).toBe(200 + 320);
  });

  it('returns nothing when the whole recording is silent', () => {
    expect(trimSilence(new Float32Array(500), 16000)).toHaveLength(0);
  });

  it('handles empty input', () => {
    expect(trimSilence(new Float32Array(0), 16000)).toHaveLength(0);
  });
});

describe('splitForWhisper', () => {
  it('leaves a short utterance whole', () => {
    const parts = splitForWhisper(new Float32Array(1000), ASR_SAMPLE_RATE);
    expect(parts).toHaveLength(1);
  });

  it('splits anything past the 30 second window', () => {
    const samples = new Float32Array(ASR_SAMPLE_RATE * 75);
    const parts = splitForWhisper(samples, ASR_SAMPLE_RATE);
    expect(parts).toHaveLength(3);
    expect(parts[0].length).toBe(ASR_SAMPLE_RATE * 30);
    expect(parts[2].length).toBe(ASR_SAMPLE_RATE * 15);
  });

  it('returns nothing for an empty recording', () => {
    expect(splitForWhisper(new Float32Array(0), ASR_SAMPLE_RATE)).toHaveLength(0);
  });
});

describe('normalizeTranscript', () => {
  it('drops the non-speech labels Whisper emits into silence', () => {
    expect(normalizeTranscript('[BLANK_AUDIO]')).toBe('');
    expect(normalizeTranscript('  (silence)  ')).toBe('');
    expect(normalizeTranscript('[MUSIC] hello [Applause]')).toBe('hello');
  });

  it('collapses whitespace and trims', () => {
    expect(normalizeTranscript('  hello \n\n  world  ')).toBe('hello world');
  });

  it('leaves real speech alone', () => {
    expect(normalizeTranscript('The cat sat.')).toBe('The cat sat.');
  });
});

describe('conflate', () => {
  it('joins window transcripts with single spaces', () => {
    expect(conflate([' the cat ', 'sat down'])).toBe('the cat sat down');
  });

  it('drops empty windows', () => {
    expect(conflate(['hello', '', '  ', 'world'])).toBe('hello world');
  });

  it('returns nothing when every window was empty', () => {
    expect(conflate(['', '  '])).toBe('');
  });
});

describe('insertAtCaret', () => {
  it('adds padding spaces when inserting between words', () => {
    const result = insertAtCaret('helloworld', 'there', 5);
    expect(result.text).toBe('hello there world');
    expect(result.caret).toBe(12);
  });

  it('does not double up existing spaces', () => {
    const result = insertAtCaret('hello world', 'there', 6);
    expect(result.text).toBe('hello there world');
  });

  it('appends cleanly at the end', () => {
    expect(insertAtCaret('hello', 'world', 5).text).toBe('hello world');
  });

  it('does not add a trailing space before punctuation', () => {
    expect(insertAtCaret('hello world', 'there.', 5).text).toBe('hello there. world');
  });

  it('ignores an empty or whitespace-only transcript', () => {
    expect(insertAtCaret('hello', '   ', 2)).toEqual({ text: 'hello', caret: 2 });
  });

  it('clamps a caret outside the text', () => {
    expect(insertAtCaret('hello', 'world', 99).text).toBe('hello world');
    expect(insertAtCaret('hello', 'world', -5).text).toBe('world hello');
  });
});

describe('pickAsrModel', () => {
  it('uses the English model for English and unknown languages', () => {
    expect(pickAsrModel('en')).toBe(WHISPER_TINY_EN);
    expect(pickAsrModel('en-GB')).toBe(WHISPER_TINY_EN);
    expect(pickAsrModel(undefined)).toBe(WHISPER_TINY_EN);
    expect(pickAsrModel('all')).toBe(WHISPER_TINY_EN);
  });

  it('falls back to multilingual for anything else', () => {
    expect(pickAsrModel('es')).toBe(WHISPER_TINY_MULTI);
    expect(pickAsrModel('ko')).toBe(WHISPER_TINY_MULTI);
  });
});
