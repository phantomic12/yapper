#!/usr/bin/env python3
"""Gate the GPU smoke run on the kernel's JSON report.

PASS requires every one of:
  - webgpu.available is true (real adapter, not just navigator.gpu)
  - modelLoad.loaded is true for the expected model
  - generate.done is true
  - at least one job produced audio with a positive duration

Anything else — including a missing field or a skipped generate — fails
with a concrete reason. This is what makes "runner booted" unable to
pass for "inference worked".
"""

import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify_gpu_report.py <gpu-smoke-report.json>",
              file=sys.stderr)
        return 2

    try:
        report = json.loads(open(sys.argv[1]).read())
    except (OSError, ValueError) as exc:
        print(f"::error::cannot read gpu-smoke-report.json: {exc}")
        return 1

    webgpu = report.get("webgpu") or {}
    load = report.get("modelLoad") or {}
    gen = report.get("generate") or {}
    model = report.get("modelId", "?")

    problems = []

    if not webgpu.get("available"):
        problems.append(
            f"WebGPU adapter not available"
            f" ({webgpu.get('reason') or 'no reason recorded'})")
    if not load.get("loaded"):
        problems.append(
            f"model '{model}' did not load"
            f" (state: {json.dumps(load.get('finalState'))})")
    if gen.get("done") is not True:
        problems.append(
            f"generation did not complete: {gen.get('done')!r}"
            f"{' (' + gen['skipped'] + ')' if gen.get('skipped') else ''}")
    else:
        jobs = [j for j in (gen.get("jobs") or [])
                if j.get("hasAudio") and (j.get("audioDuration") or 0) > 0]
        if not jobs:
            problems.append(
                f"generation reported done but no job has audio with a "
                f"positive duration; jobs={json.dumps(gen.get('jobs'))}")

    print(f"WebGPU:     available={webgpu.get('available')}"
          f" vendor={webgpu.get('vendor')!r}"
          f" features={webgpu.get('featureCount')}")
    print(f"Model:      {model} loaded={load.get('loaded')}"
          f" in {load.get('secondsTotal', '?')}s")
    print(f"Generate:   done={gen.get('done')} in {gen.get('secondsTotal', '?')}s")
    for job in gen.get("jobs") or []:
        print(f"  job: status={job.get('status')} hasAudio={job.get('hasAudio')}"
              f" duration={job.get('audioDuration')}s")

    if problems:
        print("::error::GPU smoke test FAILED:")
        for problem in problems:
            print(f"::error::  - {problem}")
        return 1

    print("GPU smoke test PASSED: WebGPU adapter up, real model load, "
          "generation produced audio.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
