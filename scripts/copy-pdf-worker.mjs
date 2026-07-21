#!/usr/bin/env node
// Copies pdfjs-dist's worker file into public/ so Vite serves it at a
// stable relative path (the doc reader resolves it via window.location).
//
// Runs automatically after `npm install` (postinstall hook). Idempotent —
// running it twice is a no-op if the worker hasn't changed.

import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = process.cwd();
const src = resolve(projectRoot, 'node_modules/pdfjs-dist/build/pdf.worker.mjs');
const destDir = resolve(projectRoot, 'public');
const dest = resolve(destDir, 'pdf.worker.mjs');

if (!existsSync(src)) {
  // pdfjs-dist isn't installed (e.g. in a CI sandbox that prunes deps).
  // Skip silently — the build will fail loudly with a clearer message.
  process.exit(0);
}

// Skip if the destination is already up-to-date (mtime matches).
if (existsSync(dest)) {
  try {
    if (statSync(src).mtimeMs === statSync(dest).mtimeMs) {
      process.exit(0);
    }
  } catch {
    // stat can fail on weird filesystems; fall through and copy.
  }
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-pdf-worker] copied ${src} → ${dest}`);