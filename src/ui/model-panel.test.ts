import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureModelLoaded } from './model-panel';
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
