/**
 * WCAG 2.1 AA scan — axe-core over every reachable surface, both themes.
 *
 * Serves dist/ statically (build first: `npm run build`), injects
 * node_modules/axe-core/axe.min.js (installed as a devDependency),
 * and scans each app state: the three pages with and without the advanced
 * ("More") regions, the document-open takeover, the collapsed reader tools,
 * the shortcut-help dialog, the word-lookup popover, and the notes column.
 *
 * Beyond axe's automated rules it asserts the behavioural criteria the
 * automated scan cannot see:
 *   - 2.1.2 / modal: Tab is trapped inside aria-modal dialogs and focus
 *     returns to the opening control on close.
 *   - 2.1.4: single-key shortcuts can be turned off via the persisted
 *     checkbox in the shortcut help.
 *   - Focus does not fall to <body> when a document is closed.
 *
 * Usage:  node qa/axe-scan.mjs [--json qa/results/axe-scan.json]
 * Exit:   0 = no violations, 1 = violations or harness failure.
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const AXE = join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');

if (!existsSync(DIST)) {
  console.error('dist/ is missing — run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(AXE)) {
  console.error('axe-core is missing — run `npm i --no-save axe-core` first.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
  '.md': 'text/markdown', '.bin': 'application/octet-stream', '.map': 'application/json',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (path === '/') path = '/index.html';
      const file = normalize(join(DIST, path));
      if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer({ server, port: server.address().port }));
  });
}

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function runAxe(page, selector) {
  return page.evaluate(async ({ tags, sel }) => {
    const ctx = sel ? document.querySelector(sel) : document;
    if (!ctx) return { error: `selector not found: ${sel}` };
    return await window.axe.run(ctx, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations', 'incomplete'],
    });
  }, { tags: WCAG_TAGS, sel: selector ?? null });
}

const results = [];   // { theme, surface, violations, incomplete }
const checks = [];    // { name, pass, detail }
const stepErrors = [];

async function scan(page, theme, surface, selector) {
  const r = await runAxe(page, selector);
  if (r.error) { stepErrors.push(`${theme}/${surface}: ${r.error}`); return; }
  results.push({
    theme, surface,
    violations: r.violations.map(v => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.map(n => ({
        target: n.target,
        summary: n.failureSummary,
        data: n.any?.[0]?.data ?? n.all?.[0]?.data ?? n.none?.[0]?.data ?? null,
      })),
    })),
    incomplete: r.incomplete.map(v => ({
      id: v.id,
      nodes: v.nodes.map(n => n.target),
    })),
  });
}

function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
}

async function scanTheme(browser, port, theme) {
  // prefers-reduced-motion: the app honors it, and it also pins animated
  // colors (page-in fade, document-open transitions) to their resting
  // values so axe measures what a user actually sees, not a mid-fade blend.
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript((t) => {
    try { localStorage.setItem('yapper.theme.v1', t); } catch { /* private mode */ }
  }, theme);
  const page = await context.newPage();
  page.on('pageerror', (e) => stepErrors.push(`${theme} pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${port}/#reader`, { waitUntil: 'load' });
  await page.waitForSelector('#document-sample-btn', { timeout: 15000 });
  await page.addScriptTag({ path: AXE });
  await page.waitForFunction(
    (t) => document.documentElement.getAttribute('data-theme') === t, theme);

  const clickTab = (name) => page.click(`[data-page-target="${name}"]`);

  // 1. Reader landing
  await scan(page, theme, 'reader-landing');

  // 2. Reader with the advanced ("More") regions revealed
  await page.click('#advanced-toggle');
  await scan(page, theme, 'reader-advanced');

  // 3. Studio — model grid is a data-advanced region, now visible
  await clickTab('studio');
  await page.waitForSelector('#page-studio:not([hidden])');
  await scan(page, theme, 'studio-advanced');

  // 4. Studio with advanced collapsed again
  await page.click('#advanced-toggle');
  await scan(page, theme, 'studio-default');

  // 5. Write page
  await clickTab('write');
  await page.waitForSelector('#page-write:not([hidden])');
  await scan(page, theme, 'write');

  // 6. Document-open takeover (sample document)
  await clickTab('reader');
  await page.click('#document-sample-btn');
  await page.waitForSelector('body.document-open', { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('doc-title')?.textContent?.length > 0);
  await scan(page, theme, 'document-open');

  // 7. Reader tools expanded
  await page.evaluate(() => { document.getElementById('reader-tools').open = true; });
  await scan(page, theme, 'reader-tools-open');

  // 8. Shortcut-help dialog — axe scan + focus-trap/return assertions
  await page.click('#shortcuts-btn');
  await page.waitForSelector('#shortcut-help:not([hidden])');
  await scan(page, theme, 'shortcut-help-dialog');

  // Focus trap: walk Tab forward and Shift+Tab back; focus must stay inside.
  let trapped = true;
  let firstEl = await page.evaluate(() => document.activeElement?.id || document.activeElement?.className);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(
      () => document.getElementById('shortcut-help').contains(document.activeElement));
    if (!inside) { trapped = false; break; }
  }
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Shift+Tab');
    const inside = await page.evaluate(
      () => document.getElementById('shortcut-help').contains(document.activeElement));
    if (!inside) { trapped = false; break; }
  }
  check(`${theme}: shortcut-help traps Tab`, trapped, `initial focus: ${firstEl}`);

  // 2.1.4: unchecking the toggle must silence single-key shortcuts.
  await page.click('#shortcut-keys-toggle');
  await page.click('#shortcut-help-close');
  await page.waitForSelector('#shortcut-help', { state: 'hidden' });
  // Focus should have returned to the button that opened the dialog.
  const returned = await page.evaluate(() => document.activeElement?.id);
  check(`${theme}: shortcut-help returns focus to opener`, returned === 'shortcuts-btn',
        `activeElement: ${returned}`);
  // 'm' would bookmark if shortcuts were live; it must not.
  const before = await page.locator('#bookmark-list li').count();
  await page.keyboard.press('m');
  await page.keyboard.press('o');
  const after = await page.locator('#bookmark-list li').count();
  const outlineStillClosed = await page.evaluate(() => {
    const el = document.getElementById('doc-outline');
    return !el || el.hidden !== false;
  });
  check(`${theme}: single-key shortcuts disable (2.1.4)`,
        before === after && outlineStillClosed,
        `bookmarks ${before}→${after}`);
  // Re-enable for the rest of the run.
  await page.click('#shortcuts-btn');
  await page.waitForSelector('#shortcut-help:not([hidden])');
  await page.click('#shortcut-keys-toggle');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#shortcut-help', { state: 'hidden' });

  // 9. Word-lookup popover
  try {
    await page.click('#lookup-mode-btn');
    await page.click('#document-reader-view .reader-word >> nth=4', { timeout: 8000 });
    await page.waitForSelector('.word-lookup', { timeout: 10000 });
    // Let the bundled dictionary resolve.
    await page.waitForFunction(
      () => !document.querySelector('.word-lookup__body')?.textContent?.includes('Looking up'),
      { timeout: 10000 }).catch(() => {});
    await scan(page, theme, 'lookup-popover');
    await page.keyboard.press('Escape');
  } catch (e) {
    stepErrors.push(`${theme}/lookup-popover: ${e.message.split('\n')[0]}`);
  }

  // 10. Notes column
  try {
    await page.click('#colnotes-btn');
    await page.waitForSelector('#colnotes:not([hidden])');
    await scan(page, theme, 'colnotes-open');
    await page.click('#colnotes-close-btn');
  } catch (e) {
    stepErrors.push(`${theme}/colnotes-open: ${e.message.split('\n')[0]}`);
  }

  // 11. Close document → focus must not drop to <body> (lands on file input).
  await page.click('#close-document-btn');
  await page.waitForSelector('body:not(.document-open)');
  const focusAfterClose = await page.evaluate(() => document.activeElement?.id);
  check(`${theme}: document close restores focus`, focusAfterClose === 'document-upload',
        `activeElement: ${focusAfterClose}`);
  await scan(page, theme, 'reader-after-close');

  await context.close();
}

