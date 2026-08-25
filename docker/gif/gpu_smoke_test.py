"""
WebGPU smoke test for yapper.

The point: prove that in a real headed Chromium (with Xvfb providing
a display surface), WebGPU is exposed AND the yapper model load +
inference round-trip completes successfully.

Why this matters: headless Chromium never exposes `navigator.gpu`,
which means our CI e2e test (e2e_test.py) can verify the message-
protocol encoding of the worker but NOT that actual GPU inference
works. This script is the missing piece.

Strategy:
  1. Start an Xvfb display
  2. Launch Playwright Chromium with --use-gl=angle --use-angle=vulkan
     to force the Vulkan backend (which is what gets exposed as
     WebGPU on Linux with SwiftShader/Vulkan-Loader)
  3. Probe navigator.gpu
  4. Probe a model load (real ONNX download + parse) on the live demo
  5. Probe a single generate() round-trip via the worker
  6. Save a JSON report + a screenshot of the running page

Exit code 0 if all probes pass, 1 otherwise. Designed to be called
from a CI workflow that has GPU access (Kaggle, Colab, self-hosted
runner, etc.) and from local dev.

Usage:
  python3 gpu_smoke_test.py
  python3 gpu_smoke_test.py --url https://staging.example.com
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

URL_DEFAULT = 'https://phantomic12.github.io/yapper/'
OUT_DIR = Path('/capture/out' if Path('/capture').exists() else Path.cwd() / 'out')
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Display we'll use. :99 is the conventional Xvfb port.
DISPLAY = ':99'


def start_xvfb() -> subprocess.Popen | None:
    """Start Xvfb on DISPLAY if not already running.

    Returns the Popen handle so the caller can terminate it, or None
    if Xvfb was already running (e.g. CI pre-starts it).
    """
    # Check if a display is already responding
    if os.path.exists('/tmp/.X11-unix') and any(
        p.name.startswith('X') for p in Path('/tmp/.X11-unix').iterdir()
    ):
        return None  # already running, leave it alone

    # Xvfb: -screen 0 1280x720x24 +nolisten tcp +extension GLX +iglx
    # The +iglx +extension GLX combo is what enables Chromium's GPU
    # process to find a working GL/Vulkan context under Xvfb.
    proc = subprocess.Popen(
        ['Xvfb', DISPLAY, '-screen', '0', '1280x720x24',
         '-nolisten', 'tcp', '+extension', 'GLX', '+iglx',
         '-ac'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    # Give Xvfb a moment to bind the socket
    time.sleep(0.5)
    # Verify
    try:
        check = subprocess.run(
            ['xdpyinfo', '-display', DISPLAY],
            capture_output=True, text=True, timeout=5,
        )
        if check.returncode != 0:
            raise RuntimeError(f'Xvfb did not start: {check.stderr}')
    except FileNotFoundError:
        # xdpyinfo may not be installed; fall back to env-var check
        os.environ['DISPLAY'] = DISPLAY
    os.environ['DISPLAY'] = DISPLAY
    return proc


async def probe_webgpu(page) -> dict:
    """Probe navigator.gpu in the page and return what the GPU
    adapter reports."""
    return await page.evaluate('''async () => {
        if (!('gpu' in navigator)) {
            return { available: false, reason: 'no navigator.gpu' };
        }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return { available: false, reason: 'requestAdapter returned null' };
            const features = Array.from(adapter.features || []);
            const limits = {};
            if (adapter.limits) {
                for (const k of Object.keys(adapter.limits).slice(0, 10)) {
                    limits[k] = adapter.limits[k];
                }
            }
            const info = await (adapter.requestAdapterInfo?.() || {});
            return {
                available: true,
                vendor: info.vendor || 'unknown',
                architecture: info.architecture || 'unknown',
                device: info.device || 'unknown',
                description: info.description || 'unknown',
                featureCount: features.length,
                features: features.slice(0, 20),
                limits,
            };
        } catch (e) {
            return { available: false, reason: String(e) };
        }
    }''')


async def probe_model_load(page, model_id: str = 'kokoro-82m', timeout_ms: int = 120_000) -> dict:
    """Click the model card, then the Load button, and wait for the
    'Loaded' state. Returns a timing breakdown."""
    start = time.time()
    # Select the model
    await page.click(f'.model-card[data-model-id="{model_id}"] [data-action="pick"]')
    after_select = time.time() - start
    # Click Load
    await page.click('#load-btn')
    after_click = time.time() - start
    # Wait for the load to complete (or timeout)
    try:
        await page.wait_for_function(
            "() => document.getElementById('load-btn')?.querySelector('span')?.textContent?.includes('loaded')",
            timeout=timeout_ms,
        )
        loaded = True
    except Exception as e:
        loaded = False
    elapsed = time.time() - start
    # Grab the engine state for the report
    state = await page.evaluate('''() => {
        const fill = document.getElementById('progress-fill');
        return {
            loadLabel: document.getElementById('load-btn')?.querySelector('span')?.textContent,
            progressPct: fill ? Math.round(parseFloat(fill.style.width || '0')) : null,
        };
    }''')
    return {
        'modelId': model_id,
        'loaded': loaded,
        'secondsTotal': round(elapsed, 2),
        'secondsToSelect': round(after_select, 2),
        'secondsToClickLoad': round(after_click, 2),
        'finalState': state,
    }


async def probe_generate(page, text: str, timeout_ms: int = 60_000) -> dict:
    """Queue a real generate() and wait for the job to reach 'done'."""
    start = time.time()
    # Type text
    await page.fill('#text-input', text)
    # Click Add to queue
    await page.click('#generate-btn')
    # Wait for a job card with the .job-card--done class
    try:
        await page.wait_for_selector('.job-card--done', timeout=timeout_ms)
        done = True
    except Exception:
        done = False
    elapsed = time.time() - start
    job_state = await page.evaluate('''() => {
        const cards = Array.from(document.querySelectorAll('.job-card'));
        return cards.map(c => ({
            status: Array.from(c.classList).find(x => x.startsWith('job-card--'))?.replace('job-card--', ''),
            hasAudio: !!c.querySelector('audio[data-job-id]'),
            audioDuration: c.querySelector('audio[data-job-id]')?.duration,
        }));
    }''')
    return {
        'done': done,
        'secondsTotal': round(elapsed, 2),
        'jobs': job_state,
    }


async def _shot(page, path: Path) -> None:
    """Screenshot that can never take the harness down: a wedged or
    GPU-less renderer must cost us a missing PNG, not the whole run
    (a crash here previously aborted the kernel BEFORE the report
    was written, hiding every probe result)."""
    try:
        await page.screenshot(path=str(path), timeout=15_000)
    except Exception as e:
        print(f'  screenshot failed ({path.name}): {e}', flush=True)


def ensure_xdg_runtime_dir() -> str | None:
    """Vulkan's WSI surface path requires XDG_RUNTIME_DIR; without it every
    vkCreate*Surface fails and Chromium's GPU process dies before
    navigator.gpu can appear (run-5 failure: loader + NVIDIA ICD healthy,
    presentation broken). Desktop sessions set this for us; headless CI
    containers don't. Idempotent."""
    if os.environ.get('XDG_RUNTIME_DIR'):
        return None
    xdg = Path('/tmp/xdg-runtime') / f'runtime-{os.getuid()}'
    xdg.mkdir(parents=True, exist_ok=True)
    os.chmod(xdg, 0o700)
    os.environ['XDG_RUNTIME_DIR'] = str(xdg)
    return str(xdg)


