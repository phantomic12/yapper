// ─── Audio export helpers ────────────────────────────────────────
// Pure Float32Array math used by the "Download all" queue export:
// resample each finished clip to a common rate, then concatenate with
// short silence gaps so consecutive jobs don't run together audibly.

export interface AudioClip {
  audio: Float32Array;
  sampleRate: number;
}

/**
 * The samples between `startSeconds` and `endSeconds`, clamped to the clip.
 *
 * Chapter audio in a DAISY book is a cut of the assembled timeline rather than
 * a fresh synthesis: slicing keeps one decode-free copy of the audio and lets
 * chapter files start exactly where the chapter does. A range past either end
 * yields the samples that exist instead of throwing, because chapter times
 * come from word timings and a rounding error at the boundary is normal.
 */
export function sliceClip(clip: AudioClip, startSeconds: number, endSeconds: number): Float32Array {
  const length = clip.audio.length;
  const from = Math.min(length, Math.max(0, Math.round(startSeconds * clip.sampleRate)));
  const to = Math.min(length, Math.max(from, Math.round(endSeconds * clip.sampleRate)));
  // A view, not a copy: the caller encodes it straight to a WAV, and a book's
  // merged audio can be tens of megabytes.
  return clip.audio.subarray(from, to);
}


/**
 * Resample a clip to `targetRate` with linear interpolation, preserving
 * its duration. Same-rate clips are returned as-is (no copy).
 */
export function resampleClip(clip: AudioClip, targetRate: number): Float32Array {
  if (clip.sampleRate === targetRate) return clip.audio;
  if (clip.sampleRate <= 0 || targetRate <= 0) {
    throw new Error(`resampleClip: invalid rates ${clip.sampleRate} → ${targetRate}`);
  }
  const outLength = Math.max(1, Math.round((clip.audio.length * targetRate) / clip.sampleRate));
  const out = new Float32Array(outLength);
  const ratio = clip.audio.length / outLength;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(clip.audio.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = clip.audio[i0] * (1 - frac) + clip.audio[i1] * frac;
  }
  return out;
}

/**
 * Concatenate clips in order, inserting `gapSeconds` of silence between
 * them. Clips are resampled to the highest sample rate present so no
 * source is pitched down; the result is a single clip ready for
 * `float32ToWav`.
 */
export function concatenateClips(clips: AudioClip[], gapSeconds = 0.35): AudioClip {
  if (clips.length === 0) throw new Error('concatenateClips: no clips');
  const sampleRate = Math.max(...clips.map(c => c.sampleRate));
  const gap = Math.round(gapSeconds * sampleRate);
  const parts = clips.map(c => resampleClip(c, sampleRate));
  let total = gap * (clips.length - 1);
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let pos = 0;
  parts.forEach((p, i) => {
    out.set(p, pos);
    pos += p.length;
    if (i < parts.length - 1) pos += gap;
  });
  return { audio: out, sampleRate };
}
