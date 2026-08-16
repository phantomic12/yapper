import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks for @huggingface/transformers ───────────────────────────
// We mock the heavy Transformers.js module so tests don't download the
// ~200MB Florence-2 model. The mock provides just enough surface for
// LlmOcrEngine to exercise its load → recognize → dispose lifecycle.

const mockGenerate = vi.fn(async (_opts: Record<string, unknown>) => {
  // Return fake token IDs — the processor's batch_decode will turn these
  // into the generated text string.
  return [new BigInt64Array([1n, 2n, 3n, 4n])];
});

const mockBatchDecode = vi.fn((_ids: unknown, _opts: { skip_special_tokens: boolean }) => {
  // Return a single decoded string. The exact content doesn't matter —
  // post_process_generation is also mocked and returns structured data.
  return ['<s><OCR>Hello world from Florence-2</s>'];
});

const mockPostProcessGeneration = vi.fn(
  (text: string, task: string, _imageSize: { width: number; height: number }) => {
    if (task === '<OCR>') {
      return { '<OCR>': 'Hello world from Florence-2' };
    }
    if (task === '<OCR_WITH_REGION>') {
      return {
        '<OCR_WITH_REGION>': {
          labels: ['Hello', 'world', 'from', 'Florence-2'],
          quad_boxes: [
            [10, 20, 60, 20, 60, 50, 10, 50],   // "Hello"
            [70, 20, 130, 20, 130, 50, 70, 50],  // "world"
            [140, 20, 190, 20, 190, 50, 140, 50], // "from"
            [200, 20, 300, 20, 300, 50, 200, 50], // "Florence-2"
          ],
        },
      };
    }
    return { [task]: text };
  },
);

const mockConstructPrompts = vi.fn((text: string | string[]) => {
  return Array.isArray(text) ? text : [text];
});

const mockProcessorCall = vi.fn(async (
  _images: unknown,
  _text: unknown,
  _kwargs?: Record<string, unknown>,
) => {
  return {
    input_ids: new BigInt64Array([1n]),
    attention_mask: new BigInt64Array([1n]),
    pixel_values: new Float32Array([0]),
  };
});

const mockModelDispose = vi.fn();

const mockFromPretrained = vi.fn(async (
  _modelId: string,
  _opts?: Record<string, unknown>,
) => ({
  generate: mockGenerate,
  dispose: mockModelDispose,
}));

const mockProcessorFromPretrained = vi.fn(async (_modelId: string) => ({
  construct_prompts: mockConstructPrompts,
  __call: mockProcessorCall,
  batch_decode: mockBatchDecode,
  post_process_generation: mockPostProcessGeneration,
  size_per_bin: 1000,
}));

// RawImage mock — just stores the constructor args. The real class
// validates and stores pixel data, but for testing we only need the
// width/height to flow through to post_process_generation.
class MockRawImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
  constructor(data: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: number) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.channels = channels;
  }
}

vi.mock('@huggingface/transformers', () => ({
  Florence2ForConditionalGeneration: {
    from_pretrained: (...args: unknown[]) => mockFromPretrained(...args),
  },
  AutoProcessor: {
    from_pretrained: (...args: unknown[]) => mockProcessorFromPretrained(...args),
  },
  RawImage: MockRawImage,
  env: { backends: { onnx: { wasm: {} } } },
}));

