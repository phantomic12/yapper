#!/usr/bin/env node
// Copies pdfjs-dist's worker file into public/ so Vite serves it at a
// stable relative path (the doc reader resolves it via window.location).
//
// The copy is not byte-for-byte: an import of the engine shim is prepended.
// pdfjs 6.3 uses ES2025 built-ins (Uint8Array hex/base64, Map/Set upsert)
// without a feature check, so on an engine between Chrome 128 and the
// release that shipped them every PDF import throws
// "hashOriginal.toHex is not a function" or
// "getOrInsertComputed is not a function". The worker has its own global
// scope, so the shim has to be inside the worker bundle — patching the main
// thread would not reach it. See src/pdfjs-engine-shim.js.
//
// This module is the single implementation: the `npm install` postinstall
// hook runs it for `npm run dev` (which needs public/ populated before the
// server starts), and vite.config.ts's copy-pdf-worker plugin calls the
// same function on `build`. They used to be two copies of a plain
// copyFileSync, and the build silently clobbered the shimmed worker with a
// bare one.

import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHIM_IMPORT = "import './pdfjs-engine-shim.mjs';\n";

/**
 * Write public/pdf.worker.mjs (shim import + pdfjs worker) and
 * public/pdfjs-engine-shim.mjs, unless both are already up to date.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] Defaults to process.cwd().
 * @param {boolean} [options.required] Throw when pdfjs-dist is missing.
 *   The build path wants a loud failure; the postinstall path in a pruned
 *   sandbox wants a silent skip.
 * @returns {{ wrote: boolean, dest: string }}
 */
export function syncPdfWorker(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const required = options.required ?? false;

  const src = resolve(projectRoot, 'node_modules/pdfjs-dist/build/pdf.worker.mjs');
  const shimSrc = resolve(projectRoot, 'src/pdfjs-engine-shim.js');
  const destDir = resolve(projectRoot, 'public');
  const dest = resolve(destDir, 'pdf.worker.mjs');
  const shimDest = resolve(destDir, 'pdfjs-engine-shim.mjs');

  if (!existsSync(src)) {
    if (required) {
      // A fresh checkout that skipped the postinstall hook would otherwise
      // ship a dist with no worker at all.
      throw new Error(
        `pdfjs-dist worker not found at ${src}. ` +
        'Run `npm install` or check that pdfjs-dist is in dependencies.',
      );
    }
    return { wrote: false, dest };
  }

  mkdirSync(destDir, { recursive: true });

  // The shim is copied as a real file next to the worker: the worker imports
  // it as a module, and it is the *same file* the main thread imports, so
  // there is only ever one implementation to keep in step.
  const shim = readFileSync(shimSrc, 'utf8');
  const shimChanged = !existsSync(shimDest) || readFileSync(shimDest, 'utf8') !== shim;

  // Skip only when the destination is already the shimmed, up-to-date copy.
  // "Up to date" is dest-at-least-as-new-as-src: comparing for equality can
  // never hold, because writing the copy is what sets dest's mtime.
  if (!shimChanged && existsSync(dest)) {
    try {
      const head = readFileSync(dest, 'utf8').slice(0, SHIM_IMPORT.length);
      if (head === SHIM_IMPORT && statSync(dest).mtimeMs >= statSync(src).mtimeMs) {
        return { wrote: false, dest };
      }
    } catch {
      // stat can fail on weird filesystems; fall through and copy.
    }
  }

  if (shimChanged) {
    writeFileSync(shimDest, shim);
  }
  writeFileSync(dest, SHIM_IMPORT + readFileSync(src, 'utf8'));
  console.log(`[copy-pdf-worker] wrote ${dest} (shim + pdfjs worker)`);
  return { wrote: true, dest };
}

// Only run when invoked directly (`node scripts/copy-pdf-worker.mjs`), never
// when vite.config.ts imports it — a process.exit in there would take the
// whole build down with it.
const invokedDirectly = process.argv[1]
  && (
    pathToFileURL(process.argv[1]).href === import.meta.url
    || basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])
  );
if (invokedDirectly) {
  syncPdfWorker({ required: false });
}
