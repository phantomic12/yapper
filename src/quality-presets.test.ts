import { describe, it, expect } from 'vitest';
import {
  QUALITY_PRESETS,
  DEFAULT_QUALITY_PRESET,
  modelIdForPreset,
  presetForModel,
  presetDef,
  type QualityPreset,
} from './quality-presets';
import { MODELS } from './engine';

describe('quality presets — data', () => {
  it('is exactly a Low / Medium / High ladder', () => {
    expect(QUALITY_PRESETS.map(p => p.id)).toEqual(['low', 'medium', 'high']);
  });

  it('every preset points at a model that actually exists', () => {
    for (const p of QUALITY_PRESETS) {
      expect(MODELS.some(m => m.id === p.modelId), `${p.id} -> ${p.modelId}`).toBe(true);
    }
  });

  it('uses three distinct models (no preset is a placebo)', () => {
    const ids = QUALITY_PRESETS.map(p => p.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('orders the ladder by download size, Low smallest', () => {
    const [low, med, high] = QUALITY_PRESETS.map(p => p.sizeMB);
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
  });

  it('agrees with the registry about each model size', () => {
    // sizeMB is duplicated onto the preset so the advanced chip can render
    // without importing the registry into the preset module. That copy is a
    // cache, so pin it: a stale figure here would be a wrong download size.
    for (const p of QUALITY_PRESETS) {
      const model = MODELS.find(m => m.id === p.modelId)!;
      expect(p.sizeMB, `${p.id} sizeMB`).toBe(model.sizeMB);
    }
  });

  it('keeps the download size out of the blurb and the tooltip copy', () => {
    // A size is an engineering fact; the simple view shows "Fastest", not
    // "Fastest · ~24MB". See src/ui/layout.ts, which renders sizeMB into a
    // data-advanced chip.
    for (const p of QUALITY_PRESETS) {
      expect(p.blurb, `${p.id} blurb`).not.toMatch(/MB/i);
    }
  });

  it('defaults to Medium, where the natural Kokoro voices live', () => {
    expect(DEFAULT_QUALITY_PRESET).toBe('medium');
    expect(modelIdForPreset(DEFAULT_QUALITY_PRESET)).toBe('kokoro-82m');
  });
});

describe('quality presets — lookups', () => {
  it('round-trips every preset through its model id', () => {
    for (const p of QUALITY_PRESETS) {
      expect(presetForModel(modelIdForPreset(p.id))).toBe(p.id);
    }
  });

  it('maps a model off the ladder to no preset (truthful, not a bug)', () => {
    // An MMS language model picked in the advanced grid lights up nothing.
    expect(presetForModel('mms-tts-eng')).toBeNull();
    expect(presetForModel('speecht5')).toBeNull();
  });

  it('exposes a def for each preset', () => {
    expect(presetDef('high')?.label).toBe('High');
  });

  it('throws on an unknown preset id rather than silently defaulting', () => {
    expect(() => modelIdForPreset('ultra' as QualityPreset)).toThrow(/Unknown quality preset/);
  });
});
