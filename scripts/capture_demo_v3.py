"""
Capture a polished demo of yapper that LOOKS like a real tech demo.

Drives the deployed live site, then composites the result into a
fake browser window with an animated cursor, real waveform audio,
progress bar, elapsed-time counter, and an intro slate.

Three phases, each at a fixed scroll position so the GIF has
continuous visual context instead of jumping between unrelated
viewport slices:

  Phase 1 (scrollY=0):   Model grid. Click Kitten Nano. Synthesize
                         loaded state.
  Phase 2 (scrollY~700): Voice picker, textarea, Add to queue. Type
                         sample text. Submit.
  Phase 3 (scrollY~1200): Queue area. Job card transitions through
                          pending → generating (progress bar fills,
                          elapsed counter ticks) → done (audio player
                          visible).

Cursor is a real SVG element that follows element positions across
phases. Phase transitions are smooth scroll captured at ~24fps so
the GIF reads as continuous motion rather than cuts.

Audio for the "done" card is a procedurally-generated 3s sine sweep
with amplitude envelope — gives the <audio> element real non-zero
duration metadata so the playhead shows movement.

Output: 1280x720 @ 24fps GIF + 1920x1080 @ 30fps MP4 wrapped in a
fake browser window.
"""

import asyncio
import base64
import io
import json
import math
import os
import shutil
import struct
import subprocess
import time
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from playwright.async_api import async_playwright

URL = os.environ.get('YAPPER_URL', 'https://phantomic12.github.io/yapper/')
OUT_DIR = Path(os.environ.get('OUT_DIR', '/home/yoav/projects/yapper/out'))
FRAMES_DIR = OUT_DIR / 'frames_raw'
FRAMES_DIR.mkdir(parents=True, exist_ok=True)

VIEWPORT_W = 1280
VIEWPORT_H = 720
DPR = 2  # capture at 2x for crisp text, downscale during compose

SAMPLE_TEXT = (
    "Yapper runs entirely in your browser. No cloud, no tracking, "
    "no compromise."
)

# Scroll positions for the three phases. Picked by hand from the
# live-site DOM probe — text-input center sits at ~1253 docY,
# generate-btn at ~1665, job-list at ~1808. With a 1280x720 viewport,
# we scroll so the relevant section is centered in view.
SCROLL_PHASE_1 = 0     # model grid already in view at top
SCROLL_PHASE_2 = 1100  # textarea (at docY~1193 → viewport 93) +
                       # button (at docY~1665 → viewport 565) both in
                       # the 720px viewport with room around them
SCROLL_PHASE_3 = 1300  # queue card mid-viewport

_idx = 0
total_frames = 0


async def shot(page, label: str, hold_ms: int = 0):
    """Take a screenshot, optionally after waiting `hold_ms`."""
    global _idx, total_frames
    if hold_ms:
        await page.wait_for_timeout(hold_ms)
    p = FRAMES_DIR / f'f{_idx:04d}_{label}.png'
    await page.screenshot(path=str(p), full_page=False)
    _idx += 1
    total_frames += 1
    return _idx - 1


