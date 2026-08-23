#!/usr/bin/env python3
"""Cross-browser QA matrix harness for https://phantomic12.github.io/yapper/.

Runs the full feature checklist against one browser target per invocation:
  select kitten-nano -> Download & Load -> queue generation -> audio element
  appears -> download WAV -> document reader with TXT -> document reader with PDF

Usage:
  run_qa.py <key> <chromium|firefox|webkit|msedge> [--mobile] [--headed]

Writes qa/results/<key>.json and artifacts under qa/artifacts/.
"""
import base64
import json
import os
import sys
import time
import traceback

# Firefox/WebKit run against a local sysroot (LD_LIBRARY_PATH passed to the
# browser process below), but Playwright's host validation runs a bare ldd
# and would refuse to launch. We validate for real by just running the app.
os.environ.setdefault("PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS", "1")

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
ARTIFACTS = os.path.join(HERE, "artifacts")
os.makedirs(RESULTS, exist_ok=True)
os.makedirs(ARTIFACTS, exist_ok=True)

URL = "http://127.0.0.1:8098/index.html"  # patched build (issue #38 fix)
LIVE_URL = "https://phantomic12.github.io/yapper/"
TEXT = "The future of text-to-speech is private, fast, and runs entirely in your browser."
GEN_TIMEOUT = 300_000  # ms — model download + first inference can be slow


class Recorder:
    def __init__(self):
        self.console_errors = []
        self.console_all = []
        self.page_errors = []

    def wire(self, page):
        page.on("console", lambda m: self._console(m))
        page.on("pageerror", lambda e: self.page_errors.append(str(e)))

    def _console(self, msg):
        entry = {"type": msg.type, "text": msg.text[:500]}
        self.console_all.append(entry)
        if msg.type == "error":
            self.console_errors.append(entry)


def make_tiny_pdf(path):
    """Hand-built one-page PDF so we don't need a generator library."""
    objects = []
    objects.append(b"<</Type/Catalog/Pages 2 0 R>>")
    objects.append(b"<</Type/Pages/Kids[3 0 R]/Count 1>>")
    objects.append(
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R"
        b"/Resources<</Font<</F1 5 0 R>>>>>>"
    )
    stream = b"BT /F1 18 Tf 72 720 Td (Yapper QA test page) Tj ET"
    objects.append(b"<</Length %d>>stream\n%s\nendstream" % (len(stream), stream))
    objects.append(b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (i, body)
    xref_pos = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += (
        b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, xref_pos)
    )
    with open(path, "wb") as f:
        f.write(bytes(out))
    return path


def make_txt(path):
    with open(path, "w") as f:
        f.write(
            "Yapper document reader QA fixture.\n\n"
            "This plain-text file exercises the TXT extraction path of the "
            "in-browser document reader. It contains three short paragraphs "
            "so the reader has real content to display.\n\n"
            "If you can read this sentence in the reader preview, text "
            "extraction worked.\n"
        )
    return path


def step(name):
    print(f"  [{name}]", flush=True)


