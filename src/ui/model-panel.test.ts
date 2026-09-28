import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureModelLoaded, handleLoadProgress, updateVoicePreviewAvailability } from './model-panel';
import type { AppState } from '../app-state';
import { MODELS } from '../engine';

/** Minimal engine stub: only the surface ensureModelLoaded touches. */
function stubState(engine: unknown, modelId = 'kitten-nano'): AppState {
  return {
    engine,
    selectedModel: MODELS.find(m => m.id === modelId)!,
  } as unknown as AppState;
}

function stubEngine(over: Partial<Record<string, unknown>> = {}) {
  return {
    getEngineState: () => 'idle',
    getCurrentModel: () => null,
    loadModel: vi.fn(async () => {}),
    ...over,
  };
}

describe('ensureModelLoaded — the "Speak just works" loader', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="status-container"></div>';
  });

  it('loads the selected model when nothing is loaded', async () => {
    const engine = stubEngine();
    await ensureModelLoaded(stubState(engine));
    expect(engine.loadModel).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the selected model is already ready', async () => {
    const engine = stubEngine({
      getEngineState: () => 'ready',
      getCurrentModel: () => MODELS.find(m => m.id === 'kitten-nano')!,
    });
    await ensureModelLoaded(stubState(engine));
    expect(engine.loadModel).not.toHaveBeenCalled();
  });

  it('loads a different model even though one is ready', async () => {
    const engine = stubEngine({
      getEngineState: () => 'ready',
      getCurrentModel: () => MODELS.find(m => m.id === 'kokoro-82m')!,
    });
    // Selected model is kitten-nano, loaded model is kokoro → must load.
    await ensureModelLoaded(stubState(engine));
    expect(engine.loadModel).toHaveBeenCalledTimes(1);
  });

  it('swallows a load failure and offers a Retry instead of throwing', async () => {
    const engine = stubEngine({
      loadModel: vi.fn(async () => { throw new Error('offline'); }),
    });
    await expect(ensureModelLoaded(stubState(engine))).resolves.toBeUndefined();
    const status = document.getElementById('status-container')!;
    expect(status.textContent).toContain('Load failed');
    expect(status.querySelector('[data-role="status-action"]')).not.toBeNull();
  });

  it('does nothing when no engine is wired yet', async () => {
    await expect(ensureModelLoaded(stubState(null))).resolves.toBeUndefined();
  });
});

describe('handleLoadProgress — progress copy for the two views', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="progress-fill"></div><div id="progress-text"></div>';
  });

  it('reports a percentage to everyone and the megabytes only to advanced mode', () => {
    handleLoadProgress(5 * 1024 * 1024, 10 * 1024 * 1024, 'Kitten TTS Nano');
    const text = document.getElementById('progress-text')!;
    expect(text.textContent).toContain('50%');
    // The size is a child span marked data-advanced, so the stylesheet —
    // not a JavaScript branch — decides who sees it. That is what makes
    // toggling More mid-download correct with no extra wiring.
    const size = text.querySelector('.progress-text__size')!;
    expect(size).not.toBeNull();
    expect(size.hasAttribute('data-advanced')).toBe(true);
    expect(size.textContent).toContain('10.0 MB');
    expect(document.getElementById('progress-fill')!.style.width).toBe('50%');
  });

  it('reuses the size span across ticks rather than stacking one per event', () => {
    handleLoadProgress(1, 10, 'Kitten TTS Nano');
    handleLoadProgress(5, 10, 'Kitten TTS Nano');
    handleLoadProgress(9, 10, 'Kitten TTS Nano');
    const sizes = document.querySelectorAll('#progress-text .progress-text__size');
    expect(sizes.length).toBe(1);
    expect(document.getElementById('progress-text')!.textContent).toContain('90%');
  });

  it('says what it is doing before the first byte, with no size figure', () => {
    handleLoadProgress(0, 0, 'Kitten TTS Nano');
    const text = document.getElementById('progress-text')!;
    expect(text.textContent).toBe('Contacting huggingface.co for Kitten TTS Nano…');
    expect(text.querySelector('.progress-text__size')).toBeNull();
  });
});

describe('updateVoicePreviewAvailability — auditioning without a download', () => {
  /** One voice card, with a play button, as renderVoiceSection would emit. */
  function voiceGrid(...voiceIds: string[]): void {
    document.body.innerHTML = voiceIds.map(id => `
      <div class="voice-card" data-voice-id="${id}">
        <button class="voice-card__play" data-action="preview"></button>
      </div>`).join('');
  }

  const buttons = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.voice-card__play')];

  beforeEach(() => {
    document.body.innerHTML = '<div id="status-container"></div>';
  });

  it('lets a recorded voice be heard with no model loaded at all', () => {
    // This is the feature. Before the samples existed the only way to hear a
    // voice was to finish downloading a model, so the one choice the app asks
    // a newcomer to make was the one choice that could not be made first.
    voiceGrid('expr-voice-2-f');
    updateVoicePreviewAvailability(stubState(stubEngine(), 'kitten-nano'));
    expect(buttons()[0].hasAttribute('data-blocked')).toBe(false);
  });

  it('still blocks a voice with no recording when the engine is idle', () => {
    // A voice added to a registry without a re-run of the generator must not
    // offer a button that cannot work.
    voiceGrid('a_voice_nobody_recorded');
    updateVoicePreviewAvailability(stubState(stubEngine(), 'kitten-nano'));
    expect(buttons()[0].getAttribute('data-blocked')).toBe('1');
    expect(buttons()[0].title).toMatch(/load the model/i);
  });

  it('unblocks an unrecorded voice once the engine can synthesise', () => {
    voiceGrid('a_voice_nobody_recorded');
    updateVoicePreviewAvailability(stubState(
      stubEngine({ getEngineState: () => 'ready' }), 'kitten-nano'));
    expect(buttons()[0].hasAttribute('data-blocked')).toBe(false);
  });

  it('judges each voice on its own recording, not on a model-wide yes', () => {
    // A single model-wide "has samples" flag would light up every button,
    // including voices that have no clip and no loaded engine behind them.
    voiceGrid('expr-voice-2-f', 'a_voice_nobody_recorded');
    updateVoicePreviewAvailability(stubState(stubEngine(), 'kitten-nano'));
    const [recorded, unrecorded] = buttons();
    expect(recorded.hasAttribute('data-blocked')).toBe(false);
    expect(unrecorded.getAttribute('data-blocked')).toBe('1');
  });
});
