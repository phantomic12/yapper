"""
Kaggle kernel script for the yapper GPU smoke test.

Runs on Kaggle's free GPU tier (typically T4 or P100). Kaggle kernels
are already Docker containers — there is no Docker daemon inside them,
so the old approach of `docker build` + `docker run --gpus all` died
with KernelWorkerStatus.ERROR before any probe ran. Instead, this script
installs the probe's dependencies directly into the kernel environment
(Xvfb, X11 utils, Mesa/Vulkan drivers, Chromium via Playwright) and runs
the repo's docker/gif/gpu_smoke_test.py in-process.

This is the entry point pushed to Kaggle by .github/workflows/
gpu-smoke.yml. The workflow pushes this file, polls the kernel, and
gates on gpu-smoke-report.json — a runner boot alone cannot go green.

Pipeline:
  1. Purge any stale outputs from previous runs of this kernel
  2. apt-get the system deps the probe needs (xvfb, X11 utils,
     Mesa Vulkan drivers, Chromium deps)
  3. Clone the yapper repo at GIT_REF (baked in by make_kernel_script.py)
  4. pip-install playwright and its matching Chromium build
  5. Run docker/gif/gpu_smoke_test.py directly (it starts its own
     Xvfb and drives headed Chromium with WebGPU flags)
  6. Copy the JSON report + screenshots to /kaggle/working/ so they
     show up as kernel output for the workflow to verify
  7. Exit non-zero unless every probe passed

Why a custom kernel instead of just running tests in the GitHub-hosted
runner: we need an actual GPU with display passthrough, which hosted
runners don't have.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Baked in at push time by .github/scripts/make_kernel_script.py.
GIT_REF = 'main'
GIT_FETCH = ''

REPO = 'phantomic12/yapper'
KAGGLE_WORKING = Path('/kaggle/working')
REPO_DIR = KAGGLE_WORKING / 'yapper'
REPORT_OUT = KAGGLE_WORKING / 'gpu-smoke-report.json'

# Only what Playwright's `install --with-deps` does NOT cover: the X
# server for headed Chromium, tiny X helpers, the system Vulkan driver,
# and fonts. Every lib* entry from the old list is redundant here and
# just adds mirror-flakiness exposure.
APT_DEPS = [
    'xvfb', 'xauth', 'x11-utils',
    'mesa-vulkan-drivers', 'vulkan-tools',
    'fonts-liberation', 'fonts-dejavu',
]

STALE_OUTPUTS = [REPORT_OUT] + sorted(KAGGLE_WORKING.glob('*.png'))

# Slow-mirror defenses for apt: retry each fetch, time each transfer out
# at 60s (a healthy mirror serves any single package in seconds), and
# cap the total pipeline at 120s per operation.
APT_SLOW = [
    '-o', 'Acquire::Retries=5',
    '-o', 'Acquire::http::Timeout=60',
    '-o', 'Acquire::https::Timeout=60',
]


def log(msg):
    print(f'[yapper-gpu-smoke] {msg}', flush=True)


PROXY_KEYS = ('https_proxy', 'HTTPS_PROXY',
              'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY')


def detect_proxy():
    """Kaggle kernels have no outbound DNS; internet access goes through
    an HTTP proxy exported in the environment (pip and git honor those
    variables automatically — apt does not)."""
    for key in PROXY_KEYS:
        value = os.environ.get(key, '').strip()
        if value:
            return key, value.rstrip('/')
    return None, None


def configure_apt_proxy(proxy):
    conf = Path('/etc/apt/apt.conf.d/95yapper-proxy')
    conf.write_text(
        f'Acquire::http::Proxy "{proxy}";\n'
        f'Acquire::https::Proxy "{proxy}";\n')
    log(f'apt proxy written to {conf}')


def probe_connectivity():
    """Log one cheap HTTPS round-trip so the kernel log shows network
    health up front instead of failing obscurely minutes later."""
    import urllib.request
    try:
        with urllib.request.urlopen('https://pypi.org/simple/', timeout=20):
            log('connectivity probe: pypi.org reachable OK')
            return True
    except Exception as exc:
        log(f'connectivity probe FAILED: {exc}')
        return False


def run(cmd, **kwargs):
    log(f'$ {" ".join(cmd) if isinstance(cmd, list) else cmd}')
    return subprocess.run(cmd, check=True,
                          **{'timeout': 600, **kwargs})


def run_retry(cmd, attempts=3, **kwargs):
    """Run a command, retrying transient failures (Kaggle mirrors are
    occasionally very slow — an unattended apt has been observed to sit
    minutes without output before finishing)."""
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return run(cmd, **kwargs)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
            last = exc
            log(f'attempt {attempt}/{attempts} failed ({exc}); '
                f'retrying after 15s')
            time.sleep(15)
    assert last is not None
    raise last


def main():
    KAGGLE_WORKING.mkdir(parents=True, exist_ok=True)

    # 0. Purge stale artifacts so /kaggle/working/ can only ever contain
    #    THIS run's report. Without this, a failed rerun could surface a
    #    stale green report from an earlier successful kernel run.
    for stale in STALE_OUTPUTS:
        if stale.exists():
            stale.unlink()
            log(f'purged stale artifact {stale}')

    # 1. Connectivity + system deps. Kaggle kernels have no outbound DNS;
    #    internet goes through a proxy exported in the environment. pip
    #    and git honor it automatically, apt needs it spelled out.
    key, proxy = detect_proxy()
    if not proxy:
        log(f'no proxy env found ({", ".join(PROXY_KEYS)}); '
            f'checking raw connectivity anyway')
        if not probe_connectivity():
            log('no proxy AND no direct internet — Kaggle "Internet" '
                'setting is off or broken; aborting early')
            sys.exit(3)
    else:
        log(f'using proxy from {key}')
        configure_apt_proxy(proxy)
        probe_connectivity()

    log('installing system dependencies')
    run_retry(['apt-get', 'update', '-qq'] + APT_SLOW,
              attempts=2, timeout=600)
    run_retry(['apt-get', 'install', '-y', '-qq', '--no-install-recommends']
              + APT_SLOW + APT_DEPS, attempts=2, timeout=900)

    # 2. Clone the yapper repo at the ref under test. PR runs fetch the
    #    merge commit explicitly; branch/tag runs clone it directly.
    if REPO_DIR.exists():
        run(['rm', '-rf', str(REPO_DIR)])
    if GIT_FETCH:
        run(['git', 'clone', '--depth', '1',
             f'https://github.com/{REPO}.git', str(REPO_DIR)])
        run(['git', '-C', str(REPO_DIR), 'fetch', 'origin', GIT_FETCH])
        run(['git', '-C', str(REPO_DIR), 'checkout', GIT_REF])
    else:
        run(['git', 'clone', '--depth', '1', '--branch', GIT_REF,
             f'https://github.com/{REPO}.git', str(REPO_DIR)])
    head = subprocess.run(['git', '-C', str(REPO_DIR), 'rev-parse', 'HEAD'],
                          capture_output=True, text=True, check=True)
    log(f'repo cloned at {GIT_REF} = {head.stdout.strip()}')

    os.chdir(REPO_DIR)

    # 3. nvidia-smi check — verify the GPU is actually visible before
    #    spending time installing anything else.
    smi = subprocess.run(['nvidia-smi'], capture_output=True, text=True)
    log(f'nvidia-smi:\n{smi.stdout}')
    if 'NVIDIA' not in smi.stdout:
        log('no GPU visible, aborting')
        sys.exit(2)

    # 3b. Ensure an NVIDIA Vulkan ICD exists. Kaggle GPU images ship CUDA
    #     userspace but typically NOT the graphics/Vulkan userspace, so the
    #     Vulkan loader only finds llvmpipe and Chromium's WebGPU never gets
    #     a hardware adapter. Strategy: (1) look for an existing producer
    #     lib anywhere on disk, (2) otherwise install the matching-branch
    #     libnvidia-gl-<major> from the Ubuntu archive (ships
    #     /usr/share/vulkan/icd.d/nvidia_icd.json + libGLX_nvidia), (3)
    #     fall back to synthesizing an ICD manifest if a lib turns up later.
    def _driver_branch() -> str | None:
        m = re.search(r'Driver Version:\s*(\d+)\.', smi.stdout)
        return m.group(1) if m else None

    def _find_producer_lib() -> str | None:
        hits = subprocess.run(
            ['ldconfig', '-p'], capture_output=True, text=True,
        ).stdout.lower()
        for line in hits.splitlines():
            if 'libvulkan_nvidia' in line or ('nvidia' in line and 'vulkan' in line):
                parts = line.split('=>')
                if len(parts) == 2:
                    path = parts[1].strip()
                    if Path(path).exists():
                        return path
        return None

    icd_json = Path('/usr/share/vulkan/icd.d/nvidia_icd.json')
    if not icd_json.exists():
        branch = _driver_branch()
        lib = _find_producer_lib()
        if lib is None and branch:
            log(f'no NVIDIA Vulkan lib found; installing libnvidia-gl-{branch} '
                '(Ubuntu archive: ships Vulkan producer + ICD manifest)')
            gl_install = subprocess.run(
                ['apt-get', 'install', '-y', '-qq', '--no-install-recommends']
                + APT_SLOW + [f'libnvidia-gl-{branch}'],
                capture_output=True, text=True,
            )
            if gl_install.returncode != 0:
                log(f'libnvidia-gl-{branch} install failed rc={gl_install.returncode}: '
                    f'{gl_install.stderr[-300:]}')
            else:
                # Refresh the loader cache so ldconfig -p sees new libs.
                subprocess.run(['ldconfig'], check=False)
                log(f'libnvidia-gl-{branch} installed')
                if not icd_json.exists():
                    # Package landed libs but no manifest; synthesize one.
                    lib = _find_producer_lib() or '/usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.0'
                    icd_json.parent.mkdir(parents=True, exist_ok=True)
                    icd_json.write_text(json.dumps({
                        'file_format_version': '1.0.0',
                        'ICD': {'library_path': lib, 'api_version': '1.3.0'},
                    }, indent=2))
                    os.environ['VK_ICD_FILENAMES'] = str(icd_json)
                    os.environ['VK_DRIVER_FILES'] = str(icd_json)
        elif lib:
            log(f'found NVIDIA Vulkan lib at {lib}; writing ICD manifest')
            icd_json.parent.mkdir(parents=True, exist_ok=True)
            icd_json.write_text(json.dumps({
                'file_format_version': '1.0.0',
                'ICD': {'library_path': lib, 'api_version': '1.3.0'},
            }, indent=2))
            os.environ['VK_ICD_FILENAMES'] = str(icd_json)
            os.environ['VK_DRIVER_FILES'] = str(icd_json)
        else:
            log(f'cannot determine driver branch for libnvidia-gl install; '
                'leaving loader as-is')

    # 3c. Show what the Vulkan loader sees now (goes into the kernel log;
    #     gpu_smoke_test.py also records it into the report).
    vk = subprocess.run(['vulkaninfo', '--summary'], capture_output=True, text=True)
    log(f'vulkaninfo rc={vk.returncode}\n{vk.stdout[-1200:]}')

    # 4. Playwright + its matching Chromium build. NOTE: --with-deps runs
    #    its own apt transaction, which has been observed to disturb the
    #    Vulkan loader state (run 4: kernel-side vulkaninfo saw the P100
    #    fine at t=55; the probe's own vulkaninfo failed rc=1 45s later,
    #    taking SwiftShader down with it). Pin the ICD env explicitly so
    #    the probe subprocess always starts from the known-good manifest.
    log('installing playwright + chromium')
    run([sys.executable, '-m', 'pip', 'install', '-q', 'playwright'],
        timeout=600)
    run([sys.executable, '-m', 'playwright', 'install', '--with-deps',
         'chromium'], timeout=900)

    nvidia_icd = Path('/usr/share/vulkan/icd.d/nvidia_icd.json')
    if nvidia_icd.exists():
        os.environ['VK_ICD_FILENAMES'] = str(nvidia_icd)
        os.environ['VK_DRIVER_FILES'] = str(nvidia_icd)
        log(f'pinned Vulkan ICD env -> {nvidia_icd}')
    else:
        log('WARNING: no nvidia_icd.json after install; Vulkan env unpinned')
    # Post-install loader sanity check — goes in the log right before the
    # probe starts, so any --with-deps damage is visible in context.
    vk2 = subprocess.run(['vulkaninfo', '--summary'], capture_output=True, text=True)
    log(f'post-install vulkaninfo rc={vk2.returncode} '
        f'stderr={vk2.stderr[-200:]!r}\n{vk2.stdout[-600:]}')

    # 5. Run the probe. gpu_smoke_test.py starts its own Xvfb on :99 and
    #    launches headed Chromium (--enable-unsafe-webgpu +
    #    --use-vulkan=swiftshader-webgpu), then probes navigator.gpu ->
    #    model load -> generate() round-trip on the live demo site and
    #    writes out/gpu-smoke-report.json with real timings.
    log('running gpu_smoke_test.py')
    try:
        run([
            sys.executable, 'docker/gif/gpu_smoke_test.py',
            '--url', 'https://phantomic12.github.io/yapper/',
            '--model', 'kitten-nano',   # smallest model, fastest load
            '--load-timeout', '300000',
        ], timeout=1500)
        probe_ok = True
    except subprocess.CalledProcessError as exc:
        log(f'probe exited {exc.returncode}')
        probe_ok = False

    # 6. Surface the report regardless of verdict, then gate on it.
    src_report = REPO_DIR / 'out' / 'gpu-smoke-report.json'
    if not src_report.exists():
        log(f'no report found at {src_report}, treating as failure')
        sys.exit(1)
    shutil.copy(src_report, REPORT_OUT)
    log(f'report copied to {REPORT_OUT}')

    screenshots = sorted((REPO_DIR / 'out').glob('gpu-smoke-*.png'))
    for shot in screenshots:
        shutil.copy(shot, KAGGLE_WORKING / shot.name)

    report = json.loads(REPORT_OUT.read_text())
    webgpu = report.get('webgpu', {})
    model_load = report.get('modelLoad', {})
    gen = report.get('generate', {})
    log(f'  WebGPU:     available={webgpu.get("available")}'
        f' vendor={webgpu.get("vendor")!r}')
    log(f'  Model load: {model_load.get("loaded")}'
        f' in {model_load.get("secondsTotal", "?")}s')
    log(f'  Generate:   done={gen.get("done")}'
        f' in {gen.get("secondsTotal", "?")}s')
    for job in gen.get('jobs') or []:
        log(f'  job: status={job.get("status")} hasAudio={job.get("hasAudio")}'
            f' duration={job.get("audioDuration")}s')

    failed = (
        not webgpu.get('available')
        or not model_load.get('loaded')
        or gen.get('done') is not True
    )
    if not failed:
        jobs = [j for j in (gen.get('jobs') or [])
                if j.get('hasAudio') and (j.get('audioDuration') or 0) > 0]
        if not jobs:
            failed = True
            log('generate done but no job produced audio with positive '
                'duration')

    if not probe_ok or failed:
        log(f'OVERALL: FAIL (probe_ok={probe_ok})')
        sys.exit(1)
    log(f'OVERALL: PASS ({len(screenshots)} screenshots saved)')


if __name__ == '__main__':
    main()
