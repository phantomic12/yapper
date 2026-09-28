/**
 * Pre-recorded voice auditions.
 *
 * The problem this solves is spelled out in model-panel.ts: until a model is
 * loaded, every "Hear it" button is dead — pressing one on an 88MB download
 * that has not started would kick off a silent fetch the user never asked for.
 * So the one question a newcomer actually has ("which of these voices do I
 * like?") cost a model download. That is the last place the simple view
 * charges the user for the engineering, and the samples remove it: a clip
 * that is already on the CDN starts playing before the click even settles.
 *
 * The clips are not hand-made. `scripts/generate_voice_samples.py` drives the
 * app's own audition path in a headless browser and records what comes out,
 * so a sample and a live synthesis of the same voice are the same audio by
 * construction rather than by a test that hopes they match.
 *
 * ── Why the key is (modelId, voiceId) and not just voiceId ──────────────
 * KITTEN_VOICES is a single shared constant: kitten-nano and kitten-mini
 * expose the *same eight voice ids* but condition on different embeddings
 * (see the registry comments in src/engines/kitten.ts), so they sound
 * genuinely different. A cache keyed by voice id alone would hand Mini the
 * audio of Nano — a mistake no test would catch, because the file exists, the
 * bytes are valid, and the user just concludes "Mini sounds bad".
 *
 * ── Aliases ────────────────────────────────────────────────────────────
 * An entry may point at another model's file. Today that is only
 * kokoro-82m-fp16 borrowing the int8 recordings: the voices are the same
 * 28 style vectors and the difference is quantisation, which is not what a
 * voice choice turns on. It is recorded rather than hidden — `sourceModel`
 * is surfaced in the advanced view, so a recording is never passed off as
 * something it is not.
 */

import { PREVIEW_TEXT } from './voice-preview';
import { VOICE_SAMPLE_MANIFEST, type VoiceSampleEntry } from './voice-samples.data';

export type { VoiceSampleEntry };
export { VOICE_SAMPLE_MANIFEST };

/**
 * Composite lookup key. The separator is `::` rather than `/` or `,`
 * because both appear inside real model ids (`Xenova/mms-tts-eng`) and voice
 * names, and a key that can collide is a key that will eventually do so.
 */
export function voiceSampleKey(modelId: string, voiceId: string): string {
  return `${modelId}::${voiceId}`;
}

/** The recorded clip for this model+voice, or null if there isn't one. */
export function findVoiceSample(modelId: string, voiceId: string): VoiceSampleEntry | null {
  return VOICE_SAMPLE_MANIFEST.samples[voiceSampleKey(modelId, voiceId)] ?? null;
}

export function hasVoiceSample(modelId: string, voiceId: string): boolean {
  return findVoiceSample(modelId, voiceId) !== null;
}

/**
 * True when the recording came from a different model than the one being
 * auditioned. The advanced view uses this to say so out loud.
 */
export function isAliasedSample(modelId: string, voiceId: string): boolean {
  const entry = findVoiceSample(modelId, voiceId);
  return entry !== null && entry.sourceModel !== modelId;
}

/**
 * Absolute URL for a clip.
 *
 * `vite.config.ts` sets `base: './'`, so the app is served from a different
 * prefix on GitHub Pages (/yapper/) than on the dev server (/) and a
 * root-absolute '/voice-samples/...' would 404 in production. Anchoring on
 * document.baseURI handles both, the same way publicLibUrl() in
 * src/engines/kitten.ts does. The path is built by a template rather than
 * written as a literal precisely so Vite's static-asset transform does not
 * rewrite it into a /@fs/ build path.
 */
export function voiceSampleUrl(entry: VoiceSampleEntry): string {
  return new URL(`voice-samples/${entry.file}`, document.baseURI).href;
}

/**
 * Fetch a recorded clip, or null if there is no recording.
 *
 * Returns null rather than throwing on a missing sample because the caller
 * falls back to live synthesis — a 404 here is an inconvenience, not a
 * failure, and a network error on one clip should not take the audition
 * button down with it.
 */
export async function fetchVoiceSample(modelId: string, voiceId: string): Promise<Blob | null> {
  const entry = findVoiceSample(modelId, voiceId);
  if (!entry) return null;
  try {
    const res = await fetch(voiceSampleUrl(entry));
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * 32-bit FNV-1a, hex. Not a security primitive — it exists so that editing
 * PREVIEW_TEXT without regenerating the recordings is a *failing test*
 * rather than 44 clips quietly reading the wrong sentence.
 *
 * Deliberately not crypto.subtle: that is async and unavailable in insecure
 * contexts, and a value that only exists inside a test needs to be a plain
 * function.
 */
export function previewTextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The hash the recordings should carry, derived from the text itself.
 *
 * This is what the staleness test compares the manifest against, and what the
 * generator asks Node to compute — so there is exactly one implementation of
 * the hash in the repository. A second copy in the Python generator would be
 * free to drift, and a drifted hash makes the staleness guard silently useless:
 * it would keep passing while comparing the wrong two things.
 */
export function expectedPreviewTextHash(): string {
  return previewTextHash(PREVIEW_TEXT);
}