def run_pass(pw, key, engine, mobile=False):
    result = {
        "key": key,
        "engine": engine,
        "mobile": mobile,
        "url": URL,
        "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "steps": {},
        "backend": None,
        "console_errors": [],
        "console_all_count": 0,
        "page_errors": [],
        "status": "fail",
    }
    rec = Recorder()
    page = None

    browser = None
    try:
        if engine == "chromium":
            browser = pw.chromium.launch()
        elif engine == "firefox":
            # Firefox needs GTK/NSS from the local sysroot (no system install
            # rights on this host); the sandbox must be off (no user NS).
            here = os.path.dirname(os.path.abspath(__file__))
            sysroot = os.path.join(
                here, ".sysroot", "usr", "lib", "x86_64-linux-gnu")
            ld = f"{sysroot}:" + os.path.join(here, ".sysroot", "lib",
                                              "x86_64-linux-gnu")
            browser = pw.firefox.launch(
                env={
                    "MOZ_DISABLE_CONTENT_SANDBOX": "1",
                    "LD_LIBRARY_PATH": ld,
                }
            )
        elif engine == "webkit":
            # Launch Playwright's bundled MiniBrowser (bin/) with:
            #   - bundle lib + sys/lib FIRST on LD_LIBRARY_PATH (its own
            #     webkit/soup builds; gstreamer etc. from the sysroot)
            #   - GIO_MODULE_DIR pointing at a dir with ONLY libgiognutls.so:
            #     the full sysroot gio/modules dir breaks plain-http loading
            #     in the network process, but without any gio TLS module
            #     huggingface.co is unreachable (no https). The single-module
            #     dir gives working TLS + working http.
            #   - DISPLAY from Xvfb :99 (started by the driver)
            here = os.path.dirname(os.path.abspath(__file__))
            bundle = os.path.join(
                here, ".pw-browsers", "webkit-2336", "minibrowser-gtk")
            browser = pw.webkit.launch(
                executable_path=os.path.join(bundle, "bin", "MiniBrowser"),
                env={
                    "DISPLAY": os.environ.get("DISPLAY", ":99"),
                    "LD_LIBRARY_PATH":
                        f"{bundle}/lib:{bundle}/sys/lib:"
                        f"{here}/.sysroot/usr/lib/x86_64-linux-gnu:"
                        f"{here}/.sysroot/lib/x86_64-linux-gnu",
                    "WEBKIT_EXEC_PATH": f"{bundle}/bin",
                    "WEBKIT_INJECTED_BUNDLE_PATH": f"{bundle}/lib",
                    "GIO_MODULE_DIR": os.path.join(here, ".gio-gnutls-only"),
                },
            )
        elif engine == "msedge":
            # Real Microsoft Edge, extracted locally from the official MS deb
            # (no root on this host). Edge is Chromium-based; run headless.
            here = os.path.dirname(os.path.abspath(__file__))
            edge_bin = os.path.join(
                here, ".edge", "opt", "microsoft", "msedge", "msedge")
            browser = pw.chromium.launch(
                executable_path=edge_bin,
                args=["--headless=new", "--no-sandbox"],
            )
        else:
            raise ValueError(engine)

        kwargs = {"locale": "en-US", "accept_downloads": True}
        if mobile:
            kwargs.update(
                viewport={"width": 390, "height": 844},
                device_scale_factor=3,
                is_mobile=True,
                has_touch=True,
                user_agent=(
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                    "Mobile/15E148 Safari/604.1"
                ),
            )
        else:
            kwargs["viewport"] = {"width": 1280, "height": 800}
        ctx = browser.new_context(**kwargs)
        ctx.set_default_timeout(GEN_TIMEOUT)
        page = ctx.new_page()
        rec.wire(page)

        t0 = time.time()
        step("goto")
        page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_selector(".model-card", timeout=60_000)
        result["steps"]["app_loads"] = {
            "pass": True,
            "note": f"model grid rendered in {time.time()-t0:.1f}s",
        }

        gpu = page.evaluate("() => 'gpu' in navigator")
        result["webgpu_available"] = gpu

        # 1. Select kitten-nano
        step("select kitten-nano")
        card = page.locator(".model-card[data-model-id='kitten-nano']")
        card.locator('[data-action="pick"]').click()
        selected = card.get_attribute("class") or ""
        result["steps"]["select_model"] = {
            "pass": "model-card--selected" in selected,
            "note": "card marked selected",
        }

        # 2. Download & Load
        step("Download & Load model")
        t1 = time.time()
        page.locator("#load-btn").click()
        gen_btn = page.locator("#generate-btn")
        deadline = time.time() + GEN_TIMEOUT / 1000
        last_status = ""
        while time.time() < deadline:
            disabled = gen_btn.evaluate("el => el.disabled")
            if not disabled:
                break
            try:
                st = card.locator('[data-role="model-status"]').inner_text(timeout=2000)
                if st != last_status:
                    print(f"    status: {st}", flush=True)
                    last_status = st
            except Exception:
                pass
            time.sleep(2)
        else:
            raise TimeoutError("generate button never enabled")

        load_secs = time.time() - t1
        label = page.locator("#load-btn-label").inner_text()
        status_txt = card.locator('[data-role="model-status"]').inner_text()
        result["steps"]["download_and_load"] = {
            "pass": True,
            "note": f"{load_secs:.1f}s, btn='{label}', status='{status_txt}'",
        }
        low = (label + " " + status_txt).lower()
        result["backend"] = (
            "webgpu" if "gpu" in low or "webgpu" in low else
            ("wasm" if "wasm" in low or "cpu" in low else "unspecified")
        )

        # 3. Queue a generation
        step("queue generation")
        t2 = time.time()
        page.fill("#text-input", TEXT)
        gen_btn.click()
        audio = page.locator(".job-card--done audio[data-job-id]").first
        audio.wait_for(state="visible", timeout=GEN_TIMEOUT)
        src = audio.evaluate("el => el.src") or ""
        dur = audio.evaluate(
            "el => el.duration && isFinite(el.duration) ? el.duration : null"
        )
        gen_secs = time.time() - t2
        result["steps"]["generation"] = {
            "pass": src.startswith("blob:") and (dur or 0) > 0.5,
            "note": f"done card in {gen_secs:.1f}s, blob src, duration={dur}",
        }

        # 4. Download WAV
        step("download WAV")
        card_done = page.locator(".job-card--done").first
        with page.expect_download(timeout=30_000) as dl_info:
            card_done.locator('[data-action="download"]').click()
        wav_path = os.path.join(ARTIFACTS, f"{key}.wav")
        dl_info.value.save_as(wav_path)
        size = os.path.getsize(wav_path)
        with open(wav_path, "rb") as f:
            magic = f.read(4)
        ok_wav = magic == b"RIFF" and size > 20_000
        result["steps"]["download_wav"] = {
            "pass": ok_wav,
            "note": f"{size} bytes, header={magic!r}",
            "artifact": wav_path,
        }

        # 5. Document reader: TXT
        step("doc reader TXT")
        fixtures = os.path.join(HERE, "fixtures")
        txt_path = make_txt(os.path.join(fixtures, "sample.txt"))
        pdf_path = make_tiny_pdf(os.path.join(fixtures, "sample.pdf"))
        page.locator("#document-upload").set_input_files(txt_path)
        page.wait_for_function(
            "() => { const p = document.getElementById('document-preview');"
            " return p && p.textContent && p.textContent.includes('QA fixture'); }",
            timeout=60_000,
        )
        prev_len = page.evaluate(
            "() => document.getElementById('document-preview').textContent.length"
        )
        result["steps"]["reader_txt"] = {
            "pass": prev_len > 50,
            "note": f"extracted {prev_len} chars into preview",
        }

        # 6. Document reader: PDF
        step("doc reader PDF")
        page.locator("#document-upload").set_input_files(pdf_path)
        page.wait_for_function(
            "() => { const p = document.getElementById('document-preview');"
            " return p && p.textContent && p.textContent.includes('Yapper QA test page'); }",
            timeout=120_000,
        )
        result["steps"]["reader_pdf"] = {
            "pass": True,
            "note": "pdf.js extracted fixture sentence",
        }

        result["console_errors"] = rec.console_errors
        result["console_all_count"] = len(rec.console_all)
        result["page_errors"] = rec.page_errors
        hard_errors = [
            e for e in rec.console_errors
            if "favicon" not in e["text"].lower()
        ]
        result["clean_console"] = len(hard_errors) == 0 and not rec.page_errors
        if hard_errors or rec.page_errors:
            result["hard_console_errors"] = hard_errors + rec.page_errors
        result["status"] = "pass"

    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
        result["traceback"] = traceback.format_exc(limit=6)
        done_steps = list(result["steps"].keys())
        result["failed_after"] = done_steps[-1] if done_steps else None
        shot = os.path.join(ARTIFACTS, f"{key}-failure.png")
        if page is not None:
            try:
                page.screenshot(path=shot, full_page=True)  # noqa: F821
                result["failure_screenshot"] = shot
            except Exception:
                pass
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
    result["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    out = os.path.join(RESULTS, f"{key}.json")
    with open(out, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps({k: result.get(k) for k in ("key", "status", "backend",
          "clean_console")}, indent=2))
    return result


def main():
    key = sys.argv[1]
    engine = sys.argv[2]
    mobile = "--mobile" in sys.argv
    with sync_playwright() as pw:
        res = run_pass(pw, key, engine, mobile=mobile)
    sys.exit(0 if res["status"] == "pass" else 1)


if __name__ == "__main__":
    main()
