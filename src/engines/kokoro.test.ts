import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KokoroCustomEngine } from './kokoro';
import type { TTSModel } from '../engine';

// ─── Mock kokoro-js module ────────────────────────────────────────
// KokoroCustomEngine lazily `import('kokoro-js')`es. vi.mock intercepts
// that dynamic import so we can drive the stream() generator ourselves.

type Segment = {
  text: string;
  phonemes: string;
  audio: { audio: Float32Array; sampling_rate?: number };
};

const streamMock = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: vi.fn(async () => ({
      stream: streamMock.fn,
    })),
  },
}));

function makeModel(): TTSModel {
  return {
    id: 'kokoro-82m',
    name: 'Kokoro-82M (q8f16)',
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    description: '',
    category: 'premium',
    sampleRate: 24000,
    dtype: 'q8',
    custom: true,
  };
}

/** Async iterable from an array of segments (mirrors kokoro-js stream()). */
function streamOf(segments: Segment[]) {
  return async function* () {
    for (const s of segments) yield s;
  };
}

describe('KokoroCustomEngine — segment progress', () => {
  let engine: KokoroCustomEngine;

  beforeEach(async () => {
    streamMock.fn = vi.fn();
    engine = new KokoroCustomEngine();
    await engine.load(makeModel());
  });

  const seg = (phonemes: string, samples: number): Segment => ({
    text: 'sentence',
    phonemes,
    audio: { audio: new Float32Array(samples), sampling_rate: 24000 },
  });

  it('emits one progress callback per streamed segment with running counts', async () => {
    // Two sentences: 24000 samples = 1s of audio each.
    streamMock.fn.mockImplementation(() =>
      streamOf([seg('hˈɛloʊ', 24000), seg('wˈɜːld', 24000)])(),
    );

    const onSegmentProgress = vi.fn();
    await engine.generate(makeModel(), 'af_heart', 'Hello world.', { onSegmentProgress });

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
    streamMock.fn.mockImplementation(() =>
      streamOf([
        seg('a', 12000),           // 0.5s
        seg('b', 36000),           // 1.5s → cumulative 2.0s
      ])(),
    );

    const onSegmentProgress = vi.fn();
    await engine.generate(makeModel(), 'af_heart', 'Two sentences here.', { onSegmentProgress });

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
    streamMock.fn.mockImplementation(() =>
      streamOf([
        seg('wʌns', 24000),
        seg('tuː', 48000),
      ])(),
    );

    const out = await engine.generate(makeModel(), 'af_heart', 'One two.');
    expect(out.samplingRate).toBe(24000);
    expect(out.audio.length).toBe(72000); // 24000 + 48000 stitched
    expect(out.wordTimings).toBeDefined();
    expect(out.wordTimings!.length).toBeGreaterThanOrEqual(2);
  });

  it('does not invoke the callback when no callback is provided', async () => {
    streamMock.fn.mockImplementation(() =>
      streamOf([seg('x', 24000), seg('y', 24000)])(),
    );
    await expect(
      engine.generate(makeModel(), 'af_heart', 'No callback.'),
    ).resolves.toBeDefined();
  });

  it('works when a segment yields zero phonemes (progress still fires)', async () => {
    streamMock.fn.mockImplementation(() =>
      streamOf([
        seg('', 24000),   // phonemeCount === 0 → skipped for word timing
        seg('z', 24000),
      ])(),
    );

    const onSegmentProgress = vi.fn();
    await engine.generate(makeModel(), 'af_heart', 'Edge case.', { onSegmentProgress });
    expect(onSegmentProgress).toHaveBeenCalledTimes(2);
    expect(onSegmentProgress).toHaveBeenLastCalledWith({
      segmentsDone: 2,
      audioSecondsSoFar: 2,
    });
  });
});
