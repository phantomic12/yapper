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

// iOS launch images. iOS uses device-pixel-ratio matching against the
// viewport dimensions, so we ship one image per device class. The
// "(orientation)" suffix in apple-touch-startup-image's media query
// lets iOS pick the right one for the current device + orientation.
//
// Reference: https://developer.apple.com/design/human-interface-guidelines/ios/icons-and-images/launch-screen/
//
// iOS devices in 2024+ and their launch image sizes:
//   iPhone 16 Pro Max    1320x2868  @3x
//   iPhone 16 Pro         1206x2620  @3x
//   iPhone 16 Plus        1290x2796  @3x
//   iPhone 16 / 15 / 14   1179x2556  @3x
//   iPhone 14 Pro         1179x2556  @3x
//   iPhone 13 Pro Max     1284x2778  @3x
//   iPhone 13 / 12 Pro     1170x2532  @3x
//   iPhone 11 Pro Max     1242x2688  @3x
//   iPhone 11 / XR         828x1792  @2x
//   iPhone 8 Plus          1080x1920  @3x
//   iPhone 8 / SE 2/3       750x1334  @2x
//   iPhone SE 1 / 5         640x1136  @2x
//   iPad Pro 12.9"         2048x2732  @2x
//   iPad Pro 11"           1668x2388  @2x
//   iPad Air 10.5" / Pro 10.5"  1668x2224  @2x
//   iPad 9.7" / mini       1536x2048  @2x
//
// iOS automatically crops these to the safe area; we ship the full
// viewport so we don't have to maintain a per-device safe-area map.
const SPLASHES = [
  // [w, h, basename, media-query-suffix (empty for default)]
  [640,  1136, 'splash-640x1136',   ''],
  [750,  1334, 'splash-750x1334',   ''],
  [828,  1792, 'splash-828x1792',   ''],
  [1080, 1920, 'splash-1080x1920', ''],
  [1170, 2532, 'splash-1170x2532', ''],
  [1179, 2556, 'splash-1179x2556', ''],
  [1206, 2620, 'splash-1206x2620', ''],
  [1242, 2208, 'splash-1242x2208', ''],
  [1242, 2688, 'splash-1242x2688', ''],
  [1284, 2778, 'splash-1284x2778', ''],
  [1290, 2796, 'splash-1290x2796', ''],
  [1320, 2868, 'splash-1320x2868', ''],
  [1536, 2048, 'splash-1536x2048', ''],
  [1668, 2224, 'splash-1668x2224', ''],
  [1668, 2388, 'splash-1668x2388', ''],
  [2048, 2732, 'splash-2048x2732', ''],
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
    // iOS launch images — render the primary icon at splash dimensions.
    // The full-bleed gradient + the "Y" mark read at every phone size;
    // iOS handles the safe-area crop for us. Background is the brand
    // gradient (same as icon-source.svg) so there's no white flash
    // between the system splash and our app.
    for (const [w, h, suffix] of SPLASHES) {
      const out = path.join(ICON_DIR, `${suffix}.png`);
      await renderOne(browser, SRC_ANY, w, out);
      const stat = await fs.stat(out);
      console.log(`  ✓ ${path.basename(out)}  (${w}x${h}, splash, ${stat.size} B)`);
    }
  } finally {
    await browser.close();
  }
  console.log(`\nWrote ${SIZES.length + SPLASHES.length} images to ${path.relative(ROOT, ICON_DIR)}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
