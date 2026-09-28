"""
Record a real audition clip for every voice, and commit them to public/.

    python scripts/generate_voice_samples.py                  # all models
    python scripts/generate_voice_samples.py --models kokoro-82m
    YAPPER_URL=http://localhost:5173/ python scripts/generate_voice_samples.py

WHY THIS RUNS THE REAL UI INSTEAD OF SYNTHESISING IN NODE
---------------------------------------------------------
The obvious implementation is a Node script that loads the ONNX models and
writes WAVs. That does not work, and not because of Node: both engines fetch
their eSpeak phonemizer from /lib/phonemizer.js and resolve that path against
document.baseURI, so neither can run outside a browser. Re-implementing the
pipeline in Node would mean maintaining a second copy of it, and the samples
would then be audio from a *different* code path than the one users hear —
which is the one property these samples exist to guarantee.

So this drives the app the way a person would: select the model, let it load,
press "Hear it" on each voice, and record what the audition path produces. A
sample and a live synthesis of the same voice are the same audio by
construction, not by a test that hopes they match.

The clip is captured by wrapping URL.createObjectURL before the click rather
than by adding a debug hook to the app, so nothing ships to support this.

RE-RUN IT WHEN
--------------
  * PREVIEW_TEXT changes in src/voice-preview.ts  (the text hash moves)
  * a model is bumped to a new upstream revision
  * a voice is added to a registry

The staleness test in src/voice-samples.test.ts fails if any of those happen
without a re-run, so the recordings cannot quietly go stale.
"""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'public' / 'voice-samples'
DATA_FILE = ROOT / 'src' / 'voice-samples.data.ts'

sys.path.insert(0, str(ROOT))
# Reuse the CDP client rather than growing a second copy of the plumbing.
#
# Imported as a module as well as by name because e2e_test.fetch_cdp() and
# list_targets() close over that file's own module-level CDP constant (the
# endpoint URL) rather than taking an argument. main() rebinds it so --cdp is
# actually honoured — without that the flag parses fine and is then ignored.
# Note the client class is CDPSession; `CDP` in that file is the URL string.
import e2e_test  # noqa: E402
from e2e_test import CDPSession, fetch_cdp, list_targets, v  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, ValueError):  # pragma: no cover
    pass

# App model id -> upstream HF repo whose revision the clips are pinned to.
# kokoro-82m and kokoro-82m-fp16 share one repo: they are the same weights
# in different dtypes, which is exactly why fp16 aliases the int8 recordings.
MODELS = {
    'kokoro-82m': 'onnx-community/Kokoro-82M-v1.0-ONNX',
    'kitten-nano': 'KittenML/kitten-tts-nano-0.8-int8',
    'kitten-mini': 'KittenML/kitten-tts-mini-0.8',
}

# App model id -> the model whose recordings it borrows, with the reason.
# The style vectors are identical and the difference is quantisation, which is
# not what a voice choice turns on. Recorded in the manifest and surfaced in
# the advanced view, so it is disclosed rather than passed off silently.
ALIASES = {
    'kokoro-82m-fp16': (
        'kokoro-82m',
        'Same 28 style vectors from the same repo; only the dtype differs.',
    ),
}

CDP_URL = os.environ.get('YAPPER_CDP', 'http://localhost:9222')
APP_URL = os.environ.get('YAPPER_URL', 'http://localhost:5173/')

# Speech, mono, at the models' native rate. 48 kbps is comfortably transparent
# for a 24 kHz voice clip and lands each file around 15 KB, so all 44 come to
# well under a megabyte.
FFMPEG_ARGS = [
    '-codec:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-ar', '24000',
]


def log(msg: str) -> None:
    print(msg, flush=True)


