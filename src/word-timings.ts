/**
 * Estimated per-word start times for engines that do not report real ones.
 *
 * Spoken duration tracks word length closely — character count is a decent
 * proxy for phoneme count — so the clip's duration is divided proportionally
 * to each word's size, with a small floor so punctuation-light tokens ("—",
 * "a") still get a moment instead of vanishing between neighbours.
 *
 * These are estimates, and the honest use is captions and karaoke, not
 * surgical audio edits. Engines that report real timings (Kokoro) always win;
 * this only fills the gap so word-level features stop being a per-engine
 * luxury.
 */

/**
 * Start times (seconds) for each whitespace-separated word of `text`, spread
 * across `durationSeconds`. Returns [] when there is nothing to speak or no
 * duration to spread, which callers treat as "no timings" — better than
 * timings that describe nothing.
 */
export function estimateWordTimings(text: string, durationSeconds: number): number[] {
  const words = text.match(/\S+/g) ?? [];
  if (!words.length || !(durationSeconds > 0)) return [];
  const weight = (word: string): number => Math.max(2, word.length);
  const totalWeight = words.reduce((sum, word) => sum + weight(word), 0);
  const starts: number[] = [];
  let cumulative = 0;
  for (const word of words) {
    starts.push((cumulative / totalWeight) * durationSeconds);
    cumulative += weight(word);
  }
  return starts;
}

export interface ClipTimingSource {
  text: string;
  /** Clip length in seconds. */
  durationSeconds: number;
  /** Per-word start times relative to this clip's own start, if any. */
  wordTimings?: number[];
}

export interface MergedTimings {
  text: string;
  /** Per-word start times on the merged timeline. */
  wordTimings: number[];
  /** Length of the concatenated audio, gaps included. */
  totalSeconds: number;
}

/**
 * Merge per-clip word timings into one document-wide timeline.
 *
 * Each clip's timings are relative to its own start; with `gapSeconds` of
 * silence between clips (as `concatenateClips` inserts), clip i starts at
 * the sum of the earlier durations and gaps. Clips without usable timings
 * fall back to estimates, so the merged timeline is never holey.
 */
export function mergeClipTimings(
  clips: ClipTimingSource[],
  gapSeconds = 0,
): MergedTimings {
  const words: string[] = [];
  const wordTimings: number[] = [];
  let offset = 0;
  for (const [index, clip] of clips.entries()) {
    const clipWords = clip.text.match(/\S+/g) ?? [];
    const timings = clip.wordTimings && clip.wordTimings.length >= clipWords.length
      ? clip.wordTimings
      : estimateWordTimings(clip.text, clip.durationSeconds);
    for (let i = 0; i < clipWords.length; i++) {
      words.push(clipWords[i]);
      wordTimings.push(offset + (timings[i] ?? clip.durationSeconds));
    }
    offset += clip.durationSeconds;
    if (index < clips.length - 1) offset += gapSeconds;
  }
  return { text: words.join(' '), wordTimings, totalSeconds: offset };
}

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** Words with their spans on a timeline; each word ends where the next begins. */
export function timedWords(
  text: string,
  wordTimings: number[],
  endSeconds: number,
): TimedWord[] {
  const words = text.match(/\S+/g) ?? [];
  const out: TimedWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const start = wordTimings[i] ?? (out[i - 1]?.end ?? 0);
    const end = i + 1 < words.length
      ? (wordTimings[i + 1] ?? start)
      : Math.max(endSeconds, start);
    out.push({ text: words[i], start, end: Math.max(end, start) });
  }
  return out;
}