async def run_probes(browser, report: dict) -> None:
    """Drive the live demo on an already-launched browser: page load,
    model load, generate — appending each probe's result to `report` and
    saving a screenshot at every stage. Any screenshot failure is logged
    and swallowed; only probe failures propagate."""
    ctx = await browser.new_context(
        viewport={'width': 1280, 'height': 720},
        service_workers='block',  # Don't register the yapper SW — a stale
                                  # cache from a previous session can hold
                                  # an old module bundle that breaks init.
    )
    page = await ctx.new_page()
    page.on('pageerror', lambda err: print(f'  [pageerror] {err}', flush=True))
    page.on('console', lambda msg: (
        print(f'  [console.{msg.type}] {msg.text[:200]}', flush=True)
        if msg.type in ('error', 'warning') else None
    ))

    # Navigate to the demo. Long timeout for headed Chromium: the
    # model-card grid renders after render() awaits detectWebGPU(),
    # which may block longer in headed mode.
    await page.goto(report['url'], wait_until='domcontentloaded', timeout=30_000)
    try:
        await page.wait_for_selector('.model-card', timeout=60_000)
    except Exception as e:
        # Debug screenshot + rendered HTML + live DOM state before bailing
        await _shot(page, OUT_DIR / 'gpu-smoke-error.png')
        html = await page.content()
        (OUT_DIR / 'gpu-smoke-error.html').write_text(html[:50_000])
        live_state = await page.evaluate('''() => ({
            title: document.title,
            url: location.href,
            readyState: document.readyState,
            appChildren: document.getElementById('app')?.children.length ?? 0,
            bodyText: (document.body.innerText || '').slice(0, 500),
            modelCardCount: document.querySelectorAll('.model-card').length,
        })''')
        print(f'  live DOM state: {live_state}', flush=True)
        print(f'  page load failed (no .model-card within 60s): {e}', flush=True)
        raise
    await _shot(page, OUT_DIR / 'gpu-smoke-01-loaded.png')

    # Model load
    load_result = await probe_model_load(page, report['modelId'], report['loadTimeoutMs'])
    report['modelLoad'] = load_result
    await _shot(page, OUT_DIR / 'gpu-smoke-02-model-loaded.png')
    print(f'  Model load: loaded={load_result["loaded"]} in {load_result["secondsTotal"]}s', flush=True)

    # Generate
    if load_result['loaded']:
        gen_result = await probe_generate(page, report['text'])
        report['generate'] = gen_result
        await _shot(page, OUT_DIR / 'gpu-smoke-03-generated.png')
        print(f'  Generate: done={gen_result["done"]} in {gen_result["secondsTotal"]}s', flush=True)
    else:
        report['generate'] = {'skipped': 'model load failed'}

    await ctx.close()


