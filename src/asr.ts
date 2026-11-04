// ─── Dictation: speech to text, on device ────────────────────────
// The counterpart to the reader. Instead of turning text into speech it
// turns speech into text, so a reader who finds writing slow can talk
// into the box and edit afterwards.
//
// Model: Whisper Tiny via Transformers.js. The q8 build is 41 MB
// (encoder 10.1 + decoder 30.7), which is small enough to download on a
// school laptop without a conversation about bandwidth. Multilingual
// Whisper Tiny is the same size and is picked automatically when the
// document language is not English.
//
// Everything in this file is pure: no DOM, no AudioContext, no model.
// The browser plumbing lives in `engines/whisper-asr.ts` and
// `ui/dictation.ts`, which is what makes the awkward parts — resampling,
// trimming, transcript cleanup, caret insertion — testable.

/** Whisper is trained at 16 kHz mono. Everything here converges on that. */
export const ASR_SAMPLE_RATE = 16_000;

/** Whisper's own window. Longer audio is chunked by the pipeline, not by us. */
export const ASR_MAX_UTTERANCE_SECONDS = 30;

export interface AsrModelSpec {
  /** Hugging Face repo id. */
  id: string;
  label: string;
  /** What it can transcribe, for the UI. */
  languages: string;
  /** Quantised download size, MB. Encoder + decoder. */
  downloadMb: number;
  multilingual: boolean;
}

export const WHISPER_TINY_EN: AsrModelSpec = {
  id: 'onnx-community/whisper-tiny.en',
  label: 'Whisper Tiny — English',
  languages: 'English',
  downloadMb: 41,
  multilingual: false,
};

export const WHISPER_TINY_MULTI: AsrModelSpec = {
  id: 'onnx-community/whisper-tiny',
  label: 'Whisper Tiny — multilingual',
  languages: '99 languages',
  downloadMb: 41,
  multilingual: true,
};

export const ASR_MODELS: readonly AsrModelSpec[] = [WHISPER_TINY_EN, WHISPER_TINY_MULTI];

/**
 * Choose a checkpoint for a language tag. English gets the English-only
 * model (it is more accurate than the multilingual one at the same
 * size); anything else gets multilingual, because an English-only model
 * would simply produce nonsense.
 */
export function pickAsrModel(languageTag: string | undefined): AsrModelSpec {
  const tag = (languageTag ?? '').trim().toLowerCase();
  if (!tag || tag === 'all' || tag.startsWith('en')) return WHISPER_TINY_EN;
  return WHISPER_TINY_MULTI;
}

// ─── Audio maths ─────────────────────────────────────────────────
// WebAudio hands back whatever the microphone gave us — commonly 48 kHz
// stereo float32. Whisper wants 16 kHz mono. These three functions are
// the whole conversion.

/** Average channels down to one. A single channel is returned as-is. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (!channels.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Resample to a different rate.
 *
 * Downsampling averages each output sample's input window. That is a box
 * filter — a crude low-pass — but a crude low-pass is the point: plain
 * linear interpolation would fold everything above 8 kHz back into the
 * speech band as aliasing, and aliasing is exactly what makes Whisper
 * transcribe confidently wrong words.
 *
 * Upsampling is linear, which is fine: there is no aliasing to avoid,
 * only samples to invent.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) return new Float32Array(0);
  if (fromRate === toRate || samples.length === 0) return samples;

  const ratio = fromRate / toRate;
  const outLength = Math.max(0, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);

  if (ratio >= 1) {
    for (let i = 0; i < outLength; i++) {
      const start = i * ratio;
      const end = start + ratio;
      let sum = 0;
      let count = 0;
      const from = Math.floor(start);
      const to = Math.min(Math.ceil(end), samples.length);
      for (let j = from; j < to; j++) {
        sum += samples[j];
        count++;
      }
      out[i] = count ? sum / count : 0;
    }
  } else {
    for (let i = 0; i < outLength; i++) {
      const position = i * ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = samples[index] ?? 0;
      const b = samples[index + 1] ?? a;
      out[i] = a + (b - a) * fraction;
    }
  }
  return out;
}

/** Join recorded fragments into one buffer. */
export function concat(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Peak absolute amplitude, 0..1. Used to reject a silent recording. */
export function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** True when a recording is too quiet to be speech worth sending. */
export function isSilent(samples: Float32Array, threshold = 0.005): boolean {
  return peakLevel(samples) < threshold;
}

/**
 * Cheap speech-likeness check.
 *
 * Whisper does not have a "nothing was said" output — asked to transcribe
 * a hum, a fan, or a steady tone it will confidently answer "you". The
 * amplitude envelope is what separates the two: speech rises and falls
 * with every syllable, while a machine noise sits at a nearly constant
 * level. So measure how much the per-frame loudness varies, and treat a
 * flat envelope as not-speech.
 *
 * This is a filter, not a voice-activity detector. It will pass music and
 * should — a user dictating over background audio still wants their words.
 * The conservative threshold is deliberate: rejecting real speech is much
 * worse than sending the model one bad window.
 */
export function looksLikeSpeech(samples: Float32Array, sampleRate: number, minVariation = 0.25): boolean {
  if (!samples.length) return false;
  const frame = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms
  const levels: number[] = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) sum += samples[i] * samples[i];
    levels.push(Math.sqrt(sum / frame));
  }
  // Too little audio to judge — let the model decide rather than guess.
  if (levels.length < 3) return true;
  const mean = levels.reduce((sum, level) => sum + level, 0) / levels.length;
  if (mean <= 0) return false;
  const variance =
    levels.reduce((sum, level) => sum + (level - mean) ** 2, 0) / levels.length;
  const variation = Math.sqrt(variance) / mean;
  return variation >= minVariation;
}

