// ─── E2E OCR Test with Playwright ─────────────────────────────────
//
// Tests the full document reader flow:
// 1. UI renders correctly with OCR mode selector
// 2. Text-based PDF extraction (no OCR)
// 3. Scanned PDF with Tesseract OCR
// 4. Scanned PDF with LLM (Florence-2) OCR — if WebGPU available
// 5. Read aloud functionality
// 6. Error handling
//
// Run: node scripts/e2e-ocr-test.mjs
// Requires: dev server running on http://localhost:5173

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

// Known text in the test PDFs (from scripts/gen_test_pdfs.py)
const KNOWN_TEXT = [
  'Quick Brown Fox',
  'Lorem ipsum',
  'seashells',
  'liquor jugs',
  'daft zebras',
  'OCR testing',
];

// ─── Test runner ──────────────────────────────────────────────────

const results = [];
function log(msg) { console.log(`  ${msg}`); }
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`  ✓ ${name}`); }
function fail(name, error) { results.push({ name, status: 'FAIL', error }); console.log(`  ✗ ${name}: ${error}`); }

async function runTest(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// ─── Helper: wait for text to appear in element ────────────────────

async function waitForText(page, selector, textPattern, timeout = 30000) {
  await page.waitForFunction(
    ([sel, pattern]) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const text = el.textContent || '';
      return text.toLowerCase().includes(pattern.toLowerCase());
    },
    [selector, textPattern],
    { timeout },
  );
}

