/**
 * Capability classification shared by the banner (ui/layout.ts) and any other
 * consumer that needs to explain what the current device can do.
 *
 * Three classes, in increasing order of capability:
 *   'none'    — no WebGPU API at all (Firefox stable today, iOS Safari,
 *               older browsers). WASM fallback is the only path.
 *   'partial' — `navigator.gpu` exists but adapter acquisition fails, hangs,
 *               or throws. Covers partial implementations such as early
 *               Firefox Nightly builds behind a flag, and devices where
 *               requestAdapter() rejects or never settles.
 *   'full'    — WebGPU adapter acquired successfully.
 *
 * Exact banner strings live in CAPABILITY_INFO below (not inline in the
 * layout template) so docs/capability-banner.md can quote them verbatim and
 * tests can assert on them.
 */

export type CapabilityClass = 'none' | 'partial' | 'full';

export interface CapabilityInfo {
  /** Coarse device class — drives the banner dot color + wording. */
  capability: CapabilityClass;
  /**
   * Exact banner string shown to the user. Quoted verbatim in
   * docs/capability-banner.md and asserted in src/capability.test.ts.
   */
  label: string;
  /** Longer explanation for the banner's title/tooltip attribute. */
  detail: string;
}

/** Banner copy per class — single source of truth for UI, docs, and tests. */
export const CAPABILITY_INFO: Record<CapabilityClass, CapabilityInfo> = {
  none: {
    capability: 'none',
    label: 'WebGPU unavailable — using CPU fallback (WASM)',
    detail:
      'This browser does not expose WebGPU. All models run on the CPU via WebAssembly. ' +
      'Generation works but is slower, especially for larger models.',
  },
  partial: {
    capability: 'partial',
    label: 'WebGPU detected but unusable — using CPU fallback (WASM)',
    detail:
      'The browser exposes WebGPU but could not provide a working GPU adapter. This is ' +
      'common on partial/incomplete implementations such as Firefox Nightly with the ' +
      'dom.webgpu.enabled flag. All models run on the CPU via WebAssembly.',
  },
  full: {
    capability: 'full',
    label: 'WebGPU detected — GPU-accelerated inference',
    detail:
      'WebGPU is available. Models that support it run GPU-accelerated; ' +
      'everything still runs locally on your device.',
  },
};

/** How long to wait for requestAdapter() before declaring it unusable. */
const ADAPTER_TIMEOUT_MS = 2000;

/**
 * Detect the WebGPU capability class of this browser.
 * Never hangs and never throws: every failure path degrades to a lower
 * class, and a stalled requestAdapter() resolves as 'partial' within
 * ADAPTER_TIMEOUT_MS so boot always completes with honest messaging.
 */
export async function detectCapability(): Promise<CapabilityInfo> {
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter(options?: { forceSoftware?: boolean }): Promise<unknown> };
  }).gpu;

  // Class 'none': iOS Safari, Firefox stable (Linux), older browsers.
  if (!gpu) return CAPABILITY_INFO.none;

  try {
    // A hung requestAdapter() (seen on some Nightly builds) would otherwise
    // stall boot forever — race it against a timeout and treat a stall as
    // 'partial'.
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ADAPTER_TIMEOUT_MS)),
    ]);
    if (!adapter) return CAPABILITY_INFO.partial;
    return CAPABILITY_INFO.full;
  } catch {
    // requestAdapter() rejecting: another partial-implementation signal.
    return CAPABILITY_INFO.partial;
  }
}
