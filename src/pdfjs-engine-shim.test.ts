import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The shim exists for engines that lack the built-ins, so the only way to
 * test it is to take them away first: Node 24 (and current Chrome) has them
 * natively, and a test that runs against the native methods proves nothing.
 *
 * Everything is restored afterwards — vitest itself runs on these globals.
 */

const TARGETS: Array<[object, string]> = [
  [Map.prototype, 'getOrInsert'],
  [Map.prototype, 'getOrInsertComputed'],
  [Set.prototype, 'getOrInsert'],
  [Set.prototype, 'getOrInsertComputed'],
  [Uint8Array.prototype, 'toHex'],
  [Uint8Array.prototype, 'toBase64'],
  [Uint8Array, 'fromHex'],
  [Uint8Array, 'fromBase64'],
];

const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(async () => {
  for (const [target, key] of TARGETS) {
    saved.set(key, Object.getOwnPropertyDescriptor(target, key));
    delete (target as Record<string, unknown>)[key];
  }
  // Re-import fresh so the shim's feature checks see the missing methods.
  await import('./pdfjs-engine-shim.js');
});

afterAll(() => {
  for (const [target, key] of TARGETS) {
    const desc = saved.get(key);
    if (desc) Object.defineProperty(target, key, desc);
  }
});

describe('pdfjs engine shim', () => {
  it('fills in the methods pdfjs calls without a feature check', () => {
    expect(typeof Map.prototype.getOrInsert).toBe('function');
    expect(typeof Map.prototype.getOrInsertComputed).toBe('function');
    expect(typeof Set.prototype.getOrInsert).toBe('function');
    expect(typeof Set.prototype.getOrInsertComputed).toBe('function');
    expect(typeof Uint8Array.prototype.toHex).toBe('function');
    expect(typeof Uint8Array.prototype.toBase64).toBe('function');
    expect(typeof Uint8Array.fromHex).toBe('function');
    expect(typeof Uint8Array.fromBase64).toBe('function');
  });

  it('Map.getOrInsert keeps an existing value, including a stored undefined', () => {
    const m = new Map<string, number | undefined>([['a', 1]]);
    expect(m.getOrInsert('a', 9)).toBe(1);
    expect(m.getOrInsert('b', 2)).toBe(2);
    expect(m.get('b')).toBe(2);
    expect(m.size).toBe(2);

    const withUndefined = new Map<string, number | undefined>();
    withUndefined.set('k', undefined);
    // "has", not "get": a key present with an undefined value is present.
    expect(withUndefined.getOrInsert('k', 5)).toBeUndefined();
    expect(withUndefined.size).toBe(1);
  });

  it('Map.getOrInsertComputed computes only for absent keys', () => {
    let calls = 0;
    const m = new Map<string, number>([['a', 1]]);
    const compute = (k: string) => { calls++; return k.length; };
    expect(m.getOrInsertComputed('a', compute)).toBe(1);
    expect(calls).toBe(0);
    expect(m.getOrInsertComputed('bbb', compute)).toBe(3);
    expect(calls).toBe(1);
  });

  it('a throwing getOrInsertComputed leaves the map untouched', () => {
    const m = new Map<string, number>();
    expect(() => m.getOrInsertComputed('x', () => { throw new Error('boom'); })).toThrow('boom');
    expect(m.size).toBe(0);
  });

  it('Set.getOrInsert adds once and chains', () => {
    const s = new Set<string>();
    expect(s.getOrInsert('x')).toBe(s);
    expect(s.getOrInsert('x')).toBe(s);
    expect(s.size).toBe(1);
    expect(s.getOrInsertComputed('y')).toBe(s);
    expect([...s]).toEqual(['x', 'y']);
  });

  it('toHex is lowercase, zero-padded, and empty-safe', () => {
    expect(new Uint8Array([0x00, 0x0f, 0xa5, 0xff]).toHex()).toBe('000fa5ff');
    expect(new Uint8Array().toHex()).toBe('');
    expect(new Uint8Array([0xde, 0xad, 0xbe, 0xef]).toHex()).toBe('deadbeef');
  });

  it('toHex handles a length past the String.fromCharCode chunk size', () => {
    const big = new Uint8Array(0x8000 * 2 + 5);
    big.fill(0xab);
    const hex = big.toHex();
    expect(hex.length).toBe(big.length * 2);
    expect(hex.slice(0, 8)).toBe('abababab');
    expect(hex.endsWith('abababab')).toBe(true);
  });

  it('fromHex parses and rejects bad input', () => {
    expect([...Uint8Array.fromHex('00ff10')]).toEqual([0, 255, 16]);
    expect(Uint8Array.fromHex('').length).toBe(0);
    expect(() => Uint8Array.fromHex('abc')).toThrow(/odd length/);
    expect(() => Uint8Array.fromHex('zz')).toThrow(/non-hexadecimal/);
  });

  it('base64 round-trips through the shim, including high bytes', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 255, 65, 66, 67]);
    const b64 = bytes.toBase64();
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect([...Uint8Array.fromBase64(b64)]).toEqual([...bytes]);
    expect(Uint8Array.fromBase64('').length).toBe(0);
  });

  it('does not replace a native implementation when one exists', async () => {
    // The shim is conditional on purpose: on a current engine it must not
    // touch the spec-compliant, faster built-ins.
    const native = Uint8Array.prototype.toHex;
    const saved2 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex')!;
    await import('./pdfjs-engine-shim.js?already-native');
    const after = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex')!;
    expect(after.value).toBe(saved2.value ?? native);
  });
});