def load_existing_manifest() -> dict:
    """Read back the previous manifest so `--models kitten-nano` is additive.

    Regenerating one model must not silently delete the other 36 recordings —
    the failure mode being a re-run that looks like it worked and leaves the
    repo with a third of its samples. Aliases are deliberately NOT carried
    forward: they are derived from ALIASES at the end of every run, so
    rebuilding them is what drops entries whose voice no longer exists.
    """
    import re

    manifest = {'textHash': '', 'revisions': {}, 'aliases': {}, 'samples': {}}
    if not DATA_FILE.exists():
        return manifest
    src = DATA_FILE.read_text(encoding='utf-8')

    for m in re.finditer(r'"([^"]+)":\s*"([0-9a-f]{7,40})",', src):
        manifest['revisions'][m.group(1)] = m.group(2)

    for m in re.finditer(
            r'^\s*"([^"]+::[^"]+)":\s*\{\s*file:\s*"([^"]+)",\s*'
            r'sourceModel:\s*"([^"]+)",\s*durationSec:\s*([0-9.]+),\s*bytes:\s*(\d+)\s*\}',
            src, re.M):
        key, f, source_model, dur, byts = m.groups()
        if key.partition('::')[0] not in MODELS:
            continue
        manifest['samples'][key] = {
            'file': f, 'sourceModel': source_model,
            'durationSec': float(dur), 'bytes': int(byts),
        }
    return manifest


def compute_text_hash() -> str:
    """The FNV-1a of PREVIEW_TEXT, computed by the app's own TypeScript.

    Deliberately NOT reimplemented in Python. A second copy of the hash would
    be free to drift from the one in src/voice-samples.ts, and a drifted hash
    does not fail loudly — it makes the staleness guard compare the wrong two
    things forever while still reporting green. So this bundles the real module
    through Vite's resolver (which understands the app's extensionless imports)
    and asks it for the number.
    """
    script = ROOT / '.tmp-voice-sample-hash.mjs'
    script.write_text(
        "import { build } from 'vite';\n"
        "import { pathToFileURL } from 'node:url';\n"
        "await build({ configFile: false, logLevel: 'error', build: {\n"
        "  lib: { entry: 'src/voice-samples.ts', formats: ['es'], fileName: 'voice-samples' },\n"
        "  outDir: '.tmp-hash', emptyOutDir: true, minify: false, write: true } });\n"
        "const m = await import(pathToFileURL(process.cwd() + '/.tmp-hash/voice-samples.js').href);\n"
        "process.stdout.write(String(m.expectedPreviewTextHash()));\n",
        encoding='utf-8')
    try:
        res = subprocess.run(['node', str(script)], cwd=ROOT,
                             capture_output=True, text=True, timeout=300)
        if res.returncode != 0:
            raise RuntimeError(f'could not compute the text hash: {res.stderr.strip()}')
        return res.stdout.strip()
    finally:
        script.unlink(missing_ok=True)
        shutil.rmtree(ROOT / '.tmp-hash', ignore_errors=True)


def hf_revision(repo: str) -> str:
    """The commit the recordings are pinned to, so a model bump is visible."""
    url = f'https://huggingface.co/api/models/{repo}'
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r).get('sha', '')


# ── In-page capture ───────────────────────────────────────────────────

# Installed once. Wraps createObjectURL and stashes the next Blob while armed,
# so the click's output can be read back out of the page.
INSTALL_HOOK = """
(() => {
  if (window.__ys) return 'already';
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (b) {
    if (window.__ys.armed && b instanceof Blob) window.__ys.last = b;
    return orig(b);
  };
  window.__ys = { armed: false, last: null };
  return 'ok';
})()
"""

# One round trip per voice: wait for the player to go idle (the previous clip
# must finish before the next button is clickable), click, wait for the blob,
# return it as base64. The click is a plain element.click() rather than a
# trusted Input event because the blob is created before playback is
# attempted — a blocked autoplay costs the audio, not the recording.
VOICE_JS = r"""
(async () => {
  const vid = %s;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const card = document.querySelector('.voice-card[data-voice-id="' + vid + '"]');
  if (!card) return { ok: false, why: 'no card for ' + vid };
  const btn = card.querySelector('.voice-card__play');
  if (!btn) return { ok: false, why: 'no play button for ' + vid };

  // The player disables every other button while a clip is playing.
  const t0 = Date.now();
  while (btn.disabled && Date.now() - t0 < %d) await sleep(100);
  if (btn.disabled) return { ok: false, why: 'button never enabled' };

  window.__ys.last = null;
  window.__ys.armed = true;
  btn.click();

  const t1 = Date.now();
  while (!window.__ys.last && Date.now() - t1 < %d) await sleep(100);
  window.__ys.armed = false;
  if (!window.__ys.last) return { ok: false, why: 'no blob captured' };

  const bytes = new Uint8Array(await window.__ys.last.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { ok: true, b64: btoa(bin) };
})()
"""


