import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KokoroCustomEngine, splitSentences } from './kokoro';
import type { TTSModel } from '../engine';

// ─── Mock @huggingface/transformers ───────────────────────────────
// KokoroCustomEngine builds the Kokoro pipeline directly on the app's own
// transformers install (see the history note at the top of kokoro.ts for why
// kokoro-js is no longer used). The mock mirrors the pieces the engine calls:
// StyleTextToSpeech2Model.from_pretrained → a callable model that resolves
// {waveform:{data}}, AutoTokenizer.from_pretrained → a callable tokenizer
// that resolves {input_ids:{dims}}, Tensor → a plain class, and env.backends
// .onnx.wasm.wasmPaths so the wasmPaths test can assert on it.

const modelFnMock = vi.hoisted(() => vi.fn());
const fromPretrainedModel = vi.hoisted(() => vi.fn());
const tokenizerFnMock = vi.hoisted(() => vi.fn());
const fromPretrainedTokenizer = vi.hoisted(() => vi.fn());
const phonemizeMock = vi.hoisted(() => vi.fn());
const hasF16Mock = vi.hoisted(() => vi.fn());

const envMock = vi.hoisted(() => ({
  backends: { onnx: { wasm: { wasmPaths: undefined as string | undefined } } },
}));

const TensorMock = vi.hoisted(() => class MockTensor {
  constructor(public type: string, public data: unknown, public dims: number[]) {}
});

vi.mock('@huggingface/transformers', () => ({
  env: envMock,
  Tensor: TensorMock,
  StyleTextToSpeech2Model: { from_pretrained: fromPretrainedModel },
  AutoTokenizer: { from_pretrained: fromPretrainedTokenizer },
}));

vi.mock('phonemizer', () => ({ phonemize: phonemizeMock }));

vi.mock('../capability', () => ({
  webgpuAdapterHasFeature: hasF16Mock,
}));

function makeModel(): TTSModel {
  return {
    id: 'kokoro-82m',
    name: 'Kokoro-82M (int8)',
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    description: '',
    category: 'premium',
    sampleRate: 24000,
    dtype: 'q8',
    custom: true,
  };
}

/** A one-sentence audio result from the model mock. */
function wave(samples: number): { waveform: { data: Float32Array } } {
  return { waveform: { data: new Float32Array(samples) } };
}

describe('KokoroCustomEngine — load', () => {
  beforeEach(() => {
    modelFnMock.mockReset();
    fromPretrainedModel.mockReset();
    tokenizerFnMock.mockReset();
    fromPretrainedTokenizer.mockReset();
    phonemizeMock.mockReset();
    hasF16Mock.mockReset();
    envMock.backends.onnx.wasm.wasmPaths = undefined;
    // Tokenizer mock: dims = phones length + BOS/EOS pair.
    tokenizerFnMock.mockImplementation((phones: string) => ({
      input_ids: { dims: [phones.length + 2] },
    }));
    fromPretrainedTokenizer.mockResolvedValue(tokenizerFnMock);
    fromPretrainedModel.mockResolvedValue(modelFnMock);
  });

  it('points the pipeline at the locally-served ORT runtime, not a CDN', async () => {
    // engine.ts sets wasmPaths for the main thread; the inference worker's
    // module graph doesn't include engine.ts, so the engine must set it too.
    // Kokoro sessions are created in this same transformers instance.
    const engine = new KokoroCustomEngine();
    await engine.load(makeModel());
    expect(envMock.backends.onnx.wasm.wasmPaths).toBe('/ort-wasm/');
  });

  it('forces WebGPU when the adapter has shader-f16', async () => {
    hasF16Mock.mockResolvedValue(true);
    const engine = new KokoroCustomEngine();
    await engine.load(makeModel());
    expect(fromPretrainedModel).toHaveBeenCalledTimes(1);
    expect(fromPretrainedModel.mock.calls[0][1].device).toBe('webgpu');
  });

  it('pins WASM (device undefined) when the adapter lacks shader-f16', async () => {
    hasF16Mock.mockResolvedValue(false);
    const engine = new KokoroCustomEngine();
    await engine.load(makeModel());
    expect(fromPretrainedModel).toHaveBeenCalledTimes(1);
    expect(fromPretrainedModel.mock.calls[0][1].device).toBeUndefined();
  });

  it('retries on WASM when the WebGPU session fails to create', async () => {
    // from_pretrained creates the ORT session, so a GPU failure surfaces
    // here. The load must degrade to the working CPU path instead of
    // failing the whole model.
    hasF16Mock.mockResolvedValue(true);
    fromPretrainedModel
      .mockRejectedValueOnce(new Error('WebGPU validation failed'))
      .mockResolvedValueOnce(modelFnMock);
    const engine = new KokoroCustomEngine();
    await expect(engine.load(makeModel())).resolves.toEqual({ sampleRate: 24000 });
    expect(fromPretrainedModel).toHaveBeenCalledTimes(2);
    expect(fromPretrainedModel.mock.calls[0][1].device).toBe('webgpu');
    expect(fromPretrainedModel.mock.calls[1][1].device).toBeUndefined();
  });

  it('does not retry a WASM load failure (nothing to fall back to)', async () => {
    hasF16Mock.mockResolvedValue(false);
    fromPretrainedModel.mockRejectedValue(new Error('network down'));
    const engine = new KokoroCustomEngine();
    await expect(engine.load(makeModel())).rejects.toThrow('network down');
    expect(fromPretrainedModel).toHaveBeenCalledTimes(1);
  });
});

