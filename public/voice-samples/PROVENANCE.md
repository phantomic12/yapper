# Voice sample provenance

The MP3 files in this directory are **recorded output** of the open models
below, committed so a voice can be auditioned without downloading anything.
They are derivative works, redistributed under each model's own licence.

44 clips, 1.09 MB total.

## Regenerating

    python scripts/generate_voice_samples.py

Do not hand-edit. The recordings are produced by driving the app's own
audition path in a headless browser (`scripts/generate_voice_samples.py`), so a
sample is the same audio a live synthesis produces. The revision each model was
pinned to is recorded in `src/voice-samples.data.ts`; if you re-run after an
upstream bump, commit the new revisions with the new audio.

## Models

| App model | Upstream repository | Licence |
| --- | --- | --- |
| Kokoro 82M | [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | Apache-2.0 |
| Kitten TTS Nano | [`KittenML/kitten-tts-nano-0.8-int8`](https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8) | Apache-2.0 |
| Kitten TTS Mini | [`KittenML/kitten-tts-mini-0.8`](https://huggingface.co/KittenML/kitten-tts-mini-0.8) | Apache-2.0 |

`kokoro-82m-fp16` has no files of its own. It is the same repository and the
same 28 style vectors as `kokoro-82m` in a different dtype, so it borrows those
recordings; the manifest records the alias and the advanced view says so.

## Notes on the audio

* Recorded at each model's native 24 kHz, encoded mono MP3 at 48 kbps. The
  encoding is a size decision, not a quality claim about the model.
* Every clip speaks the same sentence, `PREVIEW_TEXT` in
  `src/voice-preview.ts`. Its hash is stored in the manifest so that editing
  the sentence without re-recording fails a test rather than shipping 44 clips
  that say something the app no longer says.
* Kokoro was trained on synthetic speech data, so no real person's voice is
  reproduced here.