def wait_for_model_ready(cdp: CDPSession, target: str, model_id: str, timeout: float) -> list:
    """Select a model and block until its audition buttons come alive.

    The click target is the card's inner [data-action=pick] button, not the
    card: the card is a div[role=radio] and the handler is on the button
    inside it, so clicking the card is a silent no-op that then shows up as a
    ten-minute timeout with nothing to act on. Asserting the selection
    actually moved turns that into an immediate, legible failure.
    """
    sel = json.dumps(model_id)
    res = v(cdp.eval(
        f"(() => {{ const c = document.querySelector('.model-card[data-model-id={sel}]');"
        f" if (!c) return 'no such model card';"
        f" const b = c.querySelector('[data-action=\"pick\"]');"
        f" if (!b) return 'card has no pick button';"
        f" b.click(); return 'clicked'; }})()", target))
    if res not in ('clicked',):
        raise RuntimeError(f'{model_id}: could not select the model — {res}')

    deadline = time.time() + timeout
    while time.time() < deadline:
        check = v(cdp.eval(
            "(() => {"
            " const sel = document.querySelector('.model-card--selected');"
            " const btns = [...document.querySelectorAll('.voice-card__play')];"
            " return { selected: sel ? sel.dataset.modelId : null,"
            "          n: btns.length,"
            "          live: btns.filter(b => !b.disabled && !b.hasAttribute('data-blocked')).length };"
            " })()", target))
        if check.get('selected') != model_id:
            time.sleep(0.5)
            continue
        if check.get('n') and check.get('n') == check.get('live'):
            return [
                x for x in v(cdp.eval(
                    "[...document.querySelectorAll('.voice-card')]"
                    ".map(c => c.dataset.voiceId).filter(Boolean)", target)) if x
            ]
        time.sleep(1.0)
    raise RuntimeError(f'{model_id}: audition buttons never became ready '
                       f'({timeout:.0f}s) — did the model finish loading?')


def encode_mp3(wav_path: Path, mp3_path: Path) -> int:
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
           '-i', str(wav_path), *FFMPEG_ARGS, str(mp3_path)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f'ffmpeg failed: {res.stderr.strip()}')
    return mp3_path.stat().st_size


