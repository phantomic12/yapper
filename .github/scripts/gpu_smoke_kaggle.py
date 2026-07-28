"""
Kaggle kernel script for the yapper GPU smoke test.

Runs on Kaggle's free GPU tier (typically T4 or P100) with proper
display passthrough — a real GPU is visible to the GPU process,
which is the missing piece in our WSL2 dev environment.

This is the entry point for the Kaggle Action in .github/workflows/
gpu-smoke.yml. The action uploads this script + the yapper repo
to a Kaggle kernel, runs it, and reports back the exit code.

Pipeline:
  1. Clone the yapper repo (or download just the docker/ subdir)
  2. Build the yapper-gif-capture image (CUDA + Chromium)
  3. Run gpu_smoke_test.py inside the container, --gpus all
  4. Parse the JSON report, copy it to /kaggle/working/
  5. Exit 0 if all probes pass, 1 otherwise

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


def log(msg):
    print(f'[yapper-gpu-smoke] {msg}', flush=True)


def run(cmd, **kwargs):
    log(f'$ {" ".join(cmd) if isinstance(cmd, list) else cmd}')
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=True, **kwargs)


def main():
    KAGGLE_WORKING.mkdir(parents=True, exist_ok=True)

    # 1. Clone the yapper repo. Kaggle kernels start with an empty
    #    /kaggle/working/, so we pull fresh each run.
    if REPO_DIR.exists():
        run(['rm', '-rf', str(REPO_DIR)])
    run(['git', 'clone', f'https://github.com/{REPO}.git', str(REPO_DIR)])

    os.chdir(REPO_DIR)

    # 2. nvidia-smi check — verify the GPU is actually visible.
    smi = subprocess.run(['nvidia-smi'], capture_output=True, text=True)
    log(f'nvidia-smi:\n{smi.stdout}')
    if 'NVIDIA' not in smi.stdout:
        log('no GPU visible, aborting')
        sys.exit(2)

    # 3. Build the GPU test image. This is the same image the
    #    local scripts/capture-gif.sh builds — CUDA 12.4 base +
    #    Chromium + Vulkan + Playwright + xvfb.
    run(['docker', 'build', '-t', 'yapper-gif-capture', 'docker/gif/'],
        cwd=REPO_DIR, timeout=900)

    # 4. Run the GPU smoke test inside the container. --gpus all
    #    exposes the host's GPU; xvfb is started by the script.
    run([
        'docker', 'run', '--rm', '--gpus', 'all',
        '-v', f'{KAGGLE_WORKING}:/kaggle/working',
        '--entrypoint', 'python3',
        'yapper-gif-capture',
        '/capture/gpu_smoke_test.py',
        '--url', 'https://phantomic12.github.io/yapper/',
        '--model', 'kitten-nano',  # smallest model, fastest load
        '--load-timeout', '300000',
    ], timeout=900)

    # 5. Copy the report + screenshots to /kaggle/working/ so they
    #    show up as kernel output for the GitHub Action to pick up.
    src_report = REPO_DIR / 'out' / 'gpu-smoke-report.json'
    if src_report.exists():
        shutil.copy(src_report, REPORT_OUT)
        log(f'report copied to {REPORT_OUT}')
        # Print the verdict prominently
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