/**
 * Trim leading and trailing near-silence, keeping `padMs` of margin so
 * the first and last phonemes survive. Whisper hallucinates words when
 * handed a long run of silence, so trimming is not cosmetic.
 *
 * `threshold` is an absolute amplitude, but it is capped at a fraction of
 * the recording's own peak. A soft speaker on a quiet microphone can peak
 * at 0.02; an absolute 0.01 gate would then cut half their speech away and
 * return a fragment. Relative to the peak, the same recording trims the
 * same way a loud one does.
 */
export function trimSilence(
  samples: Float32Array,
  sampleRate: number,
  threshold = 0.01,
  padMs = 100,
): Float32Array {
  if (!samples.length) return samples;
  const peak = peakLevel(samples);
  if (peak <= 0) return new Float32Array(0);
  // Never gate above 5% of the loudest sample in this recording.
  const floor = Math.min(threshold, peak * 0.05);
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < floor) first++;
  if (first === samples.length) return new Float32Array(0);
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < floor) last--;

  const pad = Math.floor((padMs / 1000) * sampleRate);
  const start = Math.max(0, first - pad);
  const end = Math.min(samples.length, last + pad + 1);
  return samples.subarray(start, end);
}

// ─── Transcript handling ─────────────────────────────────────────

// Whisper labels non-speech audio instead of staying quiet. Left in, the
// labels end up in the user's document.
const NON_SPEECH =
  /\[\s*(blank[_\s]?audio|silence|music|applause|inaudible|noise|sound)\s*\]|\(\s*(silence|music|applause|inaudible)\s*\)/gi;

/** Strip non-speech labels and tidy whitespace. */
export function normalizeTranscript(text: string): string {
  return text
    .replace(NON_SPEECH, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Join transcripts from consecutive Whisper windows. Splitting a long
 * recording at an arbitrary 30-second boundary can cut a word in half, so
 * the seams are joined with a space and then cleaned like any other
 * transcript rather than trusted to be perfectly adjacent.
 */
export function conflate(parts: readonly string[]): string {
  const clean = parts.map((part) => part.trim()).filter(Boolean);
  if (!clean.length) return '';
  return normalizeTranscript(clean.join(' '));
}

/**
 * Insert a transcript at the caret, adding a space on either side only
 * where one is needed — dictating three words in a row should read as a
 * sentence, not as "Hello ,world .".
 */
export function insertAtCaret(
  text: string,
  insertion: string,
  caret: number,
): { text: string; caret: number } {
  const clean = insertion.trim();
  if (!clean) return { text, caret };
  const at = Math.min(Math.max(caret, 0), text.length);
  const before = text.slice(0, at);
  const after = text.slice(at);

  const needsLeading = before.length > 0 && !/\s$/.test(before);
  const needsTrailing = after.length > 0 && !/^\s/.test(after) && !/[.,;:!?]$/.test(clean);
  const inserted = `${needsLeading ? ' ' : ''}${clean}${needsTrailing ? ' ' : ''}`;

  return { text: `${before}${inserted}${after}`, caret: at + inserted.length };
}

/** True when this browser can record at all. */
export function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}