def write_data_file(manifest: dict) -> None:
    """Emit the TypeScript manifest the app bundles.

    Generated rather than hand-maintained so the 44 entries cannot drift from
    the files on disk; src/voice-samples.test.ts checks both directions.
    """
    lines = [
        '/**',
        ' * GENERATED FILE — do not edit by hand.',
        ' *',
        ' * Written by scripts/generate_voice_samples.py. Re-run it after changing',
        ' * PREVIEW_TEXT or bumping a model upstream; the staleness test in',
        ' * src/voice-samples.test.ts fails if this file and those disagree.',
        ' */',
        '',
        'export interface VoiceSampleEntry {',
        '  /** Path under public/voice-samples/, e.g. "kokoro-82m/af_heart.mp3". */',
        '  file: string;',
        '  /**',
        '   * The model the audio was actually recorded from. Differs from the',
        "   * key's model only for a deliberate alias, which the advanced view",
        '   * discloses.',
        '   */',
        '  sourceModel: string;',
        '  /** Length of the recorded clip in seconds. */',
        '  durationSec: number;',
        '  /** Size of the encoded file in bytes. */',
        '  bytes: number;',
        '}',
        '',
        'export interface VoiceSampleManifest {',
        "  /** previewTextHash() of the text every clip was recorded speaking. */",
        '  textHash: string;',
        '  /** Upstream model revision each recording was generated from. */',
        '  revisions: Record<string, string>;',
        '  /** Why a key points at another model\'s file: `${modelId}::${voiceId}` -> reason. */',
        '  aliases: Record<string, string>;',
        '  /** Keyed by `${modelId}::${voiceId}` — see voiceSampleKey(). */',
        '  samples: Record<string, VoiceSampleEntry>;',
        '}',
        '',
        'export const VOICE_SAMPLE_MANIFEST: VoiceSampleManifest = {',
        f'  textHash: {json.dumps(manifest["textHash"])},',
        '  revisions: {',
    ]
    for repo, sha in sorted(manifest['revisions'].items()):
        lines.append(f'    {json.dumps(repo)}: {json.dumps(sha)},')
    lines += ['  },', '  aliases: {']
    for key, reason in sorted(manifest['aliases'].items()):
        lines.append(f'    {json.dumps(key)}: {json.dumps(reason)},')
    lines += ['  },', '  samples: {']
    for key in sorted(manifest['samples']):
        e = manifest['samples'][key]
        lines.append(
            f'    {json.dumps(key)}: {{ file: {json.dumps(e["file"])}, '
            f'sourceModel: {json.dumps(e["sourceModel"])}, '
            f'durationSec: {e["durationSec"]}, bytes: {e["bytes"]} }},'
        )
    lines += ['  },', '};', '']
    # newline='\n' so the generated file is byte-identical whoever regenerates
    # it. Path.write_text translates to \r\n on Windows by default, which
    # makes a generated artefact depend on the maintainer's platform.
    DATA_FILE.write_text('\n'.join(lines), encoding='utf-8', newline='\n')


