import { describe, it, expect } from 'vitest';
import { KITTEN_VOICES, parseNpy, parseNpz } from './kitten';
import { MODELS } from '../engine';

// ─── .npy file builder (v1 format, the one Kitten uses) ──────────────
// Reference: https://numpy.org/doc/stable/reference/generated/numpy.lib.format.html
function buildNpy(arr: Float32Array, shape: number[]): ArrayBuffer {
  const shapeStr = `(${shape.join(',')}${shape.length === 1 ? ',' : ''})`;
  const headerDict = `{'descr': '<f4', 'fortran_order': False, 'shape': ${shapeStr}, }`;
  // Pad header to a multiple of 64 bytes (NumPy requirement) plus 1 for the trailing \n
  let header = headerDict + '\n';
  while ((header.length + 10) % 64 !== 0) header += ' ';
  header += '\n';
  const headerLen = header.length;
  // v1 header: magic (6) + version (2) + headerLen (2) + header + data
  const totalLen = 10 + headerLen + arr.byteLength;
  const buf = new ArrayBuffer(totalLen);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // Magic
  bytes.set([0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59], 0);
  // Version 1.0
  view.setUint8(6, 1);
  view.setUint8(7, 0);
  // Header length
  view.setUint16(8, headerLen, true);
  // Header bytes
  for (let i = 0; i < headerLen; i++) bytes[10 + i] = header.charCodeAt(i);
  // Data
  const dataBytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  bytes.set(dataBytes, 10 + headerLen);
  return buf;
}

function buildNpz(arrays: Record<string, { data: Float32Array; shape: number[] }>): ArrayBuffer {
  // Use fflate's zipSync (same module kitten.ts already imports) to avoid
  // pulling in another zip library in the test. We import lazily.
  // We construct the zip via the CompressionStream Web API where available
  // (jsdom 22+ has it). For wider compatibility, fall back to a minimal
  // uncompressed-zip writer.
  return buildNpzRaw(arrays);
}

// Minimal uncompressed-zip writer. NumPy .npz files are STORED (no compression)
// so this is exactly what numpy.lib.format produces.
function buildNpzRaw(arrays: Record<string, { data: Float32Array; shape: number[] }>): ArrayBuffer {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  for (const [name, { data, shape }] of Object.entries(arrays)) {
    const npyBuf = buildNpy(data, shape);
    const npyBytes = new Uint8Array(npyBuf);
    const nameBytes = new TextEncoder().encode(name + '.npy');
    const crc = crc32(npyBytes);
    const size = npyBytes.length;

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);     // local file header signature
    lv.setUint16(4, 20, true);             // version needed
    lv.setUint16(6, 0, true);              // flags
    lv.setUint16(8, 0, true);              // compression: stored
    lv.setUint16(10, 0, true);             // mod time
    lv.setUint16(12, 0, true);             // mod date
    lv.setUint32(14, crc, true);           // crc-32
    lv.setUint32(18, size, true);          // compressed size
    lv.setUint32(22, size, true);          // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);             // extra length
    local.set(nameBytes, 30);
    localChunks.push(local, npyBytes);

    // Central directory entry
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);     // central dir signature
    cv.setUint16(4, 20, true);             // version made by
    cv.setUint16(6, 20, true);             // version needed
    cv.setUint16(8, 0, true);              // flags
    cv.setUint16(10, 0, true);             // compression
    cv.setUint16(12, 0, true);             // mod time
    cv.setUint16(14, 0, true);             // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);             // extra
    cv.setUint16(32, 0, true);             // comment
    cv.setUint16(34, 0, true);             // disk
    cv.setUint16(36, 0, true);             // internal attrs
    cv.setUint32(38, 0, true);             // external attrs
    cv.setUint32(42, offset, true);        // local header offset
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + npyBytes.length;
  }
  const localSize = offset;
  const centralStart = offset;

  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);                // disk
  ev.setUint16(6, 0, true);                // central dir disk
  ev.setUint16(8, centralChunks.length, true);
  ev.setUint16(10, centralChunks.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);               // comment length

  const total = localSize + centralSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of localChunks) { out.set(c, pos); pos += c.length; }
  for (const c of centralChunks) { out.set(c, pos); pos += c.length; }
  out.set(eocd, pos);
  return out.buffer;
}

// CRC-32 (poly 0xEDB88320) — required for valid zip central directory entries.
function crc32(bytes: Uint8Array): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : (c >>> 1);
    }
    table[n] = c;
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

