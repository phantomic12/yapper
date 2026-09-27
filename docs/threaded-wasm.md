# Threaded WASM / cross-origin isolation

onnxruntime-web can only use its thread pool when the page is **cross-origin
isolated** — the browser must serve both of these response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp   (or: credentialless)
```

With them, `window.crossOriginIsolated === true` and `SharedArrayBuffer` is
available; without them ORT logs *"WebAssembly multi-threading is not supported
in the current environment"* and pins every kernel to one core.

## Why it is not enabled by default

Measured on the dev machine (Windows, `hardwareConcurrency: 24`, WebGPU present
but emulated — no `shader-f16`), same sentence, same model file
(`model_quantized.onnx`):

| Configuration | Kokoro load | Generation (44 chars) |
|---|---|---|
| No isolation headers, main thread | 2s | 4.8s (WASM) / 5.4s (WebGPU) |
| No isolation headers, inference worker | 2s | 116s+ and still running |
| COOP + COEP `require-corp`, main thread | stalled >120s | — |
| COOP + COEP `require-corp`, inference worker | **fails**, "no available backend found" | — |

Enabling the headers made both paths worse here. The worker failure is an ORT
threading init problem, not a fetch problem: model weights still load fine
under `require-corp` (huggingface.co sends `access-control-allow-origin: *` and
returns `206` for ranged requests), so CORP is not what breaks. The most likely
cause is oversubscription — with 24 logical cores ORT's default thread pool
costs more than it saves on a CPU that is already busy.

## Enabling it safely

If you want threads, do it deliberately:

1. **Cap the thread count first.** Set `numThreads` explicitly rather than
   letting ORT read `hardwareConcurrency`. Start at 4; measure. Leaving it at
   the default of "all cores" is what turned a slow path into a failing one.
2. **Verify the worker.** Cross-origin isolation changes how the inference
   worker initialises ORT, and that is where the failure appeared here. Test a
   real generation, not just a model load — the load watchdog can pass while
   generation hangs.
3. **Confirm the host can set headers.** GitHub Pages cannot configure response
   headers at all, so a Pages deploy stays single-threaded no matter what the
   repo does. Cloudflare Pages (`_headers`), Netlify (`_headers`), nginx and
   Workers all can.
4. **Re-check every third-party fetch.** `require-corp` puts all cross-origin
   subresources behind CORP. Model weights survive it today; a future CDN
   change would not.

For a quick local check, add the headers to `server.headers` in
`vite.config.ts` and reload: `window.crossOriginIsolated` should be `true` and
`new SharedArrayBuffer(8)` should not throw.

## Related

- [`docs/capability-banner.md`](capability-banner.md) — what the device can
  actually do, and why the banner has three classes.
- The execution-provider decision (WebGPU vs WASM) lives in
  `src/engines/kokoro.ts` (`chooseKokoroRuntime`) and
  `src/capability.ts` (`detectAcceleration`); neither is affected by isolation.
