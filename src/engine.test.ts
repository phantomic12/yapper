import { describe, it, expect } from 'vitest';
import { float32ToWav, changeSpeed, MODELS } from './engine';
import { KOKORO_VOICES } from './engines/kokoro';

describe('float32ToWav', () => {
  it('produces a RIFF/WAVE header for a mono 16-bit PCM blob', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1.0, -1.0, 0]);
    const blob = float32ToWav(samples, 24000);
    expect(blob.type).toBe('audio/wav');
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);

    // "RIFF"
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    // "WAVE"
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
    // "fmt "
    expect(String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15))).toBe('fmt ');
    // "data"
    expect(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39))).toBe('data');

    // fmt chunk: PCM (1), mono (1), sample rate matches input
    expect(view.getUint16(20, true)).toBe(1);            // PCM
    expect(view.getUint16(22, true)).toBe(1);            // mono
    expect(view.getUint32(24, true)).toBe(24000);        // sample rate
    expect(view.getUint16(34, true)).toBe(16);           // bits per sample

    // data chunk length = samples * 2 bytes
    expect(view.getUint32(40, true)).toBe(samples.length * 2);

    // Total size = 44 (header) + samples * 2
    expect(buf.byteLength).toBe(44 + samples.length * 2);
  });

  it('clamps values outside [-1, 1] without NaN-injection', async () => {
    const samples = new Float32Array([2.5, -3.0, NaN, 1.0]);
    const blob = float32ToWav(samples, 16000);
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    // First sample: clamped to 1.0 → 0x7FFF
    expect(view.getInt16(44, true)).toBe(0x7FFF);
    // Second: clamped to -1.0 → -0x8000
    expect(view.getInt16(46, true)).toBe(-0x8000);
    // NaN: Math.max(-1, Math.min(1, NaN)) === NaN, but setInt16 coerces NaN to 0
    expect(view.getInt16(48, true)).toBe(0);
  });

  it('rounds peak values instead of truncating (avoids 3dB loss near ±1)', async () => {
    // Quantization is asymmetric on the 0x8000 / 0x7FFF boundary because
    // the positive side has one fewer representable value. Without
    // Math.round the prior implementation truncated to ±32765/32766.
    // 0.99998 * 0x7FFF = 32766.34  → rounds to 32766
    // -0.99998 * 0x8000 = -32766.66 → rounds to -32767
    // For ±1.0 the result is exactly ±32767 / -32768.
    const samples = new Float32Array([-0.99998, 0.99998, 1.0, -1.0]);
    const blob = float32ToWav(samples, 16000);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getInt16(44, true)).toBe(-32767);  // rounded
    expect(view.getInt16(46, true)).toBe(32766);   // rounded
    expect(view.getInt16(48, true)).toBe(32767);   // exact peak
    expect(view.getInt16(50, true)).toBe(-32768);  // exact negative peak
  });

  it('handles an empty buffer', async () => {
    const blob = float32ToWav(new Float32Array(0), 16000);
    const buf = await blob.arrayBuffer();
    expect(buf.byteLength).toBe(44); // header only
  });
});

describe('changeSpeed', () => {
  const linear = (n: number, from: number, to: number) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = from + (to - from) * (i / (n - 1));
    return out;
  };

  it('returns the same array when speed is 1.0', () => {
    const a = new Float32Array([1, 2, 3, 4]);
    const b = changeSpeed(a, 1.0);
    expect(b).toBe(a);
  });

  it('returns the same array when speed is 0 or negative', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(changeSpeed(a, 0)).toBe(a);
    expect(changeSpeed(a, -1)).toBe(a);
  });

  it('halves the length at speed 2.0 (audio plays 2x faster)', () => {
    const a = linear(1000, 0, 1);
    const b = changeSpeed(a, 2.0);
    expect(b.length).toBe(500);
    // First sample is exactly preserved; last sample is interpolated between
    // the last two inputs (within ε since the source ends at 1.0).
    expect(b[0]).toBeCloseTo(0, 5);
    expect(b[b.length - 1]).toBeGreaterThan(0.99);
  });

  it('roughly doubles the length at speed 0.5', () => {
    const a = linear(100, 0, 1);
    const b = changeSpeed(a, 0.5);
    expect(b.length).toBe(200);
    expect(b[0]).toBeCloseTo(0, 5);
    expect(b[b.length - 1]).toBeGreaterThan(0.99);
  });

  it('preserves a constant signal regardless of speed', () => {
    const a = new Float32Array(100).fill(0.7);
    const b = changeSpeed(a, 1.7);
    for (let i = 0; i < b.length; i++) {
      expect(b[i]).toBeCloseTo(0.7, 5);
    }
  });
});

describe('MODELS registry', () => {
  it('contains unique model IDs', () => {
    const ids = MODELS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every model has a non-empty name and modelId', () => {
    for (const m of MODELS) {
      expect(m.name).toBeTruthy();
      expect(m.modelId).toBeTruthy();
    }
  });

  it('voices have unique IDs within each model', () => {
    for (const m of MODELS) {
      if (!m.voices?.length) continue;
      const ids = m.voices.map(v => v.id);
      expect(new Set(ids).size, `Duplicate voices in ${m.id}`).toBe(ids.length);
    }
  });

  it('defaultVoiceId (if set) actually exists in the voices list', () => {
    for (const m of MODELS) {
      if (!m.defaultVoiceId) continue;
      const found = m.voices?.some(v => v.id === m.defaultVoiceId);
      expect(found, `${m.id}: defaultVoiceId ${m.defaultVoiceId} not in voices`).toBe(true);
    }
  });

  it('kokoro model entries expose the full KOKORO_VOICES list', () => {
    const kokoros = MODELS.filter(m => m.id.startsWith('kokoro'));
    expect(kokoros.length).toBeGreaterThanOrEqual(2);
    for (const m of kokoros) {
      expect(m.voices, m.id).toBe(KOKORO_VOICES);
      expect(m.voices?.length).toBe(28);
      expect(m.defaultVoiceId).toBe('af_heart');
    }
  });
});