def write_provenance(manifest: dict) -> None:
    """Apache-2.0 requires attribution when redistributing derivative works.

    The clips are derivative works of two Apache-2.0 models, so this file is
    not decoration: it is the licence obligation, and it travels with the
    audio into public/ where it is served from.

    Counted by unique file, not by manifest entry: an alias is a second key
    pointing at a file that already exists, and totalling entries reports
    every borrowed clip twice — which is how this file first claimed to hold
    72 clips and 1.78 MB when the directory holds 44 and 1.2.
    """
    unique = {e['file']: e['bytes'] for e in manifest['samples'].values()}
    mb = sum(unique.values()) / 1_000_000
    (OUT_DIR / 'PROVENANCE.md').write_text(f"""# Voice sample provenance

The MP3 files in this directory are **recorded output** of the open models
below, committed so a voice can be auditioned without downloading anything.
They are derivative works, redistributed under each model's own licence.

{len(unique)} clips, {mb:.2f} MB total.

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
""", encoding='utf-8', newline='\n')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--models', default='',
                    help='comma-separated subset of model ids to re-record')
    ap.add_argument('--cdp', default=CDP_URL)
    ap.add_argument('--url', default=APP_URL)
    ap.add_argument('--ready-timeout', type=float, default=600.0)
    args = ap.parse_args()

    wanted = [m.strip() for m in args.models.split(',') if m.strip()] or list(MODELS)
    unknown = [m for m in wanted if m not in MODELS]
    if unknown:
        print(f'unknown model id(s): {", ".join(unknown)}', file=sys.stderr)
        print(f'known: {", ".join(MODELS)}', file=sys.stderr)
        return 2

    e2e_test.CDP = args.cdp

    log(f'CDP:   {args.cdp}')
    log(f'app:   {args.url}')
    log(f'models: {", ".join(wanted)}')
    log('')

    cdp_holder = CDPSession(fetch_cdp('/json/version')['webSocketDebuggerUrl'])
    try:
        target = None
        for t in list_targets():
            if t.get('type') == 'page':
                target = t['id']
                break
        if not target:
            raise RuntimeError('no page target — is Chrome running with --remote-debugging-port?')
        # attach() returns the session id, and it has to be threaded through
        # explicitly: a send() with no session_id goes to the BROWSER
        # connection, where Page.navigate is silently a no-op. The page then
        # sits on about:blank and the run fails much later, looking like an
        # app that never booted.
        session_id = cdp_holder.attach(target)
        cdp_holder.send('Page.enable', session_id=session_id)
        cdp_holder.send('Runtime.enable', session_id=session_id)

        # live-previews=1 forces the audition path to synthesise for real.
        # Without it a re-run would read the very MP3s it is meant to replace,
        # and quietly "regenerate" them from themselves.
        nav = f'{args.url}{"&" if "?" in args.url else "?"}live-previews=1'
        log(f'navigating to {nav}')
        cdp_holder.send('Page.navigate', {'url': nav}, session_id=session_id)

        deadline = time.time() + 90
        while time.time() < deadline:
            time.sleep(1.0)
            try:
                if v(cdp_holder.eval("!!document.querySelector('.model-card')", target)):
                    break
            except Exception:
                continue
        else:
            raise RuntimeError('app never rendered a model grid')

        log(v(cdp_holder.eval(INSTALL_HOOK, target)))

        # Keep whatever is already in the manifest so a partial re-run
        # regenerates the requested models without dropping the rest.
        manifest = load_existing_manifest()
        manifest['textHash'] = compute_text_hash()
        log(f'preview text hash: {manifest["textHash"]}')

        for model_id in wanted:
            repo = MODELS[model_id]
            log(f'\n=== {model_id} ({repo})')
            log('  waiting for the model to load...')
            t0 = time.time()
            voice_ids = wait_for_model_ready(cdp_holder, target, model_id, args.ready_timeout)
            log(f'  ready in {time.time() - t0:.0f}s, {len(voice_ids)} voices')

            rev = hf_revision(repo)
            manifest['revisions'][repo] = rev
            log(f'  revision {rev[:12]}')

            (OUT_DIR / model_id).mkdir(parents=True, exist_ok=True)
            for i, vid in enumerate(voice_ids, 1):
                js = VOICE_JS % (json.dumps(vid), 60000, 300000)
                res = v(cdp_holder.eval_async(js, target, timeout=360))
                if not res.get('ok'):
                    log(f'  [{i}/{len(voice_ids)}] {vid}: FAILED — {res.get("why")}')
                    continue
                wav = base64.b64decode(res['b64'])
                key = f'{model_id}::{vid}'
                with tempfile.TemporaryDirectory() as td:
                    wav_path = Path(td) / 'clip.wav'
                    wav_path.write_bytes(wav)
                    mp3_path = OUT_DIR / model_id / f'{vid}.mp3'
                    size = encode_mp3(wav_path, mp3_path)
                # MP3 frame count is a good enough duration for a manifest
                # nobody computes from; exactness would mean a decode pass
                # over 44 files for a number nothing reads.
                dur = round(len(wav) / 2 / 24000, 2)
                manifest['samples'][key] = {
                    'file': f'{model_id}/{vid}.mp3',
                    'sourceModel': model_id,
                    'durationSec': dur,
                    'bytes': size,
                }
                log(f'  [{i}/{len(voice_ids)}] {vid}: {len(wav) // 1024}KB wav -> {size // 1024}KB mp3 ({dur}s)')

        # Aliases inherit the source model's entries verbatim.
        for alias, (source, reason) in ALIASES.items():
            for key, entry in list(manifest['samples'].items()):
                k_model, _, voice = key.partition('::')
                if k_model != source:
                    continue
                akey = f'{alias}::{voice}'
                manifest['samples'][akey] = {**entry, 'sourceModel': source}
                manifest['aliases'][akey] = reason

        unique = {e['file'] for e in manifest['samples'].values()}
        log(f'\n{len(manifest["samples"])} entries '
            f'({len(unique)} files, {sum(e["bytes"] for e in manifest["samples"].values()) // 1000} KB '
            f'across entries)')
        write_data_file(manifest)
        log(f'wrote {DATA_FILE.relative_to(ROOT)}')
        write_provenance(manifest)
        log(f'wrote {(OUT_DIR / "PROVENANCE.md").relative_to(ROOT)}')
    finally:
        try:
            cdp_holder.close()
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
