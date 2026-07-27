#!/usr/bin/env node
/**
 * Build all PWA icon PNGs from public/icon-source.svg and
 * public/icon-maskable.svg.
 *
 * Uses the project-local playwright (installed as a devDependency for
 * the demo capture scripts) to render an HTML page hosting the SVG at
 * the exact target pixel size, then crop the screenshot. No external
 * image library needed.
 *
 * Run with `npm run icons:build`. Output goes to public/icons/ and is
 * copied to dist/icons/ by Vite's publicDir at build time.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'public', 'icons');
const SRC_ANY = path.join(ROOT, 'public', 'icon-source.svg');
const SRC_MASKABLE = path.join(ROOT, 'public', 'icon-maskable.svg');

// (size, purpose, basename)
const SIZES = [
  [16,   'any',      'favicon-16'],
  [32,   'any',      'favicon-32'],
  [48,   'any',      'favicon-48'],
  [152,  'any',      'icon-152'],
  [167,  'any',      'icon-167'],
  [180,  'any',      'apple-touch-icon'],
  [192,  'any',      'icon-192'],
  [256,  'any',      'icon-256'],
  [512,  'any',      'icon-512'],
  [512,  'maskable', 'icon-512-maskable'],
  [1024, 'any',      'icon-1024'],
];

const SOURCES = {
  any: SRC_ANY,
  maskable: SRC_MASKABLE,
};

async function renderOne(browser, srcPath, size, outPath) {
  const svg = await fs.readFile(srcPath, 'utf8');
  const html = `<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { width: ${size}px; height: ${size}px; overflow: hidden; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style></head><body>${svg}</body></html>`;
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    // One frame for the browser to commit the SVG layout.
    await page.waitForTimeout(50);
    await page.screenshot({
      path: outPath,
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
  } finally {
    await page.close();
  }
}

async function main() {
  await fs.mkdir(ICON_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const [size, purpose, suffix] of SIZES) {
      const src = SOURCES[purpose];
      const out = path.join(ICON_DIR, `${suffix}.png`);
      await renderOne(browser, src, size, out);
      const stat = await fs.stat(out);
      console.log(`  ✓ ${path.basename(out)}  (${size}x${size}, ${purpose}, ${stat.size} B)`);
    }
  } finally {
    await browser.close();
  }
  console.log(`\nWrote ${SIZES.length} icons to ${path.relative(ROOT, ICON_DIR)}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
