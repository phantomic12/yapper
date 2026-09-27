/**
 * Quality presets: the one knob a newcomer should have to touch.
 *
 * The model registry has a dozen entries with real trade-offs — engine,
 * quantisation, download size, fidelity. That is exactly the kind of choice
 * a person who just wants to hear their words read aloud should not have to
 * make on their first visit. So the default view offers three words instead:
 * Low, Medium, High.
 *
 * Each preset is a *named* model underneath (a preset is a bookmark, not a
 * separate inference path), so it stays honest — the ladder below is a real
 * fidelity/size ladder, not a placebo slider:
 *
 *   Low    → Kitten TTS Nano   ~24MB   tiny + fast, lowest fidelity
 *   Medium → Kokoro-82M int8   ~88MB   natural voices, the sweet spot
 *   High   → Kokoro-82M fp16  ~156MB   best fidelity (falls back to int8
 *                                      on GPUs without shader-f16)
 *
 * The presets are a *view* over model selection, not a second source of
 * truth: `presetForModel` derives the active preset from whichever model is
 * actually selected. Pick a model that is not on the ladder (an MMS language
 * model, say) in the advanced grid and no preset lights up — which is the
 * truthful answer, not a bug.
 *
 * Everything here is pure: no DOM, no AppState. The UI wires it up in
 * src/ui/model-panel.ts.
 */

export type QualityPreset = 'low' | 'medium' | 'high';

export interface QualityPresetDef {
  id: QualityPreset;
  /** Shown on the segmented control. */
  label: string;
  /** One line on *why* you would pick this, under the label. */
  blurb: string;
  /** The model this preset selects — an id in the MODELS registry. */
  modelId: string;
}

export const QUALITY_PRESETS: readonly QualityPresetDef[] = [
  {
    id: 'low',
    label: 'Low',
    blurb: 'Fastest · ~24MB',
    modelId: 'kitten-nano',
  },
  {
    id: 'medium',
    label: 'Medium',
    blurb: 'Natural voices · ~88MB',
    modelId: 'kokoro-82m',
  },
  {
    id: 'high',
    label: 'High',
    blurb: 'Best fidelity · ~156MB',
    modelId: 'kokoro-82m-fp16',
  },
];

/**
 * Medium is the default: it is where the natural Kokoro voices live, which
 * is the thing someone coming to a text-to-speech site actually wants.
 */
export const DEFAULT_QUALITY_PRESET: QualityPreset = 'medium';

/** The model id a preset maps to. Unknown ids are a programming error. */
export function modelIdForPreset(preset: QualityPreset): string {
  const def = QUALITY_PRESETS.find(p => p.id === preset);
  if (!def) throw new Error(`Unknown quality preset: ${preset}`);
  return def.modelId;
}

/**
 * The preset that selects this model, or `null` when the model is not on the
 * ladder (an advanced-only pick such as an MMS language model).
 */
export function presetForModel(modelId: string): QualityPreset | null {
  return QUALITY_PRESETS.find(p => p.modelId === modelId)?.id ?? null;
}

/** The def for a preset id, or undefined. */
export function presetDef(preset: QualityPreset): QualityPresetDef | undefined {
  return QUALITY_PRESETS.find(p => p.id === preset);
}
