/**
 * WebVTT captions built from the engine's per-word timings.
 *
 * `GenerationJob.wordTimings` holds one start time (in seconds) per
 * whitespace-separated word of the job's text — the same array
 * `pickHighlightedWord` steers the karaoke highlight with. Captions are that
 * data in another costume: group words into readable cues, close each cue at
 * the next word's start, and serialize.
 *
 * Pure and DOM-free on purpose: the exact cue boundaries are the kind of
 * thing worth unit-testing, and a Blob download adds nothing to the math.
 */

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface CaptionOptions {
  /** Hard cap on words per cue. Default 6. */
  maxWords?: number;
  /** Soft cap on cue duration in seconds — a word may overshoot. Default 5. */
  maxSeconds?: number;
}

/** WebVTT timestamp: HH:MM:SS.mmm, negatives clamped to zero. */
export function formatVttTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const ms = Math.round(total * 1000);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    + `:${String(secs).padStart(2, '0')}.${String(rest).padStart(3, '0')}`;
}

/**
 * Timings as strictly non-decreasing start times.
 *
 * Broken engines and hand-edited clips can report a word starting before its
 * predecessor; a caption that runs backwards is worse than one that is a
 * hair late, so runs are nudged apart by 10ms.
 */
function normalizeStarts(count: number, timings: number[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    const raw = timings[i];
    const fallback = i > 0 ? starts[i - 1] + 0.2 : 0;
    const value = Number.isFinite(raw) ? Math.max(0, raw) : fallback;
    starts.push(i > 0 ? Math.max(value, starts[i - 1] + 0.01) : value);
  }
  return starts;
}

/**
 * Group words into caption cues.
 *
 * A cue ends on sentence punctuation, at `maxWords`, or once it has run for
 * `maxSeconds` (a single long word may overshoot the soft cap). The last
 * word's cue closes at `endSeconds`, or half a second after its start when
 * the clip's duration is unknown.
 */
export function buildCaptionCues(
  words: string[],
  wordTimings: number[],
  endSeconds: number,
  options: CaptionOptions = {},
): CaptionCue[] {
  if (!words.length) return [];
  const maxWords = Math.max(1, options.maxWords ?? 6);
  const maxSeconds = Math.max(0.5, options.maxSeconds ?? 5);
  const starts = normalizeStarts(words.length, wordTimings);
  const wordEnd = (i: number): number =>
    (i + 1 < words.length ? starts[i + 1] : Math.max(endSeconds, starts[i] + 0.5));

  const cues: CaptionCue[] = [];
  let cueStart = starts[0];
  let cueWords: string[] = [];
  for (let i = 0; i < words.length; i++) {
    cueWords.push(words[i]);
    const end = wordEnd(i);
    const sentenceEnd = /[.?!][")'\]]?$/.test(words[i]);
    if (sentenceEnd || cueWords.length >= maxWords || end - cueStart >= maxSeconds) {
      cues.push({ start: cueStart, end, text: cueWords.join(' ') });
      cueWords = [];
      cueStart = i + 1 < words.length ? starts[i + 1] : end;
    }
  }
  if (cueWords.length) {
    cues.push({ start: cueStart, end: wordEnd(words.length - 1), text: cueWords.join(' ') });
  }
  return cues;
}

/** True when the job's timings cover every word and captions can be built. */
export function canBuildCaptions(text: string, wordTimings: number[] | undefined): boolean {
  const words = text.match(/\S+/g)?.length ?? 0;
  return words > 0 && !!wordTimings && wordTimings.length >= words;
}

/**
 * The finished WebVTT document, or null when the clip has no usable timings
 * — the caller shows no Captions button rather than downloading a file of
 * guesses.
 */
export function buildWebVtt(
  text: string,
  wordTimings: number[] | undefined,
  endSeconds: number,
  options?: CaptionOptions,
): string | null {
  const words = text.match(/\S+/g) ?? [];
  if (!words.length || !wordTimings || wordTimings.length < words.length) return null;
  const lines = ['WEBVTT', ''];
  for (const [index, cue] of buildCaptionCues(words, wordTimings, endSeconds, options).entries()) {
    lines.push(String(index + 1));
    lines.push(`${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}`);
    lines.push(cue.text);
    lines.push('');
  }
  return lines.join('\n');
}