describe('parseNpy', () => {
  it('parses a 1D float32 array', () => {
    const data = new Float32Array([1, 2, 3, 4, 5]);
    const buf = buildNpy(data, [5]);
    const { shape, data: out } = parseNpy(buf);
    expect(shape).toEqual([5]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses a 2D float32 array (row-major)', () => {
    // 3×2 matrix [[1,2],[3,4],[5,6]]
    const data = new Float32Array([1, 2, 3, 4, 5, 6]);
    const buf = buildNpy(data, [3, 2]);
    const { shape, data: out } = parseNpy(buf);
    expect(shape).toEqual([3, 2]);
    expect(out.length).toBe(6);
    // The first 2 floats are row 0, next 2 are row 1, etc.
    expect(out.slice(0, 2)).toEqual(new Float32Array([1, 2]));
    expect(out.slice(2, 4)).toEqual(new Float32Array([3, 4]));
  });

  it('parses the (400, 256) Kitten voice bank shape', () => {
    const N = 400 * 256;
    const data = new Float32Array(N);
    for (let i = 0; i < N; i++) data[i] = i / N;
    const buf = buildNpy(data, [400, 256]);
    const { shape, data: out } = parseNpy(buf);
    expect(shape).toEqual([400, 256]);
    expect(out.length).toBe(N);
    // First 256-dim style vector (what Kitten uses) should be normalized in [0, 1)
    const first256 = out.slice(0, 256);
    for (let i = 0; i < 256; i++) {
      expect(first256[i]).toBeGreaterThanOrEqual(0);
      expect(first256[i]).toBeLessThan(1);
    }
  });

  it('rejects a file without the NUMPY magic header', () => {
    const buf = new ArrayBuffer(20);
    expect(() => parseNpy(buf)).toThrow(/bad magic/);
  });
});

describe('parseNpz', () => {
  it('decodes a multi-entry npz into {name → Float32Array}', () => {
    const v1 = new Float32Array([1, 2, 3]);
    const v2 = new Float32Array([10, 20, 30, 40]);
    const buf = buildNpz({
      voice_a: { data: v1, shape: [3] },
      voice_b: { data: v2, shape: [4] },
    });
    const out = parseNpz(buf);
    expect(Object.keys(out).sort()).toEqual(['voice_a', 'voice_b']);
    expect(Array.from(out.voice_a)).toEqual([1, 2, 3]);
    expect(Array.from(out.voice_b)).toEqual([10, 20, 30, 40]);
  });

  it('strips the .npy suffix from entry names', () => {
    const v = new Float32Array([42]);
    const buf = buildNpz({ expr_voice_2_m: { data: v, shape: [1] } });
    const out = parseNpz(buf);
    // Entry key = filename minus `.npy` (zip member name is `expr_voice_2_m.npy`)
    expect(out['expr_voice_2_m']).toBeDefined();
    expect(Array.from(out['expr_voice_2_m'])).toEqual([42]);
  });

  it('returns an empty object for an empty zip', () => {
    // Empty zip: just EOCD record.
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 0, true);
    ev.setUint16(10, 0, true);
    ev.setUint32(12, 0, true);
    ev.setUint32(16, 0, true);
    const out = parseNpz(eocd.buffer);
    expect(out).toEqual({});
  });
});

describe('KITTEN_VOICES registry integration', () => {
  // The MODELS registry now imports KITTEN_VOICES for both kitten-nano
  // and kitten-mini. This test guards against a future change that
  // accidentally re-introduces per-model voice duplication, which would
  // drift away from the actual voice bank shipped in voices.npz.
  it('contains the 8 expected voice IDs', () => {
    expect(KITTEN_VOICES.map(v => v.id)).toEqual([
      'expr-voice-2-m', 'expr-voice-2-f',
      'expr-voice-3-m', 'expr-voice-3-f',
      'expr-voice-4-m', 'expr-voice-4-f',
      'expr-voice-5-m', 'expr-voice-5-f',
    ]);
  });

  it('every voice entry has a name', () => {
    for (const v of KITTEN_VOICES) {
      expect(v.name, `voice ${v.id} missing a display name`).toBeTruthy();
    }
  });

  it('kitten-nano and kitten-mini in MODELS share the KITTEN_VOICES reference', () => {
    // Identity check: === so we know the engine.ts entries import the
    // same array, not a hand-copied duplicate with the same contents.
    const nano = MODELS.find(m => m.id === 'kitten-nano');
    const mini = MODELS.find(m => m.id === 'kitten-mini');
    expect(nano?.voices).toBe(mini?.voices);
    expect(nano?.voices).toBe(KITTEN_VOICES);
  });
});