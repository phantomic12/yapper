"""
Capture a polished demo GIF of yapper that LOOKS like the app is actually
doing work. Drives the deployed live site (phantomic12.github.io/yapper),
synthesizes the post-load UI, then animates a realistic TTS flow:

  1. Landing — model grid (static beat)
  2. Click Kitten Nano → selected
  3. Synthesize "loaded" state
  4. Type sample text into textarea (char by char)
  5. Click "Add to queue" → job card appears as pending
  6. Animate pending → generating: progress bar fills 0% → 100%,
     elapsed-time counter ticks up, status dot pulses, border glows
  7. Job finishes → "done" card with audio player visible
  8. Optional: click the audio play button so it shows playing state

Frame density is higher during action (100-200ms) and lower on static
beats (800-1200ms) so the GIF reads as motion.
"""

import asyncio
import os
import shutil
import subprocess
from pathlib import Path

from playwright.async_api import async_playwright

URL = os.environ.get('YAPPER_URL', 'https://phantomic12.github.io/yapper/')
OUT_DIR = Path(os.environ.get('OUT_DIR', '/home/yoav/projects/yapper/out'))
FRAMES_DIR = OUT_DIR / 'frames'
FRAMES_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_TEXT = (
    "Yapper runs entirely in your browser. No cloud, no tracking, "
    "no compromise."
)
LONG_SAMPLE = (
    "Yapper runs entirely in your browser. No cloud, no tracking, "
    "no compromise. Just text-to-speech, the way it should be."
)

_idx = 0


async def shot(page, label: str, hold_ms: int = 0):
    """Take a screenshot, optionally after waiting `hold_ms`."""
    global _idx
    if hold_ms:
        await page.wait_for_timeout(hold_ms)
    p = FRAMES_DIR / f'frame_{_idx:04d}_{label}.png'
    await page.screenshot(path=str(p), full_page=False)
    print(f'  frame {_idx:04d} {label}', flush=True)
    _idx += 1


async def run():
    print(f'→ {URL}', flush=True)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        )
        ctx = await browser.new_context(
            viewport={'width': 1024, 'height': 640},
            device_scale_factor=2,
        )
        page = await ctx.new_page()

        await page.goto(URL, wait_until='domcontentloaded', timeout=30_000)
        await page.wait_for_selector('.model-card', timeout=15_000)
        await page.wait_for_timeout(1200)

        # Hide the WebGPU/CPU fallback banner BEFORE first capture.
        # It's accurate in real headless but visually noisy for a demo
        # that should look like the "happy path".
        await page.evaluate('''() => {
            document.querySelectorAll('.gpu-status').forEach(el => el.remove());
            document.querySelectorAll('[role="status"]').forEach(el => {
                if (/WebGPU|CPU fallback/i.test(el.textContent || '')) el.remove();
            });
        }''')

        # 1. Landing — two beats so the static grid has motion
        await shot(page, '01-landing-a', hold_ms=900)
        await shot(page, '01-landing-b', hold_ms=900)

        # 2. Hover Kitten Nano → click pick
        await page.hover('.model-card[data-model-id="kitten-nano"]')
        await shot(page, '02-hover', hold_ms=350)
        await page.click('.model-card[data-model-id="kitten-nano"] [data-action="pick"]')
        await shot(page, '03-selected', hold_ms=500)

        # 3. Inject "loaded" state directly (skip the real download +
        #    CORS-protected voices.npz fetch, which is the same trade-off
        #    the existing script makes — but we're keeping the loaded
        #    badge + an enabled text input + a working "Add to queue"
        #    button so the subsequent steps can drive real state.)
        await page.evaluate('''() => {
            const card = document.querySelector('.model-card[data-model-id="kitten-nano"]');
            card.classList.add('model-card--loaded');
            const status = card.querySelector('[data-role="model-status"]');
            if (status) status.textContent = 'Loaded';
            const loadBtn = document.getElementById('load-btn');
            const label = loadBtn?.querySelector('span');
            if (label) label.textContent = '✓ Kitten TTS Nano (~24MB) loaded';
            const fill = document.getElementById('progress-fill');
            if (fill) fill.style.width = '100%';
            const sampleBtn = card.querySelector('[data-action="sample"]');
            if (sampleBtn) sampleBtn.hidden = false;
            const ta = document.getElementById('text-input');
            if (ta) ta.disabled = false;
            const gen = document.getElementById('generate-btn');
            if (gen) gen.disabled = false;
            // Hide ALL WebGPU/CPU-fallback banners — accurate for headless
            // but visually noisy in a demo. We're showing the app in its
            // "happy path" state, so the warning is just clutter.
            document.querySelectorAll('.gpu-status').forEach(el => el.remove());
            // Backup sweep in case the classname changes
            document.querySelectorAll('[role="status"]').forEach(el => {
                if (/WebGPU|CPU fallback/i.test(el.textContent || '')) el.remove();
            });
        }''')
        await shot(page, '04a-loaded', hold_ms=400)
        await shot(page, '04b-loaded-settled', hold_ms=300)

        # 4. Type the sample text into the textarea char-by-char so
        #    the cursor visibly fills the field.
        await page.click('#text-input')
        for chunk in [SAMPLE_TEXT[i:i+4] for i in range(0, len(SAMPLE_TEXT), 4)]:
            await page.keyboard.type(chunk, delay=18)
            await page.wait_for_timeout(60)
        await shot(page, '05a-typed', hold_ms=250)

        # 5. Click "Add to queue" — capture the moment of submission
        await page.click('#generate-btn')
        # First frame: the job card just appeared
        await page.wait_for_timeout(180)
        await shot(page, '05b-queued', hold_ms=120)

        # 6. Animate pending → generating → done by driving the live
        #    engine state where possible. The job card has its own
        #    rendering in the real app, so we let the app's render
        #    path show us "Generating…" with elapsed seconds. We
        #    can't make real inference finish in time, so after a
        #    short burst we swap in the "done" state ourselves.
        for i in range(8):
            await page.wait_for_timeout(280)
            await shot(page, f'06-generating-{i:02d}')

        # Inject a "done" job card with a real audio src so the
        # <audio> element actually has controls and a seekable duration.
        await page.evaluate('''async (longText) => {
            // Grab the in-flight job's text so the demo card matches
            // what the user just submitted
            const inFlight = document.querySelector('.job-card .job-card__text');
            const quotedText = inFlight ? inFlight.textContent.replace(/^"|"$/g, '') : longText;

            // Replace any pending/generating card with a done card
            document.querySelectorAll('.job-card--pending, .job-card--generating').forEach(c => {
                c.classList.remove('job-card--pending', 'job-card--generating');
                c.classList.add('job-card--done');
                const status = c.querySelector('.job-card__status');
                if (status) status.innerHTML = '<span class="status-dot status-dot--done" title="Done">✓</span>';
                const body = c.querySelector('.job-card__body');
                if (body) {
                    // 1s of silence WAV so the audio control shows real metadata
                    const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
                    body.innerHTML = `
                        <audio controls preload="metadata" data-job-id="demo" src="${silentWav}" style="width:100%"></audio>
                        <div class="job-card__actions">
                          <button class="job-card__btn" data-action="download" data-job-id="demo">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download WAV
                          </button>
                          <span class="job-card__meta">4.0s · 4.0s audio</span>
                        </div>`;
                }
            });

            // Reveal the queue-label if it was hidden
            const label = document.getElementById('queue-label');
            if (label) label.style.display = '';
        }''', LONG_SAMPLE)
        await page.wait_for_timeout(400)
        await page.evaluate('() => document.querySelector(".job-card--done")?.scrollIntoView({block: "center"})')
        await page.wait_for_timeout(250)
        await shot(page, '07-done', hold_ms=500)
        await shot(page, '07-done-settled', hold_ms=400)

        # 7. Final hold so the GIF has a clean tail
        await shot(page, '99-end', hold_ms=200)

        await ctx.close()
        await browser.close()


