"""
Kaggle kernel script for the yapper GPU smoke test.

Runs on Kaggle's free GPU tier (typically T4 or P100). Kaggle kernels
are already Docker containers — there is no Docker daemon inside them,
so the old approach of `docker build` + `docker run --gpus all` can
never work (the kernel dies with KernelWorkerStatus.ERROR before any
probe runs). Instead, this script installs the probe's dependencies
directly into the kernel environment (Chromium, Xvfb, Mesa/Vulkan
drivers, Playwright) and runs the same `gpu_smoke_test.py` probe
in-process, headless-with-Xvfb just like the old Docker image did.

This is the entry point for the Kaggle Action in .github/workflows/
gpu-smoke.yml. The workflow pushes this script + the yapper repo to a
Kaggle kernel, runs it, and reports back the exit code.

Pipeline:
  1. apt-get the system deps the probe needs (xvfb, X11 utils,
     Mesa Vulkan drivers, Chromium deps)
  2. Clone the yapper repo into /kaggle/working/
  3. pip-install playwright and its Chromium build
  4. Run docker/gif/gpu_smoke_test.py directly (it starts its own
     Xvfb and drives Chromium via Playwright)
  5. Copy the JSON report + screenshots to /kaggle/working/ so they
     show up as kernel output the GitHub Action can pick up
  6. Exit 0 if all probes pass, 1 otherwise

Why a custom kernel instead of just running tests in the
GitHub-hosted runner: we need an actual GPU with display
passthrough. The CI workflow for the rest of the project
(unit tests, typecheck, build, link-health) is unchanged —
that's still .github/workflows/ci.yml.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = 'phantomic12/yapper'
KAGGLE_WORKING = Path('/kaggle/working')
REPO_DIR = KAGGLE_WORKING / 'yapper'
REPORT_OUT = KAGGLE_WORKING / 'gpu-smoke-report.json'

# Mirrors docker/gif/Dockerfile's apt surface, minus CUDA (the kernel
# already has the NVIDIA driver + CUDA runtime from Kaggle's base image).
APT_DEPS = [
    'xvfb', 'xauth', 'x11-utils',
    'libnss3', 'libatk1.0-0', 'libatk-bridge2.0-0', 'libcups2',
    'libxkbcommon0', 'libxcomposite1', 'libxdamage1', 'libxext6',
    'libxfixes3', 'libxss1', 'libasound2', 'libgbm1', 'libpango-1.0-0',
    'libcairo2', 'libx11-6', 'libxcb1', 'libxrandr2', 'libxi6',
    'mesa-vulkan-drivers', 'vulkan-tools', 'fonts-liberation', 'fonts-dejavu',
]


def log(msg):
    print(f'[yapper-gpu-smoke] {msg}', flush=True)


def run(cmd, **kwargs):
    log(f'$ {" ".join(cmd) if isinstance(cmd, list) else cmd}')
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=True, **kwargs)


def main():
    KAGGLE_WORKING.mkdir(parents=True, exist_ok=True)

    # 1. System deps. apt-get needs a non-interactive env; Kaggle
    #    kernels run as root inside a Debian container so this works.
    log('installing system dependencies')
    run(['apt-get', 'update', '-qq'])
    run(['apt-get', 'install', '-y', '-qq', '--no-install-recommends'] + APT_DEPS,
        timeout=600)

    # 2. Clone the yapper repo. Kaggle kernels start with an empty
    #    /kaggle/working/, so we pull fresh each run.
    if REPO_DIR.exists():
        run(['rm', '-rf', str(REPO_DIR)])
    run(['git', 'clone', '--depth', '1', f'https://github.com/{REPO}.git', str(REPO_DIR)])

    os.chdir(REPO_DIR)

    # 3. nvidia-smi check — verify the GPU is actually visible.
    smi = subprocess.run(['nvidia-smi'], capture_output=True, text=True)
    log(f'nvidia-smi:\n{smi.stdout}')
    if 'NVIDIA' not in smi.stdout:
        log('no GPU visible, aborting')
        sys.exit(2)

    # 4. Playwright + Chromium. The wheel ships its own Chromium
    #    download; `install chromium` grabs the matching build.
    run([sys.executable, '-m', 'pip', 'install', '-q', 'playwright'])
    run([sys.executable, '-m', 'playwright', 'install', '--with-deps', 'chromium'],
        timeout=600)

    # 5. Run the probe. gpu_smoke_test.py starts its own Xvfb on :99,
    #    launches headed Chromium with --use-vulkan=swiftshader-webgpu
    #    and --enable-unsafe-webgpu, then probes the LIVE demo site:
    #    navigator.gpu -> model load -> generate() round-trip.
    run([
        sys.executable, 'docker/gif/gpu_smoke_test.py',
        '--url', 'https://phantomic12.github.io/yapper/',
        '--model', 'kitten-nano',      # smallest model, fastest load
        '--load-timeout', '300000',
    ], timeout=1500)

    # 6. Copy the report + screenshots to /kaggle/working/ so they
    #    show up as kernel output for the GitHub Action to pick up.
    src_report = REPO_DIR / 'out' / 'gpu-smoke-report.json'
    if src_report.exists():
        shutil.copy(src_report, REPORT_OUT)
        log(f'report copied to {REPORT_OUT}')
        report = json.loads(src_report.read_text())
        webgpu = report.get('webgpu', {})
        model_load = report.get('modelLoad', {})
        gen = report.get('generate', {})
        log(f'  WebGPU:    available={webgpu.get("available")}  vendor={webgpu.get("vendor")!r}')
        log(f'  Model load: {model_load.get("loaded")} in {model_load.get("secondsTotal", "?")}s')
        log(f'  Generate:  {gen.get("done")} in {gen.get("secondsTotal", "?")}s')

        failed = (
            not webgpu.get('available')
            or not model_load.get('loaded')
            or gen.get('done') is False
        )
        if failed:
            log('OVERALL: FAIL')
            sys.exit(1)
        log('OVERALL: PASS')
    else:
        log(f'no report found at {src_report}, treating as failure')
        sys.exit(1)


if __name__ == '__main__':
    main()