async def smooth_scroll_capture(page, from_y: int, to_y: int,
                                 label_prefix: str, dur_ms: int = 600,
                                 steps: int = 14):
    """Smoothly scroll from from_y to to_y, capturing ~24fps.

    We animate scrollTop in JS so the timing is deterministic and
    doesn't depend on the browser's smooth-scroll implementation.
    """
    steps = max(6, steps)
    # Set up an animation that scrolls in lock-step with our captures
    await page.evaluate(f'''() => {{
        window.scrollTo({{top: {from_y}, behavior: "instant"}});
    }}''')
    await page.wait_for_timeout(60)
    # Use requestAnimationFrame-driven scroll so it advances per-frame
    await page.evaluate(f'''() => {{
        const startY = {from_y};
        const endY = {to_y};
        const totalSteps = {steps};
        let i = 0;
        window.__demoScrollAnim = () => {{
            i++;
            const t = Math.min(1, i / totalSteps);
            const e = 1 - Math.pow(1 - t, 3);  // ease-out cubic
            window.scrollTo(0, startY + (endY - startY) * e);
        }};
    }}''')
    for i in range(steps):
        await page.evaluate('window.__demoScrollAnim()')
        await page.wait_for_timeout(dur_ms // steps)
        await shot(page, f'{label_prefix}-{i:02d}')


def make_demo_wav(path: Path, duration_s: float = 3.0, sr: int = 22050):
    """Generate a procedural TTS-like audio: amplitude-modulated sine
    sweep with formants. Sounds robotic but reads as 'audio waveform'
    when the <audio> element shows its progress."""
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    # Frequency sweeps from 180Hz (vowel 'o') to 320Hz back to 220Hz,
    # simulating speech intonation across the sample text.
    f0 = 220 + 60 * np.sin(2 * np.pi * 1.2 * t) - 30 * np.sin(2 * np.pi * 0.4 * t)
    # Add a couple of higher harmonics for voice-like timbre
    audio = 0.6 * np.sin(2 * np.pi * f0 * t) \
          + 0.25 * np.sin(2 * np.pi * (f0 * 2) * t) \
          + 0.12 * np.sin(2 * np.pi * (f0 * 3) * t)
    # Amplitude envelope: syllable-like gating at ~4Hz
    env = 0.55 + 0.45 * (0.5 + 0.5 * np.sin(2 * np.pi * 4.0 * t))
    # Fade in/out
    fade = np.ones_like(t)
    fade = np.minimum(fade, np.minimum(t / 0.05, (duration_s - t) / 0.1))
    audio = audio * env * fade
    audio = (audio / max(0.99, np.abs(audio).max()) * 32000).astype(np.int16)

    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(audio.tobytes())


def cursor_svg(x: float, y: float, clicking: bool = False,
               size: int = 24) -> str:
    """Return an SVG cursor element positioned at (x, y) in viewport
    coords. The cursor follows the standard macOS-style arrow."""
    transform = f'translate({x:.0f} {y:.0f})'
    if clicking:
        # Slight scale-down to suggest click
        transform += ' scale(0.85)'
    return (
        f'<svg class="__demo-cursor" style="position:fixed;left:0;top:0;'
        f'width:{size}px;height:{size}px;pointer-events:none;z-index:99999;'
        f'transform:{transform};" viewBox="0 0 24 24">'
        f'<path d="M3 2 L21 11 L13 13 L11 21 Z" fill="white" stroke="black" '
        f'stroke-width="1.2" stroke-linejoin="round"/></svg>'
    )


def cursor_js(x: float, y: float, clicking: bool = False):
    """Return a JS snippet that injects/moves the demo cursor."""
    svg = cursor_svg(x, y, clicking)
    return f'''(() => {{
        let c = document.querySelector('.__demo-cursor');
        if (!c) {{
            c = document.createElement('div');
            c.innerHTML = {json.dumps(svg)};
            c = c.firstElementChild;
            document.body.appendChild(c);
        }} else {{
            c.outerHTML = {json.dumps(svg)};
            c = document.querySelector('.__demo-cursor');
        }}
    }})()'''


def remove_cursor_js():
    return '''() => document.querySelector('.__demo-cursor')?.remove()'''


async def move_cursor(page, from_xy, to_xy, steps=10, dur_ms=400):
    """Animate the cursor from one position to another with eased motion."""
    await page.evaluate(cursor_js(*from_xy, clicking=False))
    await page.wait_for_timeout(50)
    for i in range(1, steps + 1):
        t = i / steps
        # ease-out cubic
        e = 1 - (1 - t) ** 3
        x = from_xy[0] + (to_xy[0] - from_xy[0]) * e
        y = from_xy[1] + (to_xy[1] - from_xy[1]) * e
        await page.evaluate(cursor_js(x, y, clicking=False))
        await page.wait_for_timeout(dur_ms // steps)


async def click_with_cursor(page, xy):
    """Move to position, press-down (click effect), click, release."""
    await page.evaluate(cursor_js(*xy, clicking=True))
    await page.wait_for_timeout(80)
    await page.mouse.click(xy[0], xy[1])
    await page.wait_for_timeout(40)
    await page.evaluate(cursor_js(*xy, clicking=False))


async def run():
    print(f'→ {URL}', flush=True)

    # Pre-generate the demo WAV
    wav_path = OUT_DIR / 'demo-voice.wav'
    make_demo_wav(wav_path)
    wav_b64 = base64.b64encode(wav_path.read_bytes()).decode()
    wav_data_url = f'data:audio/wav;base64,{wav_b64}'

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        )
        ctx = await browser.new_context(
            viewport={'width': VIEWPORT_W, 'height': VIEWPORT_H},
            device_scale_factor=DPR,
        )
        page = await ctx.new_page()

        await page.goto(URL, wait_until='domcontentloaded', timeout=30_000)
        await page.wait_for_selector('.model-card', timeout=15_000)
        await page.wait_for_timeout(1500)

        # Hide the WebGPU/CPU fallback banner. It's accurate in real
        # headless but visually noisy in a demo.
        await page.evaluate('''() => {
            document.querySelectorAll('.gpu-status').forEach(el => el.remove());
            document.querySelectorAll('[role="status"]').forEach(el => {
                if (/WebGPU|CPU fallback/i.test(el.textContent || '')) el.remove();
            });
        }''')

        # ===== PHASE 1: Model selection =====
        await page.evaluate(f'window.scrollTo({{top: {SCROLL_PHASE_1}, behavior: "instant"}})')
        await page.wait_for_timeout(400)

        # Cursor off-screen at start
        await page.evaluate(cursor_js(640, -100))
        await shot(page, '01-landing', hold_ms=400)

        # Cursor enters, hovers Kitten Nano, clicks it
        kitten_card = await page.evaluate('''() => {
            const c = document.querySelector('.model-card[data-model-id="kitten-nano"]');
            const r = c.getBoundingClientRect();
            return {x: r.left + r.width * 0.3, y: r.top + r.height * 0.4};
        }''')
        await move_cursor(page, (640, -100), (kitten_card['x'], kitten_card['y']), steps=12, dur_ms=600)
        await page.wait_for_timeout(150)
        await shot(page, '02-hover-kitten', hold_ms=300)
        await click_with_cursor(page, (kitten_card['x'], kitten_card['y']))
        await page.wait_for_timeout(400)
        await shot(page, '03-kitten-selected', hold_ms=300)

        # Click "Download & Load Model" — synthesize the loaded state
        load_btn = await page.evaluate('''() => {
            const b = document.getElementById('load-btn');
            const r = b.getBoundingClientRect();
            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
        }''')
        await move_cursor(page, (kitten_card['x'], kitten_card['y']),
                          (load_btn['x'], load_btn['y']), steps=10, dur_ms=400)
        await click_with_cursor(page, (load_btn['x'], load_btn['y']))
        await page.wait_for_timeout(200)

        # Inject loaded state
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
        }''')
        await page.wait_for_timeout(500)
        await shot(page, '04-loaded', hold_ms=400)

        # ===== SMOOTH SCROLL: phase 1 → phase 2 =====
        await smooth_scroll_capture(page, SCROLL_PHASE_1, SCROLL_PHASE_2,
                                     'scroll1-2', dur_ms=700)

        # ===== PHASE 2: Text input =====
        await page.evaluate(f'window.scrollTo({{top: {SCROLL_PHASE_2}, behavior: "instant"}})')
        await page.wait_for_timeout(300)

        # Park cursor off-screen during the still frame
        await page.evaluate(cursor_js(640, -100))
        await shot(page, '05-textarea-view', hold_ms=350)

        # Get textarea position — use page.locator + scroll_into_view
        # to be safe, then re-query
        ta_xy = await page.evaluate('''() => {
            const t = document.getElementById('text-input');
            t.scrollIntoView({block: 'center'});
            const r = t.getBoundingClientRect();
            return {x: r.left + r.width * 0.6, y: r.top + r.height * 0.5};
        }''')
        # The above scrolls but we don't want that for the still — undo
        await page.evaluate(f'window.scrollTo({{top: {SCROLL_PHASE_2}, behavior: "instant"}})')
        await page.wait_for_timeout(200)

        # Cursor enters, hovers over the textarea briefly, then we
        # fill the value directly via page.fill (more reliable than
        # keyboard.type + Ctrl+A which the browser sometimes ignores
        # when the textarea has prefilled content).
        await move_cursor(page, (640, -100), (ta_xy['x'], ta_xy['y']), steps=10, dur_ms=400)
        await click_with_cursor(page, (ta_xy['x'], ta_xy['y']))
        await page.fill('#text-input', '')

        # Type the sample text char-by-char so the GIF shows typing
        for i, ch in enumerate(SAMPLE_TEXT):
            await page.keyboard.type(ch, delay=10)
            # Capture every 5th char so the typing reads as motion
            if i % 5 == 0:
                await shot(page, f'06-typing-{i:02d}')

        await shot(page, '06-typed-done', hold_ms=300)

        # Click "Add to queue" — use page.click by selector for
        # reliability instead of coordinate-based click which can
        # miss if the button moved between scrollIntoView and click.
        gen_rect = await page.evaluate('''() => {
            const b = document.getElementById('generate-btn');
            b.scrollIntoView({block: 'center'});
            const r = b.getBoundingClientRect();
            return {x: r.left + r.width * 0.5, y: r.top + r.height * 0.5};
        }''')
        # Restore scroll to phase 2 position so the button is back
        # in our chosen framing
        await page.evaluate(f'window.scrollTo({{top: {SCROLL_PHASE_2}, behavior: "instant"}})')
        await page.wait_for_timeout(200)
        # Move cursor to button
        await move_cursor(page, (ta_xy['x'], ta_xy['y']),
                          (gen_rect['x'], gen_rect['y']), steps=8, dur_ms=350)
        await click_with_cursor(page, (gen_rect['x'], gen_rect['y']))
        # Belt and suspenders: also dispatch a real click
        try:
            await page.click('#generate-btn', timeout=500)
        except Exception:
            pass
        await page.wait_for_timeout(500)
        await shot(page, '07-submitted', hold_ms=200)

        # ===== SMOOTH SCROLL: phase 2 → phase 3 =====
        await smooth_scroll_capture(page, SCROLL_PHASE_2, SCROLL_PHASE_3,
                                     'scroll2-3', dur_ms=700)

        # ===== PHASE 3: Queue area =====
        # Hide cursor for the queue still frame
        await page.evaluate(remove_cursor_js())
        await page.wait_for_timeout(150)
        await shot(page, '08-queued', hold_ms=300)

        # Animate pending → generating → done.
        # We'll inject a progress bar inside the job card that fills
        # over 2 seconds, then swap the card to "done" with real audio.

        # Inject the progress bar into the existing job card
        await page.evaluate(f'''(audioSrc) => {{
            const card = document.querySelector('.job-card');
            if (!card) return;
            card.classList.remove('job-card--pending', 'job-card--generating');
            card.classList.add('job-card--generating');
            const body = card.querySelector('.job-card__body');
            if (body) {{
                body.innerHTML = `
                    <div class="job-card__hint">Generating… <span data-elapsed>0.0s</span></div>
                    <div style="height:6px;background:var(--bg-surface);border-radius:3px;overflow:hidden;margin-top:8px;">
                        <div data-progress style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),#a855f7);transition:width 0.15s linear;"></div>
                    </div>`;
            }}
        }}''', wav_data_url)
        await page.wait_for_timeout(200)

        # 16 frames over 1.6s — progress 0→100%, elapsed ticks 0.0→1.6s
        gen_frames = 16
        gen_duration_ms = 1600
        for i in range(gen_frames):
            pct = (i + 1) / gen_frames * 100
            elapsed = (i + 1) / gen_frames * (gen_duration_ms / 1000)
            await page.evaluate(f'''() => {{
                const fill = document.querySelector('[data-progress]');
                if (fill) fill.style.width = '{pct:.0f}%';
                const e = document.querySelector('[data-elapsed]');
                if (e) e.textContent = '{elapsed:.1f}s';
            }}''')
            await shot(page, f'09-generating-{i:02d}', hold_ms=gen_duration_ms // gen_frames)

        # Swap to done state with the real audio src + a procedural WAV
        await page.evaluate(f'''(audioSrc) => {{
            const card = document.querySelector('.job-card');
            if (!card) return;
            card.classList.remove('job-card--generating');
            card.classList.add('job-card--done');
            const status = card.querySelector('.job-card__status');
            if (status) status.innerHTML = '<span class="status-dot status-dot--done" title="Done">✓</span>';
            const body = card.querySelector('.job-card__body');
            if (body) {{
                body.innerHTML = `
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                        <audio controls preload="metadata" data-job-id="demo" src="${{audioSrc}}" style="flex:1;min-width:240px;height:32px;"></audio>
                        <button class="job-card__btn" data-action="download" data-job-id="demo" style="white-space:nowrap;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download WAV
                        </button>
                    </div>
                    <div class="job-card__actions" style="margin-top:6px;">
                        <span class="job-card__meta">3.0s · 3.0s audio</span>
                    </div>`;
            }}
            const label = document.getElementById('queue-label');
            if (label) label.style.display = '';
        }}''', wav_data_url)
        await page.wait_for_timeout(400)

        # Click the audio play button — moves the playhead, makes the
        # GIF definitively "playing audio" rather than just "showing"
        audio_xy = await page.evaluate('''() => {
            const a = document.querySelector('.job-card audio');
            if (!a) return null;
            a.scrollIntoView({block: 'center'});
            const r = a.getBoundingClientRect();
            // Play button is ~28px from the left of the audio element
            return {x: r.left + 28, y: r.top + r.height / 2};
        }''')
        if audio_xy is None:
            # Job card wasn't created — fall back to a fixed position
            print('  WARN: no audio element found, using fallback', flush=True)
            audio_xy = {'x': 640, 'y': 400}
        # Restore scroll to phase 3
        await page.evaluate(f'window.scrollTo({{top: {SCROLL_PHASE_3}, behavior: "instant"}})')
        await page.wait_for_timeout(200)

        # Move cursor back on-screen, then click play
        await page.evaluate(cursor_js(audio_xy['x'], audio_xy['y']))
        await page.wait_for_timeout(200)
        await shot(page, '10-done-cursor-aim', hold_ms=200)
        await click_with_cursor(page, (audio_xy['x'], audio_xy['y']))
        await page.wait_for_timeout(200)

        # Capture 6 frames of "playing" — the playhead advances
        for i in range(8):
            await shot(page, f'11-playing-{i:02d}', hold_ms=180)

        # Final: clean static frame for the loop tail. Re-show the
        # last playing-frame state (cursor already removed) so the
        # GIF ends on the "audio playing in a job card" moment.
        await page.evaluate(remove_cursor_js())
        await page.wait_for_timeout(200)
        # Re-inject the done state in case the cursor removal left
        # the page in a weird state
        await page.evaluate(f'''(audioSrc) => {{
            const a = document.querySelector('.job-card audio');
            if (a && !a.paused) a.pause();
        }}''', wav_data_url)
        await page.wait_for_timeout(100)
        await shot(page, '99-end', hold_ms=200)

        await ctx.close()
        await browser.close()


def compose_browser_chrome(frames_dir: Path, out_dir: Path,
                            dst_w: int, dst_h: int,
                            label: str = 'Yapper — Private TTS',
                            url: str = 'phantomic12.github.io/yapper/'):
    """Wrap each raw frame in a fake browser window.

    The captured screenshots are 2x (2560x1440 at DPR=2 for 1280x720).
    We downscale to dst_w x dst_h, draw a window chrome above, then
    save as composite frames ready for ffmpeg.
    """
    chrome_h = 44  # title bar height in composite pixels
    shadow_pad = 16
    win_w = dst_w
    win_h = dst_h + chrome_h

    # Background (subtle gradient — desk wallpaper-ish)
    bg = np.zeros((win_h + shadow_pad * 2, win_w + shadow_pad * 2, 3), dtype=np.uint8)
    bg[:] = (28, 30, 38)  # dark slate

    fonts = _load_fonts()

    raw_frames = sorted(frames_dir.glob('f*.png'))
    composite_dir = out_dir / 'frames_composite'
    if composite_dir.exists():
        shutil.rmtree(composite_dir)
    composite_dir.mkdir()

    for f in raw_frames:
        img = Image.open(f).convert('RGB')
        # Downscale from 2x DPR to 1x
        img = img.resize((dst_w, dst_h), Image.Resampling.LANCZOS)

        # Composite onto background with shadow
        canvas = Image.fromarray(bg).copy()
        # Soft drop shadow under the window
        shadow = Image.new('RGBA', (win_w + 24, win_h + 24), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle((0, 0, win_w + 23, win_h + 23), radius=14,
                             fill=(0, 0, 0, 110))
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=10))
        canvas_rgba = canvas.convert('RGBA')
        canvas_rgba.alpha_composite(shadow, (shadow_pad - 12, shadow_pad - 8))
        canvas = canvas_rgba.convert('RGB')

        # Window background (the screenshot area)
        d = ImageDraw.Draw(canvas)
        d.rounded_rectangle((shadow_pad, shadow_pad,
                              shadow_pad + win_w - 1, shadow_pad + win_h - 1),
                             radius=12, fill=(15, 17, 24))

        # Paste screenshot
        canvas.paste(img, (shadow_pad, shadow_pad + chrome_h))

        # Title bar background
        d = ImageDraw.Draw(canvas)
        d.rounded_rectangle((shadow_pad, shadow_pad,
                              shadow_pad + win_w - 1, shadow_pad + chrome_h),
                             radius=12, fill=(32, 34, 42))
        # Hide bottom rounded corners of title bar
        d.rectangle((shadow_pad, shadow_pad + chrome_h - 12,
                     shadow_pad + win_w - 1, shadow_pad + chrome_h),
                    fill=(32, 34, 42))

        # Traffic lights
        light_y = shadow_pad + chrome_h // 2
        light_x = shadow_pad + 18
        for color in [(255, 95, 86), (255, 189, 46), (39, 201, 63)]:
            d.ellipse((light_x - 6, light_y - 6, light_x + 6, light_y + 6),
                      fill=color)
            light_x += 20

        # Title bar text (centered)
        if fonts['ui']:
            title = label
            tw = d.textlength(title, font=fonts['ui'])
            d.text((shadow_pad + win_w / 2 - tw / 2, light_y - 9),
                   title, fill=(220, 222, 230), font=fonts['ui'])
            # URL on right
            uw = d.textlength(url, font=fonts['ui_small'])
            d.text((shadow_pad + win_w - uw - 16, light_y - 7),
                   url, fill=(140, 144, 158), font=fonts['ui_small'])

        canvas.save(composite_dir / f.name, optimize=True)

    return composite_dir


def _load_fonts():
    """Load fonts we know exist on the system."""
    candidates_ui = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/ubuntu/Ubuntu-Regular.ttf',
    ]
    candidates_small = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    ui = None
    ui_small = None
    for c in candidates_ui:
        if os.path.exists(c):
            try:
                ui = ImageFont.truetype(c, 14)
                ui_small = ImageFont.truetype(c, 11)
                break
            except Exception:
                pass
    return {'ui': ui, 'ui_small': ui_small}


def add_intro_slate(composite_dir: Path, dst_w: int, dst_h: int,
                    chrome_h: int = 44, shadow_pad: int = 16):
    """Prepend a 0.5s intro slate showing the product name + tagline.

    The intro frames are named so they sort BEFORE the composite
    frames in lexicographic order, ensuring they appear first in
    the GIF (which iterates frames in sorted order).
    """
    win_w = dst_w
    win_h = dst_h + chrome_h
    canvas_w = win_w + shadow_pad * 2
    canvas_h = win_h + shadow_pad * 2

    fonts = _load_fonts()
    headline_font = None
    body_font = None
    for path in ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
                 '/usr/share/fonts/truetype/ubuntu/Ubuntu-Bold.ttf']:
        if os.path.exists(path):
            try:
                headline_font = ImageFont.truetype(path, 56)
                # Body font — strip -Bold suffix if present, but
                # 'Bold' is a substring of '-Bold.ttf' too, so use
                # an explicit mapping.
                body_path = {
                    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf':
                        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                    '/usr/share/fonts/truetype/ubuntu/Ubuntu-Bold.ttf':
                        '/usr/share/fonts/truetype/ubuntu/Ubuntu-Regular.ttf',
                }.get(path)
                if body_path and os.path.exists(body_path):
                    body_font = ImageFont.truetype(body_path, 22)
                break
            except Exception:
                pass

    slate = Image.new('RGB', (canvas_w, canvas_h), (15, 17, 24))
    d = ImageDraw.Draw(slate)
    if headline_font and body_font:
        title = 'Yapper'
        subtitle = 'Text-to-speech that runs entirely in your browser.'
        tw = d.textlength(title, font=headline_font)
        d.text(((canvas_w - tw) / 2, canvas_h / 2 - 80),
               title, fill=(168, 145, 255), font=headline_font)
        sw = d.textlength(subtitle, font=body_font)
        d.text(((canvas_w - sw) / 2, canvas_h / 2 + 4),
               subtitle, fill=(200, 204, 218), font=body_font)
    else:
        # Fallback — write "YAPPER" with default font so the slate
        # isn't blank
        print('  WARN: intro slate fonts not loaded, using default',
              flush=True)
        try:
            d.text((canvas_w // 2 - 60, canvas_h // 2 - 16),
                   'YAPPER', fill=(168, 145, 255))
        except Exception:
            pass

    # 12 frames at 24fps = 0.5s. Name them 0000_intro-N so they sort
    # before the 0001_* composite frames.
    intro_dir = composite_dir.parent / 'frames_with_intro'
    if intro_dir.exists():
        shutil.rmtree(intro_dir)
    intro_dir.mkdir()
    for i in range(12):
        slate.save(intro_dir / f'a{i:04d}_intro.png', optimize=True)
    # Then copy all composite frames in (their names start with b/f,
    # so they sort after the intro)
    for f in sorted(composite_dir.glob('*.png')):
        shutil.copy(f, intro_dir / f.name)
    return intro_dir


def build_gif(frames_dir: Path, out_path: Path, fps: int = 24,
              scale_w: int = 1280):
    """Build the final GIF via two-pass palette."""
    frames = sorted(frames_dir.glob('*.png'))
    if not frames:
        raise SystemExit('no frames to assemble')

    # ffmpeg wants a numeric pattern. Renumber.
    seq = frames_dir.parent / 'seq'
    if seq.exists():
        shutil.rmtree(seq)
    seq.mkdir()
    for i, f in enumerate(frames):
        # Symlink instead of copy to save IO
        (seq / f'f_{i:05d}.png').symlink_to(f.absolute())

    # Per-frame durations. Tight on action, longer on static beats.
    durations = []
    for f in frames:
        n = f.name
        if n.startswith('i'):
            durations.append(1 / fps)
        elif '99-end' in n:
            durations.append(2.0)
        elif 'scroll' in n:
            durations.append(1 / fps)  # dense — that's the motion
        elif '01-landing' in n:
            durations.append(0.7)
        elif '02-hover' in n:
            durations.append(0.5)
        elif '03-kitten-selected' in n:
            durations.append(0.6)
        elif '04-loaded' in n:
            durations.append(0.7)
        elif '05-textarea-view' in n:
            durations.append(0.5)
        elif '06-typing' in n:
            durations.append(0.1)  # very tight — typing is fast
        elif '06-typed-done' in n:
            durations.append(0.6)
        elif '07-submitted' in n:
            durations.append(0.4)
        elif '08-queued' in n:
            durations.append(0.6)
        elif '09-generating' in n:
            durations.append(0.12)  # tight — core "doing work"
        elif '10-done-cursor-aim' in n:
            durations.append(0.5)
        elif '11-playing' in n:
            durations.append(0.2)
        else:
            durations.append(0.3)

    concat = frames_dir.parent / 'concat.txt'
    lines = [f"file '{f.absolute()}'\nduration {d}" for f, d in zip(frames, durations)]
    lines.append(f"file '{frames[-1].absolute()}'")
    concat.write_text('\n'.join(lines))

    palette = frames_dir.parent / 'palette.png'
    subprocess.run([
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat),
        '-vf', f'fps={fps},scale={scale_w}:-1:flags=lanczos,palettegen=stats_mode=diff',
        str(palette),
    ], check=True, capture_output=True)
    subprocess.run([
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat),
        '-i', str(palette),
        '-lavfi', f'fps={fps},scale={scale_w}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4',
        '-loop', '0',
        str(out_path),
    ], check=True, capture_output=True)


def build_mp4(frames_dir: Path, out_path: Path, fps: int = 30,
              scale_w: int = 1920):
    """Build the final MP4 at 1080p."""
    frames = sorted(frames_dir.glob('*.png'))
    if not frames:
        raise SystemExit('no frames for MP4')

    seq = frames_dir.parent / 'seq_mp4'
    if seq.exists():
        shutil.rmtree(seq)
    seq.mkdir()
    for i, f in enumerate(frames):
        (seq / f'f_{i:05d}.png').symlink_to(f.absolute())

    # For MP4 we use a constant fps input — concat demuxer honors
    # per-file durations, so we encode at a fixed fps but vary input
    # rates via the concat.
    pattern = str(seq / 'f_%05d.png')

    # Build concat file for MP4 (constant fps is fine since we
    # encoded the per-frame durations into the frame count by
    # duplicating, but we kept that simple — single fps is okay
    # because 30fps is already smooth)
    durations = []
    for f in frames:
        n = f.name
        if 'scroll' in n:
            durations.append(1)
        elif '99-end' in n:
            durations.append(60)  # 2s @ 30fps
        elif '01-landing' in n:
            durations.append(21)  # 0.7s
        elif '06-typing' in n:
            durations.append(3)   # 0.1s
        elif '09-generating' in n:
            durations.append(4)   # ~0.13s
        elif '11-playing' in n:
            durations.append(6)
        else:
            durations.append(12)  # 0.4s

    concat = frames_dir.parent / 'concat_mp4.txt'
    lines = [f"file '{f.absolute()}'" for f in frames]  # no duration → use fps
    concat.write_text('\n'.join(lines))

    subprocess.run([
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-r', str(fps),
        '-i', str(concat),
        '-vf', f'scale={scale_w}:-2:flags=lanczos',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        str(out_path),
    ], check=True, capture_output=True)


async def main():
    t0 = time.time()
    await run()
    print(f'\n[1/4] Captured {total_frames} frames in {time.time()-t0:.1f}s', flush=True)

    print('[2/4] Compositing browser chrome + intro slate...', flush=True)
    composite_dir = compose_browser_chrome(FRAMES_DIR, OUT_DIR,
                                            dst_w=VIEWPORT_W,
                                            dst_h=VIEWPORT_H)
    intro_dir = add_intro_slate(composite_dir,
                                 dst_w=VIEWPORT_W,
                                 dst_h=VIEWPORT_H)

    print('[3/4] Building GIF...', flush=True)
    build_gif(intro_dir, OUT_DIR / 'demo.gif', fps=24, scale_w=1280)

    print('[4/4] Building MP4 @ 1080p...', flush=True)
    build_mp4(intro_dir, OUT_DIR / 'demo.mp4', fps=30, scale_w=1920)

    print(f'\nDone in {time.time()-t0:.1f}s', flush=True)
    print(f'  GIF:  {OUT_DIR / "demo.gif"}  ({ (OUT_DIR / "demo.gif").stat().st_size // 1024 } KB)')
    print(f'  MP4:  {OUT_DIR / "demo.mp4"}  ({ (OUT_DIR / "demo.mp4").stat().st_size // 1024 } KB)')


if __name__ == '__main__':
    asyncio.run(main())