def build():
    """Assemble GIF + MP4 from the captured frames."""
    frames = sorted(FRAMES_DIR.glob('frame_*.png'))
    if not frames:
        raise SystemExit('no frames captured')

    seq = OUT_DIR / 'seq'
    if seq.exists():
        shutil.rmtree(seq)
    seq.mkdir()
    for i, f in enumerate(frames):
        shutil.copy(f, seq / f'f_{i:04d}.png')

    # Per-frame durations — denser during action, longer on static beats.
    durations = []
    for f in frames:
        n = f.name
        if '99-end' in n:
            durations.append(2.5)
        elif '01-landing' in n:
            durations.append(1.1)
        elif '02-hover' in n or '03-selected' in n:
            durations.append(0.6)
        elif '04' in n:
            durations.append(0.8)
        elif '05a-typed' in n:
            durations.append(1.0)
        elif '05b-queued' in n:
            durations.append(0.45)
        elif '06-generating' in n:
            durations.append(0.18)  # tight — that's the "doing work" core
        elif '07-done' in n:
            durations.append(1.4)
        else:
            durations.append(0.4)

    concat = OUT_DIR / 'concat.txt'
    lines = [f"file '{f.absolute()}'\nduration {d}" for f, d in zip(frames, durations)]
    lines.append(f"file '{frames[-1].absolute()}'")
    concat.write_text('\n'.join(lines))

    # Two-pass palette for the GIF (smaller, better colors than one-pass)
    palette = OUT_DIR / 'palette.png'
    subprocess.run([
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat),
        '-vf', 'fps=24,scale=720:-1:flags=lanczos,palettegen=stats_mode=diff',
        str(palette),
    ], check=True, capture_output=True)
    subprocess.run([
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat), '-i', str(palette),
        '-lavfi', 'fps=24,scale=720:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4',
        '-loop', '0',
        str(OUT_DIR / 'demo.gif'),
    ], check=True, capture_output=True)
    print(f'  GIF: {(OUT_DIR / "demo.gif")}', flush=True)

    # MP4 for higher-quality README preview
    subprocess.run([
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat),
        '-vf', 'scale=1024:-2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        str(OUT_DIR / 'demo.mp4'),
    ], check=True, capture_output=True)
    print(f'  MP4: {(OUT_DIR / "demo.mp4")}', flush=True)


if __name__ == '__main__':
    asyncio.run(run())
    build()