describe('KokoroCustomEngine — segment progress', () => {
  let engine: KokoroCustomEngine;

  beforeEach(async () => {
    modelFnMock.mockReset();
    fromPretrainedModel.mockReset();
    tokenizerFnMock.mockReset();
    fromPretrainedTokenizer.mockReset();
    phonemizeMock.mockReset();
    hasF16Mock.mockReset();
    envMock.backends.onnx.wasm.wasmPaths = undefined;
    tokenizerFnMock.mockImplementation((phones: string) => ({
      input_ids: { dims: [phones.length + 2] },
    }));
    fromPretrainedTokenizer.mockResolvedValue(tokenizerFnMock);
    fromPretrainedModel.mockResolvedValue(modelFnMock);
    hasF16Mock.mockResolvedValue(false);
    phonemizeMock.mockResolvedValue(['hˈɛloʊ']);
    // Voice style bank fetch: 510 × 256 float32.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(510 * 256 * 4),
    })));

    engine = new KokoroCustomEngine();
    await engine.load(makeModel());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const seg = (samples: number): number => samples;

  it('emits one progress callback per sentence with running counts', async () => {
    // Two sentences: 24000 samples = 1s of audio each.
    phonemizeMock.mockResolvedValue(['hˈɛloʊ wˈɜːld']);
    modelFnMock.mockImplementation(() => Promise.resolve(wave(seg(24000))));

    const onSegmentProgress = vi.fn();
    await engine.generate(
      makeModel(),
      'af_heart',
      'Hello world. Second sentence here.',
      { onSegmentProgress },
    );

    expect(onSegmentProgress).toHaveBeenCalledTimes(2);
    expect(onSegmentProgress).toHaveBeenNthCalledWith(1, {
      segmentsDone: 1,
      audioSecondsSoFar: 1,
    });
    expect(onSegmentProgress).toHaveBeenNthCalledWith(2, {
      segmentsDone: 2,
      audioSecondsSoFar: 2,
    });
  });

  it('reports fractional accumulated audio seconds across uneven segments', async () => {
    phonemizeMock.mockResolvedValue(['ɐ']);
    const sizes = [12000, 36000]; // 0.5s, then 1.5s → cumulative 2.0s
    let calls = 0;
    modelFnMock.mockImplementation(() => Promise.resolve(wave(seg(sizes[calls++]))));

    const onSegmentProgress = vi.fn();
    await engine.generate(
      makeModel(),
      'af_heart',
      'Short. A considerably longer second sentence.',
      { onSegmentProgress },
    );

    expect(onSegmentProgress).toHaveBeenNthCalledWith(1, {
      segmentsDone: 1,
      audioSecondsSoFar: 0.5,
    });
    expect(onSegmentProgress).toHaveBeenNthCalledWith(2, {
      segmentsDone: 2,
      audioSecondsSoFar: 2.0,
    });
  });

  it('still returns stitched audio and word timings alongside progress', async () => {
    phonemizeMock.mockResolvedValue(['wʌns tuː']);
    let calls = 0;
    const sizes = [24000, 48000];
    modelFnMock.mockImplementation(() => Promise.resolve(wave(seg(sizes[calls++]))));

    const out = await engine.generate(makeModel(), 'af_heart', 'One two. Three four five.');
    expect(out.samplingRate).toBe(24000);
    expect(out.audio.length).toBe(72000); // 24000 + 48000 stitched
    expect(out.wordTimings).toBeDefined();
    expect(out.wordTimings!.length).toBeGreaterThanOrEqual(2);
  });

  it('does not invoke the callback when no callback is provided', async () => {
    phonemizeMock.mockResolvedValue(['x']);
    modelFnMock.mockImplementation(() => Promise.resolve(wave(seg(24000))));
  });

  it('works when a segment yields zero phonemes (progress still fires)', async () => {
    // A sentence that phonemizes to nothing still runs the model (BOS/EOS
    // only), still produces audio, and still reports progress — parity with
    // the old kokoro-js streaming behavior.
    phonemizeMock.mockImplementation(
      (input: string) => Promise.resolve(input.includes('silent') ? [''] : ['z']),
    );
    modelFnMock.mockImplementation(() => Promise.resolve(wave(seg(24000))));

    const onSegmentProgress = vi.fn();
    await engine.generate(
      makeModel(),
      'af_heart',
      'Loud sentence. Silent sentence.',
      { onSegmentProgress },
    );
    expect(onSegmentProgress).toHaveBeenCalledTimes(2);
    expect(onSegmentProgress).toHaveBeenLastCalledWith({
      segmentsDone: 2,
      audioSecondsSoFar: 2,
    });
  });

  it('rejects an unknown voice', async () => {
    await expect(
      engine.generate(makeModel(), 'no-such-voice', 'Hello.'),
    ).rejects.toThrow('Unknown voice: no-such-voice');
  });
});