async def main():
    p = argparse.ArgumentParser()
    p.add_argument('--url', default=URL_DEFAULT)
    p.add_argument('--model', default='kokoro-82m', help='Model id to test (default: kokoro-82m). Use kitten-nano for smaller download.')
    p.add_argument('--text', default='Yapper GPU smoke test. The quick brown fox jumps over the lazy dog.')
    p.add_argument('--load-timeout', type=int, default=180_000, help='Max time to wait for model load, in ms')
    args = p.parse_args()

    # Must exist before ANY Vulkan consumer starts (vulkaninfo surface
    # checks, Chromium's GPU process). See ensure_xdg_runtime_dir docstring.
    xdg = ensure_xdg_runtime_dir()
    if xdg:
        print(f'set XDG_RUNTIME_DIR={xdg}', flush=True)

    xvfb = start_xvfb()
    if xvfb:
        print(f'started Xvfb on {DISPLAY}', flush=True)
    else:
        print(f'using existing X server on {DISPLAY}', flush=True)

    report = {
        'url': args.url,
        'modelId': args.model,
        'text': args.text,
        'loadTimeoutMs': args.load_timeout,
        'xvfbStarted': xvfb is not None,
        'startedAt': time.time(),
    }

    # Capture vulkaninfo diagnostics so a "WebGPU unavailable" verdict on
    # an unfamiliar image comes with evidence about the Vulkan stack it
    # actually saw (or didn't).
    vk_env = {**os.environ}
    vk = subprocess.run(['vulkaninfo', '--summary'],
                        capture_output=True, text=True, env=vk_env)
    if vk.returncode == 0:
        gpu_lines = [l.strip() for l in vk.stdout.splitlines() if 'deviceName' in l or 'driverName' in l]
        report['vulkanDevices'] = gpu_lines[:10]
        print(f'  vulkaninfo: {"; ".join(gpu_lines[:4]) or "no devices"}', flush=True)
    else:
        # Full diagnostics on failure: rc alone told us nothing in run 4
        # (kernel-side loader was healthy; ours failed under Xvfb).
        # Retry without DISPLAY to isolate whether Xlib is what's breaking
        # the loader enumeration here.
        vk_nox = subprocess.run(['vulkaninfo', '--summary'], capture_output=True,
                                text=True, env={k: v for k, v in os.environ.items()
                                                if k not in ('DISPLAY',)})
        report['vulkanDevices'] = (
            f'rc={vk.returncode} stderr={vk.stderr[-400:]!r} '
            f'noDisplay_rc={vk_nox.returncode}'
        )
        print(f'  vulkaninfo FAILED rc={vk.returncode}: {vk.stderr[-300:]!r}', flush=True)
        print(f'  vulkaninfo (no DISPLAY) rc={vk_nox.returncode}', flush=True)

    # Launch-flag attempts, most-promising first. swiftshader-webgpu is
    # deterministic on hosts without a usable GPU; plain auto lets a real
    # GPU (T4/P100) drive WebGPU directly, which is what we want on Kaggle.
    LAUNCH_FLAG_SETS = [
        ('auto', [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan,WebGPU,UseSkiaRenderer',
            '--use-angle=vulkan',
            '--use-gl=angle',
            '--enable-gpu-rasterization',
            '--ignore-gpu-blocklist',
        ]),
        ('swiftshader-webgpu', [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan,WebGPU,UseSkiaRenderer',
            '--use-vulkan=swiftshader-webgpu',
            '--use-angle=vulkan',
            '--use-gl=angle',
            '--enable-gpu-rasterization',
            '--ignore-gpu-blocklist',
        ]),
    ]

    probe_error: Exception | None = None
    try:
        async with async_playwright() as pw:
            browser = None
            for name, flags in LAUNCH_FLAG_SETS:
                candidate = await pw.chromium.launch(headless=False, args=flags)  # Headed! Required for navigator.gpu.
                ctx_probe = await candidate.new_context(
                    viewport={'width': 1280, 'height': 720},
                    service_workers='block',
                )
                probe_page = await ctx_probe.new_page()
                await probe_page.goto('about:blank')
                webgpu = await probe_webgpu(probe_page)
                await ctx_probe.close()
                print(f'  [flags={name}] WebGPU available={webgpu.get("available")}', flush=True)
                if webgpu.get('available'):
                    browser = candidate
                    report['webgpu'] = webgpu
                    report['launchFlagSet'] = name
                    break
                await candidate.close()

            if browser is None:
                # Neither flag set produced a WebGPU adapter. Capture a
                # chrome://gpu dump from one last throwaway browser so the
                # report explains WHY (run-5 lesson: 'no navigator.gpu'
                # with zero GPU-process detail is undiagnosable after the
                # fact). Best-effort: diagnostics must never mask the
                # original failure.
                try:
                    diag = await pw.chromium.launch(headless=False, args=['--no-sandbox'])
                    dpage = await diag.new_page()
                    await dpage.goto('chrome://gpu')
                    await dpage.wait_for_timeout(3000)
                    info = await dpage.evaluate('document.body.innerText.slice(0, 4000)')
                    report['chromeGpuExcerpt'] = info
                    (OUT_DIR / 'chrome-gpu.txt').write_text(info)
                    await diag.close()
                    print('  captured chrome://gpu diagnostics', flush=True)
                except Exception as e:
                    print(f'  chrome://gpu capture failed: {e}', flush=True)
                report.setdefault('webgpu', webgpu)
                report['launchFlagSet'] = 'none-succeeded'
                probe_error = RuntimeError(
                    f'No WebGPU adapter under any launch flag set '
                    f'(tried {[n for n, _ in LAUNCH_FLAG_SETS]})'
                )
                print(f'  {probe_error}', flush=True)
            else:
                await run_probes(browser, report)

    finally:
        if xvfb is not None:
            xvfb.terminate()
            try:
                xvfb.wait(timeout=5)
            except subprocess.TimeoutExpired:
                xvfb.kill()

    report['finishedAt'] = time.time()
    report['durationSeconds'] = round(report['finishedAt'] - report['startedAt'], 2)
    if probe_error is not None:
        report['error'] = str(probe_error)
    # The report is written on EVERY path — success, probe failure, or
    # exception — so the kernel-side gate always gates on evidence.
    report_path = OUT_DIR / 'gpu-smoke-report.json'
    try:
        report_path.write_text(json.dumps(report, indent=2))
    except Exception as e:
        print(f'  WARNING: report write failed: {e}', flush=True)
    print(f'\nReport: {report_path}', flush=True)

    # Exit code: non-zero if WebGPU was unavailable, or if the load/generate failed
    failed = (
        probe_error is not None
        or not report.get('webgpu', {}).get('available')
        or not report.get('modelLoad', {}).get('loaded')
    )
    if report.get('generate', {}).get('done') is False:
        failed = True
    print(f'\nResult: {"FAIL" if failed else "PASS"}', flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    asyncio.run(main())
