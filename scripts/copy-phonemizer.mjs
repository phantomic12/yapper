#!/usr/bin/env node
// Copies xenova/phonemizer's browser bundle into public/lib/ so Kitten TTS
// can load eSpeak-NG same-origin (no jsdelivr at runtime).
//
// The package ships a single self-contained ESM file (~1.3MB) with the
// eSpeak WASM + voice data inlined — no extra .wasm assets to mirror.
//
// Runs automatically after `npm install` (postinstall hook). Idempotent.

import { copyFileSync, mkdirSync, existsSync, statSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = process.cwd();
const src = resolve(projectRoot, 'node_modules/phonemizer/dist/phonemizer.js');
const destDir = resolve(projectRoot, 'public/lib');
const dest = resolve(destDir, 'phonemizer.js');

if (!existsSync(src)) {
  console.warn('[copy-phonemizer] phonemizer not found in node_modules; skipping');
  process.exit(0);
}

if (existsSync(dest)) {
  try {
    if (statSync(src).mtimeMs === statSync(dest).mtimeMs &&
        statSync(src).size === statSync(dest).size) {
      process.exit(0);
    }
  } catch {
    // fall through and copy
  }
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
try {
  const mtime = statSync(src).mtime;
  utimesSync(dest, mtime, mtime);
} catch {
  // non-fatal
}
console.log(`[copy-phonemizer] copied ${src} → ${dest} (${statSync(dest).size} bytes)`);
