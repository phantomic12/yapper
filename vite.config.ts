import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Vite plugin: copies pdfjs-dist's worker into `public/` so the document
 * reader can find it at runtime without needing a Vite-specific import.
 * Runs on `build` so a fresh clone works out of the box.
 *
 * The worker is gitignored — see .gitignore — because it's a binary
 * vendored artifact, not source.
 */
function copyPdfWorkerPlugin(): Plugin {
  return {
    name: 'copy-pdf-worker',
    apply: 'build',
    closeBundle() {
      // Vite sets config.root to the project directory at config-time. Use
      // it instead of import.meta.url, which resolves to dist/ after the
      // build runs.
      const projectRoot = process.cwd();
      const src = resolve(projectRoot, 'node_modules/pdfjs-dist/build/pdf.worker.mjs');
      const destDir = resolve(projectRoot, 'public');
      const dest = resolve(destDir, 'pdf.worker.mjs');
      if (!existsSync(src)) {
        // During `npm run build` on a fresh checkout the worker should be
        // there from `npm install`. If it isn't, fail loud rather than
        // ship a broken dist.
        throw new Error(
          `pdfjs-dist worker not found at ${src}. ` +
          `Run \`npm install\` or check that pdfjs-dist is in dependencies.`,
        );
      }
      mkdirSync(destDir, { recursive: true });
      copyFileSync(src, dest);
      console.log(`[copy-pdf-worker] copied ${src} → ${dest}`);
    },
  };
}

/**
 * Vite plugin: rewrites the service worker cache name on every build
 * so the deployed app invalidates stale app-shell caches. Without this,
 * users who hit the deployed app would get the cached old shell until
 * they manually cleared site data.
 *
 * The cache name is `yapper-shell-<buildId>` where buildId is a UTC
 * timestamp truncated to the minute. Reading the build output and seeing
 * a new cache name in the SW is also useful for confirming the deploy
 * actually changed something.
 *
 * Note: public/sw.js is a STATIC asset (Vite's publicDir copies it
 * verbatim), not a Rollup bundle entry, so we can't mutate it via
 * generateBundle. We use closeBundle to read the dist output and
 * rewrite it after the copy.
 */
function swCacheBustPlugin(): Plugin {
  return {
    name: 'sw-cache-bust',
    apply: 'build',
    closeBundle() {
      const projectRoot = process.cwd();
      const swPath = resolve(projectRoot, 'dist', 'sw.js');
      if (!existsSync(swPath)) return;
      const buildId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 12);
      const newName = `yapper-shell-${buildId}`;
      const original = readFileSync(swPath, 'utf8');
      // Match both the source form (yapper-shell-v1) and any prior
      // timestamped build id so repeated builds always bust the cache.
      const updated = original
        .replace(/const SHELL_CACHE = 'yapper-shell[^']*';/, `const SHELL_CACHE = '${newName}';`)
        .replace(/'yapper-shell[^']*'/g, `'${newName}'`);
      if (updated === original) {
        // Pattern didn't match. Source probably has the new buildId
        // already (idempotent re-run) or the regex needs updating.
        console.warn(`[sw-cache-bust] no change (already at ${newName}?)`);
        return;
      }
      writeFileSync(swPath, updated);
      console.log(`[sw-cache-bust] cache name → ${newName}`);
    },
  };
}

export default defineConfig({
  plugins: [copyPdfWorkerPlugin(), swCacheBustPlugin()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Keep the heavy document/OCR libs in their own chunks so the main
          // TTS app loads instantly; they are only fetched when a user uploads.
          if (id.includes('node_modules/pdfjs-dist') ||
              id.includes('node_modules/jszip') ||
              id.includes('node_modules/epubjs') ||
              id.includes('node_modules/mammoth')) {
            return 'documents';
          }
          if (id.includes('node_modules/tesseract.js')) {
            return 'ocr';
          }
        },
      },
    },
  },
  optimizeDeps: {
    // These pull in WASM + worker assets at runtime; pre-bundling breaks the
    // dynamic import / ?url resolution paths they rely on.
    exclude: ['@huggingface/transformers', 'tesseract.js', 'pdfjs-dist'],
  },
  publicDir: 'public',
});