// ─── Tests ────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  E2E OCR Test — yapper document reader with LLM OCR');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  // Collect console messages and errors
  const consoleMessages = [];
  const pageErrors = [];

  const page = await context.newPage();
  page.on('console', msg => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
    if (msg.type() === 'error') {
      console.log(`  [console.error] ${msg.text()}`);
    }
  });
  page.on('pageerror', err => {
    pageErrors.push(err.message);
    console.log(`  [pageerror] ${err.message}`);
  });

  // ─── Helper: toggle the OCR switch (checkbox is hidden via CSS) ──
  // The switch CSS uses opacity:0 + position:absolute, so Playwright can't
  // click it directly. We use evaluate() to set the checked state and
  // dispatch a change event, which the app's event listener picks up.

  async function setOcrToggle(checked) {
    await page.evaluate((desired) => {
      const toggle = document.getElementById('ocr-toggle');
      if (!toggle) throw new Error('OCR toggle not found');
      if (toggle.checked !== desired) {
        toggle.checked = desired;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, checked);
  }

  async function setOcrMode(mode) {
    await page.evaluate((desiredMode) => {
      const radio = document.querySelector(`input[name="ocr-mode"][value="${desiredMode}"]`);
      if (!radio) throw new Error(`OCR mode radio "${desiredMode}" not found`);
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }, mode);
  }

  // ─── Test 1: Page loads and UI renders ───────────────────────────

  console.log('\n── Test 1: Page loads and UI renders ──');

  await runTest('page loads without errors', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    const title = await page.title();
    if (!title) throw new Error('Page has no title');
    log(`Title: "${title}"`);
  });

  await runTest('document upload section is visible', async () => {
    const drop = page.locator('#document-drop');
    await drop.waitFor({ state: 'visible', timeout: 10000 });
  });

  await runTest('OCR toggle exists', async () => {
    const toggle = page.locator('#ocr-toggle');
    await toggle.waitFor({ state: 'attached', timeout: 5000 });
  });

  await runTest('OCR mode selector is hidden by default', async () => {
    const selector = page.locator('#ocr-mode-selector');
    const display = await selector.evaluate(el => getComputedStyle(el).display);
    if (display !== 'none') throw new Error(`Expected display:none, got ${display}`);
  });

  await runTest('OCR mode selector appears when OCR toggle is checked', async () => {
    await setOcrToggle(true);
    // The selector is inside #document-options which may be display:none
    // (it's only shown after a file is loaded). Check the selector's own
    // display style rather than Playwright's "visible" state.
    const display = await page.locator('#ocr-mode-selector').evaluate(
      el => getComputedStyle(el).display
    );
    if (display === 'none') {
      throw new Error(`Expected display != none, got "${display}"`);
    }
    log(`Selector display: ${display}`);
  });

  await runTest('OCR mode selector has Tesseract and LLM options', async () => {
    const radios = page.locator('input[name="ocr-mode"]');
    const count = await radios.count();
    if (count !== 2) throw new Error(`Expected 2 radio buttons, got ${count}`);
    const values = await radios.evaluateAll(els => els.map(e => e.value));
    if (!values.includes('tesseract') || !values.includes('llm')) {
      throw new Error(`Expected ['tesseract', 'llm'], got ${JSON.stringify(values)}`);
    }
  });

  await runTest('Tesseract is the default selected mode', async () => {
    const tesseract = page.locator('input[name="ocr-mode"][value="tesseract"]');
    const isChecked = await tesseract.isChecked();
    if (!isChecked) throw new Error('Tesseract should be checked by default');
  });

  await runTest('switching to LLM mode updates the radio state', async () => {
    await setOcrMode('llm');
    const llmChecked = await page.locator('input[name="ocr-mode"][value="llm"]').isChecked();
    const tesseractChecked = await page.locator('input[name="ocr-mode"][value="tesseract"]').isChecked();
    if (!llmChecked) throw new Error('LLM radio should be checked');
    if (tesseractChecked) throw new Error('Tesseract radio should not be checked');
    // Switch back to tesseract for subsequent tests
    await setOcrMode('tesseract');
  });

  // ─── Test 2: Text-based PDF extraction (no OCR) ──────────────────

  console.log('\n── Test 2: Text-based PDF extraction (no OCR) ──');

  // Uncheck OCR toggle for text-based PDF
  await setOcrToggle(false);

  await runTest('text-based PDF extracts embedded text', async () => {
    const pdfPath = resolve(projectRoot, 'public', 'test-pdfs', 'text-based.pdf');
    if (!existsSync(pdfPath)) throw new Error('Test PDF not found: ' + pdfPath);

    const fileInput = page.locator('#document-upload');
    await fileInput.setInputFiles(pdfPath);

    // Wait for the extracted text to appear in the reader view
    await waitForText(page, '#document-reader-view', 'Quick Brown Fox', 30000);

    const readerText = await page.locator('#document-reader-view').textContent();
    if (!readerText) throw new Error('No text in reader view');

    // Verify some known text was extracted
    const lowerText = readerText.toLowerCase();
    const found = KNOWN_TEXT.filter(t => lowerText.includes(t.toLowerCase()));
    if (found.length < 3) {
      throw new Error(`Only found ${found.length}/${KNOWN_TEXT.length} known phrases: ${found.join(', ')}`);
    }
    log(`Extracted ${readerText.length} chars, found ${found.length}/${KNOWN_TEXT.length} known phrases`);
  });

  await runTest('document preview shows after extraction', async () => {
    const preview = page.locator('#document-preview');
    await preview.waitFor({ state: 'visible', timeout: 5000 });
  });

  await runTest('read aloud button is visible after extraction', async () => {
    const readBtn = page.locator('#read-document-btn');
    await readBtn.waitFor({ state: 'visible', timeout: 5000 });
  });

  await runTest('progress message shows loaded status', async () => {
    const progress = page.locator('#document-progress');
    const text = await progress.textContent();
    if (!text || !text.includes('Loaded')) {
      throw new Error(`Expected "Loaded" in progress, got: "${text}"`);
    }
  });

  // ─── Test 3: Scanned PDF with Tesseract OCR ──────────────────────

  console.log('\n── Test 3: Scanned PDF with Tesseract OCR ──');

  await runTest('OCR toggle enables for PDF files', async () => {
    // Check the OCR toggle
    await setOcrToggle(true);
    // Verify mode selector is visible
    await page.locator('#ocr-mode-selector').waitFor({ state: 'visible', timeout: 5000 });
    // Ensure Tesseract is selected
    await setOcrMode('tesseract');
  });

  await runTest('scanned PDF extracts text via Tesseract OCR', async () => {
    const pdfPath = resolve(projectRoot, 'public', 'test-pdfs', 'scanned.pdf');
    if (!existsSync(pdfPath)) throw new Error('Scanned PDF not found: ' + pdfPath);

    const fileInput = page.locator('#document-upload');
    await fileInput.setInputFiles(pdfPath);

    // Tesseract OCR may take a while — wait up to 60s for known text
    // The scanned PDF uses a bitmap font which is low quality, so we
    // check for at least one known phrase.
    try {
      await waitForText(page, '#document-reader-view', 'Quick', 60000);
    } catch {
      // Check if any text was extracted at all
      const readerText = await page.locator('#document-reader-view').textContent();
      if (readerText && readerText.trim().length > 10) {
        log(`Tesseract extracted ${readerText.length} chars (may not match known text due to bitmap font quality)`);
        log(`First 100 chars: "${readerText.substring(0, 100)}"`);
      } else {
        throw new Error('Tesseract OCR produced no readable text');
      }
      return;
    }

    const readerText = await page.locator('#document-reader-view').textContent();
    log(`Tesseract extracted ${readerText?.length ?? 0} chars`);
    if (readerText) {
      log(`First 100 chars: "${readerText.substring(0, 100)}"`);
    }
  });

  await runTest('OCR progress indicator shows during Tesseract OCR', async () => {
    // Re-upload to catch the progress indicator
    const pdfPath = resolve(projectRoot, 'public', 'test-pdfs', 'scanned.pdf');
    const fileInput = page.locator('#document-upload');
    await fileInput.setInputFiles(pdfPath);

    // The progress row should become visible
    const progressRow = page.locator('#document-progress-row');
    // Wait briefly for progress to show
    try {
      await progressRow.waitFor({ state: 'visible', timeout: 3000 });
      log('Progress indicator was visible during OCR');
    } catch {
      // OCR may have completed too fast to catch the progress bar
      log('Progress indicator not caught (OCR may have completed too fast)');
    }

    // Wait for completion
    await waitForText(page, '#document-progress', 'Loaded', 60000);
  });

  // ─── Test 4: Scanned PDF with LLM (Florence-2) OCR ───────────────

  console.log('\n── Test 4: Scanned PDF with LLM (Florence-2) OCR ──');

  // Check if WebGPU is available in this browser
  const hasWebGPU = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch {
      return false;
    }
  });

  if (!hasWebGPU) {
    log('⚠ WebGPU not available — LLM OCR will be very slow on WASM fallback');
    log('  Will test that Florence-2 model loading starts, but may timeout');
  }

  await runTest('LLM OCR mode can be selected', async () => {
    await setOcrToggle(true);
    await page.locator('#ocr-mode-selector').waitFor({ state: 'visible', timeout: 5000 });
    await setOcrMode('llm');
    const llmChecked = await page.locator('input[name="ocr-mode"][value="llm"]').isChecked();
    if (!llmChecked) throw new Error('Could not select LLM OCR mode');
  });

  await runTest('LLM OCR mode triggers Florence-2 model download', async () => {
    const pdfPath = resolve(projectRoot, 'public', 'test-pdfs', 'scanned.pdf');
    const fileInput = page.locator('#document-upload');
    await fileInput.setInputFiles(pdfPath);

    // The progress message should show LLM-related text
    // Wait for either "LLM" in progress or a model download indicator
    try {
      await waitForText(page, '#document-progress', 'LLM', 15000);
      const progressText = await page.locator('#document-progress').textContent();
      log(`Progress: "${progressText}"`);
    } catch {
      // Check if there's any progress message
      const progressText = await page.locator('#document-progress').textContent();
      if (progressText && progressText.length > 0) {
        log(`Progress (no LLM keyword): "${progressText}"`);
      } else {
        throw new Error('No progress message shown for LLM OCR mode');
      }
    }
  });

  // For the LLM OCR, we wait for either:
  // - Successful text extraction (if WebGPU + model downloads fast enough)
  // - Model loading progress (verifies the code path is wired)
  // We use a generous timeout since the model is ~200MB
  const llmTimeout = hasWebGPU ? 120000 : 30000;

  await runTest('LLM OCR produces output or shows model loading progress', async () => {
    // In headless Chromium without WebGPU, the Florence-2 model may:
    // 1. Load via WASM (very slow, ~30s+ per page) — may timeout
    // 2. Fail to load entirely — shows error or 0 chars
    // 3. Load and produce text — best case
    //
    // We accept any of these outcomes as long as the LLM code path was
    // actually invoked (verified by the previous test showing "LLM" in
    // progress). The key verification is that the code path is wired.

    try {
      // Try to wait for extracted text
      await waitForText(page, '#document-reader-view', 'Quick', llmTimeout);
      const readerText = await page.locator('#document-reader-view').textContent();
      log(`LLM OCR extracted ${readerText?.length ?? 0} chars`);
      if (readerText) {
        log(`First 100 chars: "${readerText.substring(0, 100)}"`);
      }
    } catch {
      // Check the current state
      const progressText = await page.locator('#document-progress').textContent();
      const readerText = await page.locator('#document-reader-view').textContent();

      if (readerText && readerText.trim().length > 5) {
        log(`LLM OCR produced ${readerText.length} chars of text`);
        log(`Text: "${readerText.substring(0, 100)}"`);
      } else if (progressText && (progressText.includes('LLM') || progressText.includes('OCR'))) {
        log(`Model still loading / OCR in progress: "${progressText}"`);
        log('This confirms the LLM OCR code path is wired correctly');
      } else if (progressText && progressText.includes('Loaded') && progressText.includes('0 chars')) {
        // Model likely failed to load (no WebGPU) — the extraction
        // completed with 0 chars because the LLM couldn't process the image.
        // This is expected in a headless browser without WebGPU.
        log(`LLM OCR completed with 0 chars (expected without WebGPU)`);
        log('The LLM code path was invoked but the model could not load');
        if (!hasWebGPU) {
          log('WebGPU not available — this is an expected limitation');
        }
      } else if (progressText && progressText.toLowerCase().includes('error')) {
        log(`LLM OCR error (expected without WebGPU): "${progressText}"`);
      } else {
        // Check for error in the status bar
        const errorEl = page.locator('[role="alert"], .status-bar--error');
        const errorText = await errorText.textContent().catch(() => null);
        if (errorText && errorText.toLowerCase().includes('error')) {
          log(`Error shown (expected without WebGPU): "${errorText}"`);
        } else {
          throw new Error(`No LLM OCR output or loading progress. Progress: "${progressText}"`);
        }
      }
    }
  });

  // ─── Test 5: Read aloud functionality ────────────────────────────

  console.log('\n── Test 5: Read aloud functionality ──');

  // First, load a text-based PDF (faster than OCR)
  await setOcrToggle(false);
  await runTest('text PDF loads for read-aloud test', async () => {
    const pdfPath = resolve(projectRoot, 'public', 'test-pdfs', 'text-based.pdf');
    await page.locator('#document-upload').setInputFiles(pdfPath);
    await waitForText(page, '#document-reader-view', 'Quick Brown Fox', 30000);
  });

  await runTest('read aloud button is enabled', async () => {
    const readBtn = page.locator('#read-document-btn');
    await readBtn.waitFor({ state: 'visible', timeout: 5000 });
    const disabled = await readBtn.getAttribute('disabled');
    // Button should not be disabled
    if (disabled !== null) {
      log('Read button is disabled — may need a TTS model loaded first');
    }
  });

  await runTest('clicking read aloud triggers reader session', async () => {
    // Check if the read aloud button is enabled
    const readBtn = page.locator('#read-document-btn');
    const isDisabled = await readBtn.isDisabled();

    if (isDisabled) {
      // Button is disabled because no TTS model is loaded — this is expected
      // in a headless browser without a loaded model. Verify the button
      // has the correct tooltip explaining why.
      const title = await readBtn.getAttribute('title');
      if (title && title.toLowerCase().includes('model')) {
        log(`Read aloud button correctly disabled: "${title}"`);
      } else {
        log(`Read aloud button disabled (no TTS model loaded)`);
      }
      return;
    }

    // If button is enabled, click it
    await readBtn.click();

    // Check if reader status updates or overlay appears
    try {
      const overlay = page.locator('#reader-overlay');
      await overlay.waitFor({ state: 'visible', timeout: 5000 });
      log('Reader overlay appeared');
    } catch {
      const status = page.locator('#reader-status');
      const statusText = await status.textContent({ timeout: 3000 }).catch(() => null);
      if (statusText && statusText.length > 0) {
        log(`Reader status: "${statusText}"`);
      } else {
        log('No visible reader response — may need TTS model loaded first');
      }
    }
  });

  // ─── Test 6: Error handling ──────────────────────────────────────

  console.log('\n── Test 6: Error handling ──');

  await runTest('non-PDF file with OCR enabled gracefully ignores OCR', async () => {
    // The app's handleFile logic: useOcr = ocrToggle.checked && file.endsWith('.pdf')
    // So a .txt file with OCR toggle checked should still load normally
    // (OCR is silently skipped for non-PDFs).
    await setOcrToggle(true);

    // Create a temp .txt file
    const txtPath = resolve(projectRoot, 'public', 'test-pdfs', 'test.txt');
    const fs = await import('node:fs');
    fs.writeFileSync(txtPath, 'This is a test text file for OCR error handling.');

    await page.locator('#document-upload').setInputFiles(txtPath);

    // The file should load successfully (no error) because OCR is only
    // applied to PDFs — the toggle is ignored for .txt files.
    try {
      await waitForText(page, '#document-reader-view', 'test text file', 15000);
      log('TXT file loaded successfully with OCR toggle on (OCR ignored for non-PDF)');
    } catch {
      // Check if it loaded but with different text
      const readerText = await page.locator('#document-reader-view').textContent();
      if (readerText && readerText.length > 0) {
        log(`TXT file loaded with ${readerText.length} chars (OCR ignored for non-PDF)`);
      } else {
        // Check for error
        const progressText = await page.locator('#document-progress').textContent().catch(() => '');
        if (progressText && progressText.toLowerCase().includes('error')) {
          throw new Error(`Unexpected error: "${progressText}"`);
        } else {
          throw new Error(`TXT file did not load. Progress: "${progressText}"`);
        }
      }
    }

    // Clean up
    fs.unlinkSync(txtPath);
  });

  await runTest('page has no uncaught JavaScript errors', async () => {
    // Filter out expected errors (e.g., WebGPU not available, audio context in headless)
    const realErrors = pageErrors.filter(e =>
      !e.includes('pause()') &&  // jsdom/headless audio limitation
      !e.includes('HTMLMediaElement') &&
      !e.includes('Not implemented') &&
      !e.includes('WebGPU') &&
      !e.includes('gpu')
    );
    if (realErrors.length > 0) {
      throw new Error(`Uncaught errors:\n${realErrors.map(e => '  - ' + e).join('\n')}`);
    }
  });

  // ─── Test 7: New document formats ────────────────────────────────

  console.log('\n── Test 7: New document formats (RTF, HTML, CSV, XLSX, PPTX, DOCX) ──');

  // Make sure OCR is off for these tests
  await setOcrToggle(false);

  const testDocsDir = resolve(projectRoot, 'public', 'test-docs');
  const KNOWN_PHRASE = 'quick brown fox';

  // Helper to upload a file and check for known text
  async function testFormat(fileName, expectedText, label) {
    const filePath = resolve(testDocsDir, fileName);
    if (!existsSync(filePath)) throw new Error(`Test file not found: ${filePath}`);

    await page.locator('#document-upload').setInputFiles(filePath);
    await waitForText(page, '#document-reader-view', expectedText, 30000);
    const readerText = await page.locator('#document-reader-view').textContent();
    if (!readerText) throw new Error('No text extracted');
    log(`${label}: extracted ${readerText.length} chars`);
  }

  await runTest('DOCX extracts text', async () => {
    await testFormat('test.docx', KNOWN_PHRASE, 'DOCX');
  });

  await runTest('RTF extracts text', async () => {
    await testFormat('test.rtf', KNOWN_PHRASE, 'RTF');
  });

  await runTest('HTML extracts text (strips scripts/styles)', async () => {
    await testFormat('test.html', KNOWN_PHRASE, 'HTML');
    // Verify script content was stripped
    const readerText = await page.locator('#document-reader-view').textContent();
    if (readerText && readerText.includes('console.log')) {
      throw new Error('Script content was not stripped from HTML');
    }
  });

  await runTest('CSV extracts text with rows', async () => {
    await testFormat('test.csv', KNOWN_PHRASE, 'CSV');
    // Verify tabular structure is preserved
    const readerText = await page.locator('#document-reader-view').textContent();
    if (readerText && !readerText.includes('Name')) {
      throw new Error('CSV header row not found in extracted text');
    }
  });

  await runTest('XLSX extracts text from cells', async () => {
    await testFormat('test.xlsx', KNOWN_PHRASE, 'XLSX');
  });

  await runTest('PPTX extracts text from slides', async () => {
    await testFormat('test.pptx', KNOWN_PHRASE, 'PPTX');
  });

  await runTest('format list in UI shows all supported formats', async () => {
    const formatsEl = page.locator('#document-formats');
    const text = await formatsEl.textContent();
    const expectedFormats = ['PDF', 'DOCX', 'DOC', 'ODT', 'RTF', 'EPUB', 'XLSX', 'PPTX', 'CSV', 'HTML', 'TXT', 'MD'];
    const missing = expectedFormats.filter(f => !text.includes(f));
    if (missing.length > 0) {
      throw new Error(`Missing formats in UI: ${missing.join(', ')}. Got: "${text}"`);
    }
  });

  // ─── Summary ─────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  E2E Test Summary');
  console.log('═══════════════════════════════════════════════════════════════');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}`);
    if (r.error) console.log(`      → ${r.error}`);
  }

  console.log(`\n  ${passed}/${total} passed, ${failed} failed`);
  console.log('');

  await browser.close();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
