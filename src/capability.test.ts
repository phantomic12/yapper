import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectCapability,
  detectAcceleration,
  resetFeatureProbeCache,
  wasmSimdSupported,
  wasmSimdUnsupportedMessage,
  CAPABILITY_INFO,
  type CapabilityClass,
} from './capability';

// jsdom exposes no navigator.gpu; each test installs its own stub.
type GpuStub = {
  requestAdapter: (options?: { forceSoftware?: boolean }) => Promise<unknown>;
};

/** Adapter stub with an explicit `shader-f16` support answer. */
function installAdapter(features: string[]): void {
  installGpu({
    requestAdapter: () => Promise.resolve({
      features: { has: (f: string) => features.includes(f) },
    }),
  });
}

function installGpu(stub: GpuStub): void {
  (navigator as Navigator & { gpu?: GpuStub }).gpu = stub;
}

function removeGpu(): void {
  delete (navigator as Navigator & { gpu?: GpuStub }).gpu;
}

describe('CAPABILITY_INFO copy (single source for banner + docs)', () => {
  it('has exactly the three documented classes', () => {
    expect(Object.keys(CAPABILITY_INFO).sort()).toEqual(['full', 'none', 'partial']);
  });

  it('uses honest wording per class', () => {
    // 'none': no WebGPU API at all (Firefox stable today, iOS Safari).
    expect(CAPABILITY_INFO.none.capability).toBe('none');
    expect(CAPABILITY_INFO.none.label).toContain('WebGPU unavailable');
    expect(CAPABILITY_INFO.none.label).toContain('CPU fallback (WASM)');
    // 'partial': navigator.gpu exists but adapter unusable (Nightly).
    expect(CAPABILITY_INFO.partial.capability).toBe('partial');
    expect(CAPABILITY_INFO.partial.label).toContain('WebGPU detected');
    expect(CAPABILITY_INFO.partial.label).toContain('CPU fallback (WASM)');
    // 'full': adapter acquired.
    expect(CAPABILITY_INFO.full.capability).toBe('full');
    expect(CAPABILITY_INFO.full.label).toContain('WebGPU detected');
    // Partial must be worded differently from none — that distinction is
    // the whole point of the three-class split.
    expect(CAPABILITY_INFO.partial.label).not.toBe(CAPABILITY_INFO.none.label);
  });
});

