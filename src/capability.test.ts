import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectCapability,
  CAPABILITY_INFO,
  type CapabilityClass,
} from './capability';

// jsdom exposes no navigator.gpu; each test installs its own stub.
type GpuStub = {
  requestAdapter: (options?: { forceSoftware?: boolean }) => Promise<unknown>;
};

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