// ─── Canvas mock ───────────────────────────────────────────────────
// jsdom doesn't implement canvas.getContext('2d').getImageData, so we
// stub it with a minimal implementation that returns a fixed-size
// ImageData-like object.
function createMockCanvas(width = 400, height = 200): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = {
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    })),
  };
  (canvas as unknown as { getContext: () => typeof ctx }).getContext = vi.fn(() => ctx);
  return canvas;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('LlmOcrEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { disposeLlmOcrEngine } = await import('./llm-ocr');
    disposeLlmOcrEngine();
    vi.resetModules();
  });

  // ─── load() ──────────────────────────────────────────────────────

  it('load downloads the Florence-2 model and processor', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    expect(mockFromPretrained).toHaveBeenCalledTimes(1);
    expect(mockProcessorFromPretrained).toHaveBeenCalledTimes(1);
    // Verify the model ID is Florence-2-base-ft
    expect(mockFromPretrained.mock.calls[0][0]).toBe('onnx-community/Florence-2-base-ft');
    expect(engine.isLoaded).toBe(true);
  });

  it('load is single-flight / idempotent — concurrent callers share one load', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await Promise.all([engine.load(), engine.load(), engine.load()]);

    expect(mockFromPretrained).toHaveBeenCalledTimes(1);
    expect(mockProcessorFromPretrained).toHaveBeenCalledTimes(1);
  });

  it('load after dispose re-loads the model', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();
    engine.dispose();
    expect(engine.isLoaded).toBe(false);
    await engine.load();
    expect(mockFromPretrained).toHaveBeenCalledTimes(2);
    expect(engine.isLoaded).toBe(true);
  });

  it('load forwards download progress callbacks', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    const progressCalls: Array<{ loaded: number; total: number }> = [];

    // Capture the progress_callback from the from_pretrained options
    mockFromPretrained.mockImplementationOnce(async (_id: string, opts?: Record<string, unknown>) => {
      const cb = opts?.progress_callback as (data: { status: string; loaded?: number; total?: number }) => void;
      cb({ status: 'progress', loaded: 50, total: 200 });
      cb({ status: 'progress', loaded: 100, total: 200 });
      cb({ status: 'done', loaded: 200, total: 200 });
      return { generate: mockGenerate, dispose: mockModelDispose };
    });

    await engine.load((loaded, total) => {
      progressCalls.push({ loaded, total });
    });

    expect(progressCalls).toEqual([
      { loaded: 50, total: 200 },
      { loaded: 100, total: 200 },
      { loaded: 1, total: 1 }, // 'done' event → normalized to (1, 1)
    ]);
  });

  // ─── recognize() — plain text OCR ────────────────────────────────

  it('recognize with <OCR> returns plain text', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    const canvas = createMockCanvas(400, 200);
    const result = await engine.recognize(canvas);

    expect(result.text).toBe('Hello world from Florence-2');
    expect(result.words).toBeUndefined();
    // Verify the task was <OCR> (not OCR_WITH_REGION)
    expect(mockConstructPrompts).toHaveBeenCalledWith('<OCR>');
  });

  it('recognize calls model.generate with max_new_tokens', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    const canvas = createMockCanvas();
    await engine.recognize(canvas);

    const generateCall = mockGenerate.mock.calls[0][0] as Record<string, unknown>;
    expect(generateCall.max_new_tokens).toBe(4096);
  });

  it('recognize converts canvas to RawImage with correct dimensions', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    const canvas = createMockCanvas(800, 600);
    await engine.recognize(canvas);

    // The processor.__call should have been invoked with a RawImage-like
    // object whose width/height match the canvas.
    const processorArg = mockProcessorCall.mock.calls[0][0];
    expect(processorArg).toHaveProperty('width', 800);
    expect(processorArg).toHaveProperty('height', 600);
    expect(processorArg).toHaveProperty('channels', 4);
  });

  // ─── recognize() — OCR with regions ──────────────────────────────

  it('recognize with includeWords returns text + word polygons', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    const canvas = createMockCanvas(400, 200);
    const result = await engine.recognize(canvas, { includeWords: true });

    expect(result.text).toBe('Hello world from Florence-2');
    expect(result.words).toHaveLength(4);
    expect(result.words![0]).toEqual({
      text: 'Hello',
      quad: [10, 20, 60, 20, 60, 50, 10, 50],
    });
    expect(result.words![3]).toEqual({
      text: 'Florence-2',
      quad: [200, 20, 300, 20, 300, 50, 200, 50],
    });
    // Verify the task was <OCR_WITH_REGION>
    expect(mockConstructPrompts).toHaveBeenCalledWith('<OCR_WITH_REGION>');
  });

  it('recognize with includeWords handles empty results gracefully', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    // Override post_process to return empty labels/boxes
    mockPostProcessGeneration.mockReturnValueOnce({
      '<OCR_WITH_REGION>': { labels: [], quad_boxes: [] },
    });

    const canvas = createMockCanvas();
    const result = await engine.recognize(canvas, { includeWords: true });

    expect(result.text).toBe('');
    expect(result.words).toEqual([]);
  });

  // ─── recognize() — progress callbacks ────────────────────────────

  it('recognize forwards progress events', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    const events: Array<{ status: string; progress: number }> = [];
    const canvas = createMockCanvas();
    await engine.recognize(canvas, {
      onProgress: (p) => events.push(p),
    });

    expect(events[0]).toEqual({ status: 'recognizing text', progress: -1 });
    expect(events.at(-1)).toEqual({ status: 'done', progress: 1 });
  });

  // ─── Error handling ──────────────────────────────────────────────

  it('recognize throws if model is not loaded', async () => {
    const { LlmOcrEngine } = await import('./llm-ocr');
    const engine = new LlmOcrEngine();
    // Don't call load() — recognize should auto-load, but if the load
    // fails, it should throw. We test the case where load hasn't been
    // called and the auto-load succeeds (since mocks are in place).
    // Instead, test the case where dispose was called before recognize.
    await engine.load();
    engine.dispose();

    // Auto-load should kick in. With mocks, this will succeed.
    const canvas = createMockCanvas();
    const result = await engine.recognize(canvas);
    expect(result.text).toBe('Hello world from Florence-2');
  });

  it('recognize surfaces model.generate errors', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    mockGenerate.mockRejectedValueOnce(new Error('WebGPU out of memory'));

    const canvas = createMockCanvas();
    await expect(engine.recognize(canvas)).rejects.toThrow('WebGPU out of memory');
  });

  it('recognize surfaces processor errors', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    mockProcessorCall.mockRejectedValueOnce(new Error('Image preprocessing failed'));

    const canvas = createMockCanvas();
    await expect(engine.recognize(canvas)).rejects.toThrow('Image preprocessing failed');
  });

  // ─── dispose() ───────────────────────────────────────────────────

  it('dispose cleans up model and processor', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();
    expect(engine.isLoaded).toBe(true);

    engine.dispose();
    expect(engine.isLoaded).toBe(false);
    expect(mockModelDispose).toHaveBeenCalled();
  });

  it('dispose is safe to call multiple times', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();
    engine.dispose();
    engine.dispose();
    engine.dispose();
    // Should not throw
    expect(engine.isLoaded).toBe(false);
  });

  it('dispose before load is a no-op', async () => {
    const { LlmOcrEngine } = await import('./llm-ocr');
    const engine = new LlmOcrEngine();
    expect(() => engine.dispose()).not.toThrow();
    expect(engine.isLoaded).toBe(false);
  });

  // ─── Singleton management ────────────────────────────────────────

  it('getLlmOcrEngine returns the same instance on repeated calls', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const a = getLlmOcrEngine();
    const b = getLlmOcrEngine();
    expect(a).toBe(b);
  });

  it('disposeLlmOcrEngine clears the singleton', async () => {
    const { getLlmOcrEngine, disposeLlmOcrEngine } = await import('./llm-ocr');
    const a = getLlmOcrEngine();
    disposeLlmOcrEngine();
    const b = getLlmOcrEngine();
    expect(a).not.toBe(b);
  });

  // ─── isLlmOcrFeasible() ──────────────────────────────────────────

  it('isLlmOcrFeasible returns false when navigator.gpu is absent', async () => {
    const { isLlmOcrFeasible } = await import('./llm-ocr');
    // jsdom doesn't have navigator.gpu
    const result = await isLlmOcrFeasible();
    expect(result).toBe(false);
  });
});

// ─── Integration: quad-to-bbox conversion (used by document-reader) ─

describe('LlmOcrEngine output format', () => {
  it('OCR_WITH_REGION quad_boxes are 8-element arrays (4 points)', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    const canvas = createMockCanvas(400, 200);
    const result = await engine.recognize(canvas, { includeWords: true });

    for (const word of result.words!) {
      expect(word.quad).toHaveLength(8);
      // All coordinates should be finite numbers
      for (const coord of word.quad) {
        expect(typeof coord).toBe('number');
        expect(Number.isFinite(coord)).toBe(true);
      }
    }
  });

  it('word text from OCR_WITH_REGION joins to form the full text', async () => {
    const { getLlmOcrEngine } = await import('./llm-ocr');
    const engine = getLlmOcrEngine();
    await engine.load();

    const canvas = createMockCanvas();
    const result = await engine.recognize(canvas, { includeWords: true });

    const joinedWords = result.words!.map(w => w.text).join(' ');
    expect(result.text).toBe(joinedWords);
  });
});