// ─── splitSentences ───────────────────────────────────────────────
// The splitter is what decides where one sentence ends and the next
// begins, which is what the per-segment progress and word timings in the
// job card are built on. A regression here would not throw — it would
// quietly shatter "3.14" into two segments or glue two paragraphs into
// one — so the behaviour is pinned directly.
describe('splitSentences', () => {
  it('splits plain sentences and trims each one', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('keeps a decimal inside its sentence', () => {
    // The period in 3.14 is not followed by whitespace, so it cannot end a
    // sentence — "Pi is 3.14." must be one segment, not two.
    expect(splitSentences('Pi is 3.14. That is all.')).toEqual([
      'Pi is 3.14.',
      'That is all.',
    ]);
  });

  it('keeps a closing quote or bracket attached to the sentence it closes', () => {
    expect(splitSentences('He said "stop." Then he left.')).toEqual([
      'He said "stop."',
      'Then he left.',
    ]);
    expect(splitSentences('Really (yes.) No.')).toEqual(['Really (yes.)', 'No.']);
  });

  it('does not split on commas or colons mid-sentence', () => {
    expect(splitSentences('First, second; and third: all one run.')).toEqual([
      'First, second; and third: all one run.',
    ]);
  });

  it('treats a newline as a boundary', () => {
    expect(splitSentences('Line one\nLine two\n\nLine three')).toEqual([
      'Line one',
      'Line two',
      'Line three',
    ]);
  });

  it('collapses an ellipsis into a single boundary', () => {
    expect(splitSentences('Wait... what?')).toEqual(['Wait...', 'what?']);
  });

  it('keeps an unterminated trailing fragment', () => {
    // A user who is still typing has no final period. Dropping the tail
    // would silently lose their words.
    expect(splitSentences('Done. Still typing')).toEqual(['Done.', 'Still typing']);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });

  it('does not split a single word lacking terminal punctuation', () => {
    expect(splitSentences('Hello')).toEqual(['Hello']);
  });

  it('splits an abbreviation, which is the documented trade-off', () => {
    // Deliberately NOT abbreviation-aware (see the comment above the regex):
    // kokoro-js carries a heavier heuristic that is not worth reproducing.
    // The cost is an occasional extra pause at the seam, never a lost or
    // reordered sentence. Pinned so the trade-off stays a decision rather
    // than drifting into a bug nobody notices.
    expect(splitSentences('Dr. Smith went home.')).toEqual([
      'Dr.',
      'Smith went home.',
    ]);
  });
});