describe('detectCapability', () => {
  beforeEach(() => {
    removeGpu();
  });
  afterEach(() => {
    removeGpu();
    vi.useRealTimers();
  });

  it("classifies 'none' when navigator.gpu is missing (iOS Safari, Firefox stable)", async () => {
    const info = await detectCapability();
    expect(info.capability).toBe<CapabilityClass>('none');
    expect(info.label).toBe(CAPABILITY_INFO.none.label);
  });

  it("classifies 'full' when an adapter is acquired", async () => {
    installGpu({ requestAdapter: () => Promise.resolve({}) });
    const info = await detectCapability();
    expect(info.capability).toBe('full');
    expect(info.label).toBe(CAPABILITY_INFO.full.label);
  });

  it("classifies 'partial' when requestAdapter resolves null", async () => {
    installGpu({ requestAdapter: () => Promise.resolve(null) });
    const info = await detectCapability();
    expect(info.capability).toBe('partial');
    expect(info.label).toBe(CAPABILITY_INFO.partial.label);
  });

  it("classifies 'partial' when requestAdapter rejects", async () => {
    installGpu({ requestAdapter: () => Promise.reject(new Error('backend unavailable')) });
    const info = await detectCapability();
    expect(info.capability).toBe('partial');
    expect(info.label).toBe(CAPABILITY_INFO.partial.label);
  });

  it("classifies 'partial' instead of hanging when requestAdapter stalls (AC4)", async () => {
    installGpu({
      // Never settles — seen on some partial implementations.
      requestAdapter: () => new Promise<never>(() => {}),
    });
    vi.useFakeTimers();
    const pending = detectCapability();
    // Before the timeout the detection must not have resolved yet…
    let settled: CapabilityClass | null = null;
    void pending.then((info) => { settled = info.capability; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBeNull();
    // …but boot completes honestly right at the 2s bound.
    await vi.advanceTimersByTimeAsync(1);
    const info = await pending;
    expect(info.capability).toBe('partial');
    expect(info.label).toBe(CAPABILITY_INFO.partial.label);
  });
});

describe('detectAcceleration', () => {
  beforeEach(() => {
    removeGpu();
    // The f16 probe is cached per feature for the life of the page, which is
    // right in production and wrong here: each test installs a new adapter.
    resetFeatureProbeCache();
  });
  afterEach(() => {
    removeGpu();
    resetFeatureProbeCache();
  });

  it('reports GPU only when the adapter also has shader-f16', async () => {
    installAdapter(['shader-f16']);
    const info = await detectAcceleration();
    expect(info.capability).toBe('full');
    expect(info.acceleration).toBe('gpu');
    expect(info.reason).toBe('f16-supported');
    expect(info.degradedGpu).toBe(false);
  });

  it('reports CPU + degradedGpu for an adapter without shader-f16', async () => {
    // The regression this exists for: the banner says "GPU-accelerated"
    // while Kokoro-82M actually runs on the CPU at ~74s per short sentence.
    installAdapter(['timestamp-query']);
    const info = await detectAcceleration();
    expect(info.capability).toBe('full');
    expect(info.acceleration).toBe('cpu');
    expect(info.reason).toBe('no-f16-support');
    expect(info.degradedGpu).toBe(true);
  });

  it('reports plain CPU with no WebGPU at all', async () => {
    const info = await detectAcceleration();
    expect(info.acceleration).toBe('cpu');
    expect(info.reason).toBe('no-webgpu');
    expect(info.degradedGpu).toBe(false);
  });

  it('reports plain CPU when the adapter is unusable', async () => {
    installGpu({ requestAdapter: () => Promise.resolve(null) });
    const info = await detectAcceleration();
    expect(info.capability).toBe('partial');
    expect(info.acceleration).toBe('cpu');
    expect(info.reason).toBe('adapter-unusable');
    expect(info.degradedGpu).toBe(false);
  });

  it('probes each adapter feature only once per page', async () => {
    let calls = 0;
    installGpu({
      requestAdapter: () => {
        calls += 1;
        return Promise.resolve({ features: { has: () => true } });
      },
    });
    await detectAcceleration();
    const afterFirst = calls;
    await detectAcceleration();
    // The second detection re-runs requestAdapter for the capability check,
    // but the feature probe is served from cache — so at most two adapter
    // requests total, not three.
    expect(afterFirst).toBeGreaterThan(0);
    expect(calls - afterFirst).toBeLessThanOrEqual(1);
  });
});

describe('wasmSimdSupported (iOS <16.4 gate)', () => {
  it('accepts a real SIMD-enabled WebAssembly runtime', () => {
    // Node/v8 supports v128, so the hand-assembled probe must validate —
    // if the bytes were malformed this would false-negative on every
    // browser and gate out everyone.
    expect(wasmSimdSupported()).toBe(true);
  });

  it('returns false (not a throw) when WebAssembly is missing entirely', () => {
    const original = (globalThis as { WebAssembly?: typeof WebAssembly }).WebAssembly;
    try {
      delete (globalThis as { WebAssembly?: typeof WebAssembly }).WebAssembly;
      expect(wasmSimdSupported()).toBe(false);
    } finally {
      (globalThis as { WebAssembly?: typeof WebAssembly }).WebAssembly = original;
    }
  });

  it('names the real browser floor in the failure message', () => {
    const msg = wasmSimdUnsupportedMessage();
    expect(msg).toContain('SIMD');
    expect(msg).toContain('16.4');
  });
});
