# Speech-to-text accuracy harness

Measures dictation accuracy against real speech with known ground truth,
running the app's own modules rather than a copy of them.

## Why it exists

Unit tests prove the audio maths. They cannot tell you whether the model
transcribes a person. This harness synthesises eight sentences with two
different voices at three speaking rates, runs each through the exact
chain the dictation UI runs, and scores the result.

## Running it

```bash
# 1. Generate the corpus (Windows: uses the built-in SAPI voices)
powershell -ExecutionPolicy Bypass -File scripts/asr-accuracy/gen-corpus.ps1

# 2. Start the dev server
npm run dev

# 3. In the browser console
window.__asrTest = {status:'booting'};
import('/.asr-fixtures/harness.js').then(m => m.run());
```

Then poll `window.__asrTest` — it updates after every case. Results land in
`__asrTest.summary`, `.cases`, `.quiet`, `.short`, `.rateTest` and
`.degenerate`.

The fixtures land in `public/.asr-fixtures/`, which is gitignored: they
must be reachable by the page, but they are not part of the app.

## What it measures

- **Word error rate** per sentence, two ways. `wer` collapses every number
  — digit or word — to one placeholder, because the model rewrites "two
  hundred" as "200" and that is not an error. `werRaw` scores the literal
  transcript. Read both: the gap between them is inverse text
  normalisation, and the remainder is real error.
- **Gate behaviour** — no case may be gated out, and silence and a steady
  tone must both be rejected before inference.
- **Quiet speech** — the same sentence at 2% amplitude. A soft speaker must
  survive trimming and transcribe.
- **Sample-rate robustness** — round-trip through 44.1 kHz and back, which
  exercises the fractional-ratio branch of the resampler.
- **Short clips** — half a second must not crash and must return something
  honest.

## Known limitation

Whisper Tiny is weak on spelled-out punctuation. "jordan dot lee at
example dot com" comes back as `jordan.lea.example.com` — the model merges
the words and drops the "at". This is a tiny-model limit, not a plumbing
bug; a larger checkpoint fixes it at a larger download. Verify dictated
email addresses and URLs.
