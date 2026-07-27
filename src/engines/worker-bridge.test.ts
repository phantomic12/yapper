import { describe, expect, it } from 'vitest';
import { createDisposeRequest, createGenerateRequest, createLoadRequest } from './worker-bridge';
import type { TTSModel } from '../engine';

const model = { id: 'x', modelId: 'm', name: 'Model', description: '', category: 'fast', custom: true } as TTSModel;

describe('worker protocol', () => {
  it('encodes load, generate, and dispose requests', () => {
    expect(createLoadRequest(model)).toEqual({ type: 'load', model });
    expect(createGenerateRequest(model, 'voice', 'hello', 1.25)).toEqual({ type: 'generate', model, voiceId: 'voice', text: 'hello', speed: 1.25 });
    expect(createDisposeRequest()).toEqual({ type: 'dispose' });
  });
});
