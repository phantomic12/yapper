# Which TTS models can actually run in a browser?

A note on the ceiling this app is working under, so the next person does not
spend a day re-deriving it. Checked 2026-09-26 against the Hugging Face Hub
API and the transformers.js supported-architecture list.

## The constraint

A model is usable here only if **transformers.js supports its
architecture**. That is a hard wall: everything else (ONNX weights, a
pipeline tag, a WebGPU story) is necessary but not sufficient. There is no
generic "load any ONNX file" path — each architecture needs its own input
handling, output decoding and, for most neural voices, a grapheme-to-phoneme
stage and a vocoder.

The definitive list is the Hub itself, filtered to the library tag:

```
https://huggingface.co/api/models?filter=transformers.js&pipeline_tag=text-to-speech
```

## What is reachable

| Model | Status |
| --- | --- |
| **Kokoro-82M** (StyleTTS2) | In the app. 694k downloads on that list — by far the most used, and the quality/size sweet spot. |
| Kitten TTS nano / mini | In the app. Same StyleTTS2 family, smaller, faster, no espeak dependency in the same way. |
| MMS-TTS (VITS) | In the app, 7 languages. Dated-sounding but tiny and fast. |
| SpeechT5 | In the app, **broken** — see the "Still broken" section. |
| **Chatterbox** | Supported architecture, ONNX exports exist (`onnx-community/chatterbox-ONNX`, plus community `chatterbox-nano-ONNX` at int4). The one real capability gap: **zero-shot voice cloning** from a short reference clip. |
| VITS (BricksDisplay et al.) | Supported, but these are hobby fine-tunes, not a product. |
| OuteTTS-0.2-500M | Supported, but **cc-by-nc-4.0** — non-commercial, so not something to ship. |
| Orpheus-3B | Supported as a *text-generation* model: it needs the DAC audio codec alongside it. Not a text-to-speech pipeline. |
| Plapre (Danish) | Supported, tiny ecosystem. |

## What is not reachable, however good it is

Dia 1.6B, F5-TTS, Fish Speech / Fish Audio, Qwen3-TTS, IndexTTS, CosyVoice,
Spark-TTS, MaskGCT, VALL-E X, Higgs Audio — **none of these are in
transformers.js's supported architectures.** They are all "SOTA" on paper and
all unavailable here without hand-writing an ONNX pipeline plus tokenizer,
phonemizer and vocoder glue for each one. That work is a project in itself,
and it is per-model, not a one-off.

The practical consequence: **Kokoro is roughly the quality ceiling for a
browser TTS app today.** That is a real limit, not a preference.

## The two candidates that looked promising and were not

**Kokoro-82M-v1.1-zh-ONNX** (adds Mandarin; 1,843 downloads; clean dtype
matrix — 127MB at int8, 164MB at fp16, identical file naming to v1.0, so it
would be a registry-only change). The blocker is not the model, it is the
frontend: kokoro-js does its grapheme-to-phoneme work with misaki + eSpeak,
which is English-only. Grepping the web build for a Chinese G2P turns up one
`is_chinese_char` helper from misaki's own utils and a `ChineseCLIP` class
name in transformers' model table — no pinyin, no jieba. The model would
load and then produce garbage for Chinese text. Adding it would be a second
broken card, so it was not added.

**Supertonic-TTS-2-ONNX** (5 languages: en/ko/es/pt/fr; Jan 2026; the
Picovoice on-device benchmark rates it highly). It ships **no quantized
build at all** — `text_encoder` (28MB) + `voice_decoder` (101MB) +
`latent_denoiser` (132MB) = ~262MB of fp32 external weights for a browser
download, and a three-model composite where the app currently assumes one.
A 3× bigger download to replace an 88MB Kokoro is not a trade worth making
before the model has a quantized export and a settled API.

## Still broken, unchanged

**SpeechT5.** Loads in 1.5s and then every generation fails with
`Missing the following inputs: speaker_embeddings, encoder_hidden_states`.
`Xenova/speecht5_tts` has no `onnx/model.onnx` — only `encoder_model.onnx`
and `decoder_model_merged.onnx` — and its config advertises
`AutoModelForTextToSpectrogram` under the `text-to-audio` task, which takes
the waveform path and fails identically. Fixing it means running the
processor and the HiFiGAN vocoder, i.e. a different engine, not a wiring
change. Until then the card is a trap: it loads, so it looks like it works.

## If someone wants to add a model

1. Confirm the architecture is on the transformers.js list (above).
2. Check the ONNX files exist in the dtype you intend to ship — measure them,
   do not trust the card.
3. Check the **frontend** can feed it: a Kokoro-class model needs a
   phonemizer, and not every one ships in JS. This is the step that catches
   v1.1-zh.
4. `npm run test:links` after registering it — it probes every model URL.