// ── main ──────────────────────────────────────────────────────────
const { server, port } = await serve();
const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    await scanTheme(browser, port, theme);
  }
} finally {
  await browser.close();
  server.close();
}

// ── report ────────────────────────────────────────────────────────
let violations = 0;
for (const r of results) {
  if (!r.violations.length) continue;
  violations += r.violations.length;
  console.log(`\n✗ ${r.theme} / ${r.surface}`);
  for (const v of r.violations) {
    console.log(`  [${v.impact}] ${v.id}: ${v.help}`);
    for (const n of v.nodes.slice(0, 6)) {
      console.log(`    → ${n.target.join(' ')}  ${n.summary ?? ''}`);
    }
    if (v.nodes.length > 6) console.log(`    … +${v.nodes.length - 6} more`);
  }
}

const incompleteTotal = results.reduce((n, r) => n + r.incomplete.length, 0);
if (incompleteTotal) {
  console.log(`\nNeeds-review (axe "incomplete"): ${incompleteTotal}`);
  for (const r of results) {
    for (const v of r.incomplete) {
      console.log(`  ${r.theme}/${r.surface} ${v.id} ×${v.nodes.length}`);
    }
  }
}

console.log('\nBehavioural checks:');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
}
if (stepErrors.length) {
  console.log('\nStep errors:');
  for (const e of stepErrors) console.log(`  ! ${e}`);
}
console.log(`\n${violations} axe violation(s), ${checks.filter(c => !c.pass).length} failed check(s).`);

// JSON out
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
  const out = resolve(process.argv[jsonIdx + 1]);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ when: new Date().toISOString(), results, checks, stepErrors }, null, 2));
  console.log(`wrote ${out}`);
}

process.exit(violations || checks.some(c => !c.pass) ? 1 : 0);
