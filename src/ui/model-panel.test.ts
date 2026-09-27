import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureModelLoaded, handleLoadProgress } from './model-panel';
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
