import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  VOICE_SAMPLE_MANIFEST,
  expectedPreviewTextHash,
  fetchVoiceSample,
  findVoiceSample,
  hasVoiceSample,
  isAliasedSample,
  previewTextHash,
  voiceSampleKey,
} from './voice-samples';
import { visibleModels } from './engine';
import { supportsVoicePreview } from './voice-preview';

const SAMPLES_DIR = resolve(__dirname, '..', 'public', 'voice-samples');

describe('voice sample keys', () => {
  it('cannot collide when a model id contains a slash', () => {
    // Model ids really do contain '/' (Xenova/mms-tts-eng), so a separator
    // that appears inside an id would let one model's entry answer for
    // another's lookup.
    expect(voiceSampleKey('Xenova/mms-tts-eng', 'af_heart'))
      .not.toBe(voiceSampleKey('Xenova', 'mms-tts-eng::af_heart'));
  });

  it('distinguishes two models that share voice ids', () => {
    // The whole reason the key is composite. kitten-mini and kitten-nano
    // expose the same eight voice ids but condition on different embeddings.
    expect(voiceSampleKey('kitten-mini', 'expr-voice-2-f'))
      .not.toBe(voiceSampleKey('kitten-nano', 'expr-voice-2-f'));
  });
});

describe('voice sample lookup', () => {
  it('finds a recorded clip and reports its shape', () => {
    const entry = findVoiceSample('kokoro-82m', 'af_heart');
    expect(entry).not.toBeNull();
    expect(entry!.file).toBe('kokoro-82m/af_heart.mp3');
    expect(entry!.durationSec).toBeGreaterThan(1);
    expect(entry!.bytes).toBeGreaterThan(1000);
  });

  it('returns null for a voice that was never recorded', () => {
    expect(findVoiceSample('kokoro-82m', 'not_a_voice')).toBeNull();
    expect(hasVoiceSample('kokoro-82m', 'not_a_voice')).toBe(false);
  });

  it('never lets one Kitten model answer for the other', () => {
    // If this regresses, Mini silently plays Nano's audio: the file exists,
    // the bytes are valid, and no error is raised anywhere. The only symptom
    // is a user concluding that Kitten Mini sounds bad.
    for (const voice of ['expr-voice-2-f', 'expr-voice-5-m']) {
      const nano = findVoiceSample('kitten-nano', voice)!;
      const mini = findVoiceSample('kitten-mini', voice)!;
      expect(mini.file).not.toBe(nano.file);
      expect(mini.sourceModel).toBe('kitten-mini');
      expect(nano.sourceModel).toBe('kitten-nano');
    }
  });
});

describe('voice sample aliases', () => {
  it('borrows the int8 recordings for the fp16 build and says so', () => {
    const entry = findVoiceSample('kokoro-82m-fp16', 'af_heart')!;
    expect(entry.file).toBe('kokoro-82m/af_heart.mp3');
    expect(entry.sourceModel).toBe('kokoro-82m');
    expect(isAliasedSample('kokoro-82m-fp16', 'af_heart')).toBe(true);
  });

  it('does not claim a first-party recording is an alias', () => {
    expect(isAliasedSample('kokoro-82m', 'af_heart')).toBe(false);
    expect(isAliasedSample('kitten-nano', 'expr-voice-2-f')).toBe(false);
  });

  it('records a reason for every alias it declares', () => {
    for (const key of Object.keys(VOICE_SAMPLE_MANIFEST.aliases)) {
      expect(VOICE_SAMPLE_MANIFEST.aliases[key].length).toBeGreaterThan(10);
      expect(isAliasedSample(...(key.split('::') as [string, string]))).toBe(true);
    }
  });
});

describe('voice sample staleness', () => {
  it('was recorded from the text the app still speaks', () => {
    // The whole point of the hash. Editing PREVIEW_TEXT without re-running
    // the generator would otherwise leave 44 clips saying a sentence the app
    // no longer has any reason to say.
    expect(VOICE_SAMPLE_MANIFEST.textHash).toBe(expectedPreviewTextHash());
  });

  it('is a real hash of something', () => {
    expect(VOICE_SAMPLE_MANIFEST.textHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changes when the text changes', () => {
    expect(previewTextHash('hello')).not.toBe(previewTextHash('hello '));
    expect(previewTextHash('hello')).toBe(previewTextHash('hello'));
  });
});

describe('voice sample coverage', () => {
  const previewable = visibleModels().filter(supportsVoicePreview);

  it('finds at least the models we expect', () => {
    // Guards the test below from passing vacuously if the registry changes
    // shape and `previewable` ends up empty.
    expect(previewable.map(m => m.id).sort())
      .toEqual(['kitten-mini', 'kitten-nano', 'kokoro-82m', 'kokoro-82m-fp16']);
  });

  it('has a recording for every voice of every previewable model', () => {
    for (const model of previewable) {
      for (const voice of model.voices ?? []) {
        expect(
          hasVoiceSample(model.id, voice.id),
          `${model.id} / ${voice.id} has no recording — re-run scripts/generate_voice_samples.py`,
        ).toBe(true);
      }
    }
  });

  it('has no recordings for voices that do not exist', () => {
    // Catches a rename that left the old file behind: the stale entry would
    // otherwise sit in the manifest forever, invisible.
    for (const key of Object.keys(VOICE_SAMPLE_MANIFEST.samples)) {
      const [modelId, voiceId] = key.split('::');
      const model = visibleModels().find(m => m.id === modelId);
      expect(model, `${modelId} is not a visible model`).toBeDefined();
      expect(
        model!.voices?.some(v => v.id === voiceId),
        `${key} is recorded but the registry no longer lists that voice`,
      ).toBe(true);
    }
  });

  it('pins an upstream revision for every model that was recorded', () => {
    for (const model of previewable) {
      const revision = VOICE_SAMPLE_MANIFEST.revisions[model.modelId];
      expect(revision, `${model.modelId} has no recorded revision`).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe('voice sample files', () => {
  it('every entry points at a file that is actually committed', () => {
    // The manifest and the audio are two artefacts; this is the check that
    // keeps them from drifting when someone regenerates one and not the other.
    for (const [key, entry] of Object.entries(VOICE_SAMPLE_MANIFEST.samples)) {
      expect(existsSync(resolve(SAMPLES_DIR, entry.file)), `${key} -> ${entry.file}`).toBe(true);
    }
  });

  it('committed the Apache-2.0 attribution the licences require', () => {
    // Not decoration: redistributing derivative works under Apache-2.0
    // carries an attribution obligation, and this file is where it is met.
    expect(existsSync(resolve(SAMPLES_DIR, 'PROVENANCE.md'))).toBe(true);
  });
});

describe('fetchVoiceSample', () => {
  it('resolves null instead of throwing for an unrecorded voice', async () => {
    // The caller falls back to live synthesis, so a miss must be an ordinary
    // outcome rather than an exception that takes the audition button down.
    await expect(fetchVoiceSample('kokoro-82m', 'not_a_voice')).resolves.toBeNull();
  });
});
