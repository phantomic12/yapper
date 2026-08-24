# Capability banner wording

Yapper's GPU status banner must tell the truth about what the device can do.
The exact strings below are the single source of truth in
[`src/capability.ts`](../src/capability.ts) (`CAPABILITY_INFO`), rendered by
`src/ui/layout.ts` into `.gpu-status`, and asserted by `src/capability.test.ts`
and `src/layout.test.ts`. Change them there, together, or this doc and the UI
drift apart.

## The three classes

| Class | When | Banner label (exact string) | Dot |
|---|---|---|---|
| `none` | No WebGPU API at all: Firefox stable on Linux today, iOS Safari (all versions — no WebGPU shipped), older browsers. | `WebGPU unavailable — using CPU fallback (WASM)` | amber, no glow |
| `partial` | `navigator.gpu` exists but adapter acquisition fails, throws, **or stalls** (>2s timeout): partial implementations such as Firefox Nightly with `dom.webgpu.enabled`, devices where `requestAdapter()` rejects. | `WebGPU detected but unusable — using CPU fallback (WASM)` | amber, soft glow |
| `full` | A WebGPU adapter was acquired successfully. | `WebGPU detected — GPU-accelerated inference` | green, glow |

Hovering the banner shows a longer explanation (`title` attribute):

- **none** — "This browser does not expose WebGPU. All models run on the CPU
  via WebAssembly. Generation works but is slower, especially for larger models."
- **partial** — "The browser exposes WebGPU but could not provide a working
  GPU adapter. This is common on partial/incomplete implementations such as
  Firefox Nightly with the dom.webgpu.enabled flag. All models run on the CPU
  via WebAssembly."
- **full** — "WebGPU is available. Models that support it run GPU-accelerated;
  everything still runs locally on your device."

## Why three classes instead of two

A boolean "WebGPU yes/no" lies twice:

1. On browsers that *expose* `navigator.gpu` but cannot deliver a usable
   adapter (Firefox Nightly behind its flag is the canonical case), "WebGPU
   detected" would promise acceleration the device cannot deliver.
2. On iOS Safari, "unavailable" gives no hint about whether this is a
   not-yet-shipped API vs a broken setup.

The three-class split keeps each message honest: users on `partial` learn
their browser is *trying* but falling back, which matches what they should do
about it (use stable Chrome/Edge for GPU speed; everything still works via
WASM otherwise).

## Verified messaging paths (QA matrix cross-reference)

Verified against `docs/qa-matrix.md` runs:

- **Chrome + WASM fallback** (forced via blocked adapter / non-GPU machine):
  banner shows the `none` string; load + generation proceed on WASM.
- **Firefox** (stable, Linux): `navigator.gpu` absent → `none` string.
  Firefox Nightly with WebGPU enabled but incomplete → `partial` string
  (adapter request fails or stalls; the 2s watchdog guarantees the banner
  never hangs boot).
- **WebGPU-capable Chrome** (Chromium 151, Edge 151): `full` string, GPU
  path exercised end-to-end (see QA matrix Chromium column).
- **iOS Safari**: `navigator.gpu` undefined today → `none` string. Same path
  as Firefox-stable; no special-casing needed because the class derives from
  detection, not user-agent sniffing.

If a future browser moves between classes (e.g. Firefox stable shipping
WebGPU), only `src/capability.ts` behavior changes — the wording table above
stays valid as long as the strings don't change.

## Related honest-UX behaviors

- **Main-thread model warning** — selecting SpeechT5 or an MMS-TTS model shows
  a prominent amber warning (`#main-thread-warning`, AC2) that generation may
  briefly freeze the page, since those models run Transformers.js on the main
  thread instead of the Kokoro/Kitten worker path.
- **Download retry** — failed/stalled Hugging Face downloads surface an error
  state with a one-click Retry button (AC1); the engine's load watchdog fires
  after 5s without progress so a stalled download never hangs silently.
- **Generation liveness** — while any job generates, a pulsing indicator next
  to the queue shows progress (AC4), including during main-thread synthesis
  that freezes timers.
