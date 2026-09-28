/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by scripts/generate_voice_samples.py. Re-run it after changing
 * PREVIEW_TEXT or bumping a model upstream; the staleness test in
 * src/voice-samples.test.ts fails if this file and those disagree.
 */

export interface VoiceSampleEntry {
  /** Path under public/voice-samples/, e.g. "kokoro-82m/af_heart.mp3". */
  file: string;
  /**
   * The model the audio was actually recorded from. Differs from the
   * key's model only for a deliberate alias, which the advanced view
   * discloses.
   */
  sourceModel: string;
  /** Length of the recorded clip in seconds. */
  durationSec: number;
  /** Size of the encoded file in bytes. */
  bytes: number;
}

export interface VoiceSampleManifest {
  /** previewTextHash() of the text every clip was recorded speaking. */
  textHash: string;
  /** Upstream model revision each recording was generated from. */
  revisions: Record<string, string>;
  /** Why a key points at another model's file: `${modelId}::${voiceId}` -> reason. */
  aliases: Record<string, string>;
  /** Keyed by `${modelId}::${voiceId}` — see voiceSampleKey(). */
  samples: Record<string, VoiceSampleEntry>;
}

export const VOICE_SAMPLE_MANIFEST: VoiceSampleManifest = {
  textHash: "0b927ed2",
  revisions: {
    "KittenML/kitten-tts-mini-0.8": "c02725660cea441db4c383af69f1f26f5cd00947",
    "KittenML/kitten-tts-nano-0.8-int8": "84781d74e29ee25217551556398b42f80593a813",
    "onnx-community/Kokoro-82M-v1.0-ONNX": "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
  },
  aliases: {
    "kokoro-82m-fp16::af_alloy": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_aoede": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_bella": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_heart": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_jessica": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_kore": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_nicole": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_nova": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_river": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_sarah": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::af_sky": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_adam": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_echo": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_eric": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_fenrir": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_liam": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_michael": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_onyx": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_puck": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::am_santa": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::bf_alice": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::bf_emma": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::bf_isabella": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::bf_lily": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::bm_daniel": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::bm_fable": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::bm_george": "Same 28 style vectors from the same repo; only the dtype differs.",
    "kokoro-82m-fp16::bm_lewis": "Same 28 style vectors from the same repo; only the dtype differs.",
  },
  samples: {
    "kitten-mini::expr-voice-2-f": { file: "kitten-mini/expr-voice-2-f.mp3", sourceModel: "kitten-mini", durationSec: 5.52, bytes: 33645 },
    "kitten-mini::expr-voice-2-m": { file: "kitten-mini/expr-voice-2-m.mp3", sourceModel: "kitten-mini", durationSec: 3.17, bytes: 19533 },
    "kitten-mini::expr-voice-3-f": { file: "kitten-mini/expr-voice-3-f.mp3", sourceModel: "kitten-mini", durationSec: 4.24, bytes: 26013 },
    "kitten-mini::expr-voice-3-m": { file: "kitten-mini/expr-voice-3-m.mp3", sourceModel: "kitten-mini", durationSec: 3.37, bytes: 20829 },
    "kitten-mini::expr-voice-4-f": { file: "kitten-mini/expr-voice-4-f.mp3", sourceModel: "kitten-mini", durationSec: 3.74, bytes: 22989 },
    "kitten-mini::expr-voice-4-m": { file: "kitten-mini/expr-voice-4-m.mp3", sourceModel: "kitten-mini", durationSec: 4.17, bytes: 25581 },
    "kitten-mini::expr-voice-5-f": { file: "kitten-mini/expr-voice-5-f.mp3", sourceModel: "kitten-mini", durationSec: 3.52, bytes: 21693 },
    "kitten-mini::expr-voice-5-m": { file: "kitten-mini/expr-voice-5-m.mp3", sourceModel: "kitten-mini", durationSec: 4.94, bytes: 30189 },
    "kitten-nano::expr-voice-2-f": { file: "kitten-nano/expr-voice-2-f.mp3", sourceModel: "kitten-nano", durationSec: 5.47, bytes: 33357 },
    "kitten-nano::expr-voice-2-m": { file: "kitten-nano/expr-voice-2-m.mp3", sourceModel: "kitten-nano", durationSec: 3.07, bytes: 18957 },
    "kitten-nano::expr-voice-3-f": { file: "kitten-nano/expr-voice-3-f.mp3", sourceModel: "kitten-nano", durationSec: 3.79, bytes: 23277 },
    "kitten-nano::expr-voice-3-m": { file: "kitten-nano/expr-voice-3-m.mp3", sourceModel: "kitten-nano", durationSec: 2.97, bytes: 18381 },
    "kitten-nano::expr-voice-4-f": { file: "kitten-nano/expr-voice-4-f.mp3", sourceModel: "kitten-nano", durationSec: 3.59, bytes: 22125 },
    "kitten-nano::expr-voice-4-m": { file: "kitten-nano/expr-voice-4-m.mp3", sourceModel: "kitten-nano", durationSec: 3.39, bytes: 20973 },
    "kitten-nano::expr-voice-5-f": { file: "kitten-nano/expr-voice-5-f.mp3", sourceModel: "kitten-nano", durationSec: 3.02, bytes: 18669 },
    "kitten-nano::expr-voice-5-m": { file: "kitten-nano/expr-voice-5-m.mp3", sourceModel: "kitten-nano", durationSec: 5.07, bytes: 31053 },
    "kokoro-82m-fp16::af_alloy": { file: "kokoro-82m/af_alloy.mp3", sourceModel: "kokoro-82m", durationSec: 4.13, bytes: 25293 },
    "kokoro-82m-fp16::af_aoede": { file: "kokoro-82m/af_aoede.mp3", sourceModel: "kokoro-82m", durationSec: 3.68, bytes: 22701 },
    "kokoro-82m-fp16::af_bella": { file: "kokoro-82m/af_bella.mp3", sourceModel: "kokoro-82m", durationSec: 4.13, bytes: 25293 },
    "kokoro-82m-fp16::af_heart": { file: "kokoro-82m/af_heart.mp3", sourceModel: "kokoro-82m", durationSec: 3.73, bytes: 22989 },
    "kokoro-82m-fp16::af_jessica": { file: "kokoro-82m/af_jessica.mp3", sourceModel: "kokoro-82m", durationSec: 3.6, bytes: 22125 },
    "kokoro-82m-fp16::af_kore": { file: "kokoro-82m/af_kore.mp3", sourceModel: "kokoro-82m", durationSec: 3.85, bytes: 23709 },
    "kokoro-82m-fp16::af_nicole": { file: "kokoro-82m/af_nicole.mp3", sourceModel: "kokoro-82m", durationSec: 6.0, bytes: 36525 },
    "kokoro-82m-fp16::af_nova": { file: "kokoro-82m/af_nova.mp3", sourceModel: "kokoro-82m", durationSec: 4.03, bytes: 24717 },
    "kokoro-82m-fp16::af_river": { file: "kokoro-82m/af_river.mp3", sourceModel: "kokoro-82m", durationSec: 3.65, bytes: 22557 },
    "kokoro-82m-fp16::af_sarah": { file: "kokoro-82m/af_sarah.mp3", sourceModel: "kokoro-82m", durationSec: 4.13, bytes: 25293 },
    "kokoro-82m-fp16::af_sky": { file: "kokoro-82m/af_sky.mp3", sourceModel: "kokoro-82m", durationSec: 4.1, bytes: 25149 },
    "kokoro-82m-fp16::am_adam": { file: "kokoro-82m/am_adam.mp3", sourceModel: "kokoro-82m", durationSec: 3.85, bytes: 23709 },
    "kokoro-82m-fp16::am_echo": { file: "kokoro-82m/am_echo.mp3", sourceModel: "kokoro-82m", durationSec: 4.13, bytes: 25293 },
    "kokoro-82m-fp16::am_eric": { file: "kokoro-82m/am_eric.mp3", sourceModel: "kokoro-82m", durationSec: 3.6, bytes: 22125 },
    "kokoro-82m-fp16::am_fenrir": { file: "kokoro-82m/am_fenrir.mp3", sourceModel: "kokoro-82m", durationSec: 3.7, bytes: 22845 },
    "kokoro-82m-fp16::am_liam": { file: "kokoro-82m/am_liam.mp3", sourceModel: "kokoro-82m", durationSec: 3.73, bytes: 22989 },
    "kokoro-82m-fp16::am_michael": { file: "kokoro-82m/am_michael.mp3", sourceModel: "kokoro-82m", durationSec: 4.48, bytes: 27453 },
    "kokoro-82m-fp16::am_onyx": { file: "kokoro-82m/am_onyx.mp3", sourceModel: "kokoro-82m", durationSec: 4.03, bytes: 24717 },
    "kokoro-82m-fp16::am_puck": { file: "kokoro-82m/am_puck.mp3", sourceModel: "kokoro-82m", durationSec: 3.7, bytes: 22845 },
    "kokoro-82m-fp16::am_santa": { file: "kokoro-82m/am_santa.mp3", sourceModel: "kokoro-82m", durationSec: 4.2, bytes: 25725 },
    "kokoro-82m-fp16::bf_alice": { file: "kokoro-82m/bf_alice.mp3", sourceModel: "kokoro-82m", durationSec: 4.03, bytes: 24717 },
    "kokoro-82m-fp16::bf_emma": { file: "kokoro-82m/bf_emma.mp3", sourceModel: "kokoro-82m", durationSec: 3.83, bytes: 23565 },
    "kokoro-82m-fp16::bf_isabella": { file: "kokoro-82m/bf_isabella.mp3", sourceModel: "kokoro-82m", durationSec: 4.1, bytes: 25149 },
    "kokoro-82m-fp16::bf_lily": { file: "kokoro-82m/bf_lily.mp3", sourceModel: "kokoro-82m", durationSec: 3.98, bytes: 24429 },
    "kokoro-82m-fp16::bm_daniel": { file: "kokoro-82m/bm_daniel.mp3", sourceModel: "kokoro-82m", durationSec: 4.0, bytes: 24573 },
    "kokoro-82m-fp16::bm_fable": { file: "kokoro-82m/bm_fable.mp3", sourceModel: "kokoro-82m", durationSec: 4.15, bytes: 25437 },
    "kokoro-82m-fp16::bm_george": { file: "kokoro-82m/bm_george.mp3", sourceModel: "kokoro-82m", durationSec: 4.68, bytes: 28605 },
    "kokoro-82m-fp16::bm_lewis": { file: "kokoro-82m/bm_lewis.mp3", sourceModel: "kokoro-82m", durationSec: 4.55, bytes: 27885 },
    "kokoro-82m::af_alloy": { file: "kokoro-82m/af_alloy.mp3", sourceModel: "kokoro-82m", durationSec: 4.13, bytes: 25293 },
    "kokoro-82m::af_aoede": { file: "kokoro-82m/af_aoede.mp3", sourceModel: "kokoro-82m", durationSec: 3.68, bytes: 22701 },
    "kokoro-82m::af_bella": { file: "kokoro-82m/af_bella.mp3", sourceModel: "kokoro-82m", durationSec: 4.13, bytes: 25293 },
    "kokoro-82m::af_heart": { file: "kokoro-82m/af_heart.mp3", sourceModel: "kokoro-82m", durationSec: 3.73, bytes: 22989 },
    "kokoro-82m::af_jessica": { file: "kokoro-82m/af_jessica.mp3", sourceModel: "kokoro-82m", durationSec: 3.6, bytes: 22125 },
    "kokoro-82m::af_kore": { file: "kokoro-82m/af_kore.mp3", sourceModel: "kokoro-82m", durationSec: 3.85, bytes: 23709 },
    "kokoro-82m::af_nicole": { file: "kokoro-82m/af_nicole.mp3", sourceModel: "kokoro-82m", durationSec: 6.0, bytes: 36525 },
    "kokoro-82m::af_nova": { file: "kokoro-82m/af_nova.mp3", sourceModel: "kokoro-82m", durationSec: 4.03, bytes: 24717 },
    "kokoro-82m::af_river": { file: "kokoro-82m/af_river.mp3", sourceModel: "kokoro-82m", durationSec: 3.65, bytes: 22557 },
    "kokoro-82m::af_sarah": { file: "kokoro-82m/af_sarah.mp3", sourceModel: "kokoro-82m", durationSec: 4.13, bytes: 25293 },
    "kokoro-82m::af_sky": { file: "kokoro-82m/af_sky.mp3", sourceModel: "kokoro-82m", durationSec: 4.1, bytes: 25149 },
    "kokoro-82m::am_adam": { file: "kokoro-82m/am_adam.mp3", sourceModel: "kokoro-82m", durationSec: 3.85, bytes: 23709 },
    "kokoro-82m::am_echo": { file: "kokoro-82m/am_echo.mp3", sourceModel: "kokoro-82m", durationSec: 4.13, bytes: 25293 },
    "kokoro-82m::am_eric": { file: "kokoro-82m/am_eric.mp3", sourceModel: "kokoro-82m", durationSec: 3.6, bytes: 22125 },
    "kokoro-82m::am_fenrir": { file: "kokoro-82m/am_fenrir.mp3", sourceModel: "kokoro-82m", durationSec: 3.7, bytes: 22845 },
    "kokoro-82m::am_liam": { file: "kokoro-82m/am_liam.mp3", sourceModel: "kokoro-82m", durationSec: 3.73, bytes: 22989 },
    "kokoro-82m::am_michael": { file: "kokoro-82m/am_michael.mp3", sourceModel: "kokoro-82m", durationSec: 4.48, bytes: 27453 },
    "kokoro-82m::am_onyx": { file: "kokoro-82m/am_onyx.mp3", sourceModel: "kokoro-82m", durationSec: 4.03, bytes: 24717 },
    "kokoro-82m::am_puck": { file: "kokoro-82m/am_puck.mp3", sourceModel: "kokoro-82m", durationSec: 3.7, bytes: 22845 },
    "kokoro-82m::am_santa": { file: "kokoro-82m/am_santa.mp3", sourceModel: "kokoro-82m", durationSec: 4.2, bytes: 25725 },
    "kokoro-82m::bf_alice": { file: "kokoro-82m/bf_alice.mp3", sourceModel: "kokoro-82m", durationSec: 4.03, bytes: 24717 },
    "kokoro-82m::bf_emma": { file: "kokoro-82m/bf_emma.mp3", sourceModel: "kokoro-82m", durationSec: 3.83, bytes: 23565 },
    "kokoro-82m::bf_isabella": { file: "kokoro-82m/bf_isabella.mp3", sourceModel: "kokoro-82m", durationSec: 4.1, bytes: 25149 },
    "kokoro-82m::bf_lily": { file: "kokoro-82m/bf_lily.mp3", sourceModel: "kokoro-82m", durationSec: 3.98, bytes: 24429 },
    "kokoro-82m::bm_daniel": { file: "kokoro-82m/bm_daniel.mp3", sourceModel: "kokoro-82m", durationSec: 4.0, bytes: 24573 },
    "kokoro-82m::bm_fable": { file: "kokoro-82m/bm_fable.mp3", sourceModel: "kokoro-82m", durationSec: 4.15, bytes: 25437 },
    "kokoro-82m::bm_george": { file: "kokoro-82m/bm_george.mp3", sourceModel: "kokoro-82m", durationSec: 4.68, bytes: 28605 },
    "kokoro-82m::bm_lewis": { file: "kokoro-82m/bm_lewis.mp3", sourceModel: "kokoro-82m", durationSec: 4.55, bytes: 27885 },
  },
};
