import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, createReadStream } from 'node:fs';
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

/**
 * Vite plugin: copy onnxruntime-web's WASM artifacts into `public/ort-wasm/`
 * with stable filenames. Vite content-hashes the WASM bundle
 * (e.g. `ort-wasm-simd-threaded.jsep-DC5y_g6C.wasm`); the inference
 * Web Worker (`src/engines/inference-worker.ts`) historically had to
 * resolve the WASM path via `wasmPaths` / `locateFile`, and any
 * custom locateFile call needs a stable URL target. The Vite-emitted
 * hashed URL is the primary path; this plugin is a belt-and-braces
 * fallback so any explicit locateFile / wasmPaths call still
 * resolves.
 *
 * The output directory is gitignored (see `.gitignore`) — every
 * build regenerates these from `node_modules/onnxruntime-web/dist/*`.
 */
/**
 * Locate the onnxruntime-web dist directory whose build transformers.js
 * actually loads. transformers may pin its own nested copy, in which case
 * the hoisted top-level install is a different (or absent) version — so
 * prefer the nested one and fall back.
 */
function resolveOrtDist(projectRoot: string): string {
  const nested = resolve(
    projectRoot, 'node_modules', '@huggingface', 'transformers',
    'node_modules', 'onnxruntime-web', 'dist',
  );
  const topLevel = resolve(projectRoot, 'node_modules', 'onnxruntime-web', 'dist');
  return existsSync(nested) ? nested : topLevel;
}

function copyOrtWasmPlugin(): Plugin {
  return {
    name: 'copy-ort-wasm',
    apply: 'build',
    closeBundle() {
      const projectRoot = process.cwd();
      // Prefer the ORT version transformers.js actually pins (nested dep);
      // fall back to the top-level install when hoisted.
      const ortDist = resolveOrtDist(projectRoot);
      const destDir = resolve(projectRoot, 'public', 'ort-wasm');
      mkdirSync(destDir, { recursive: true });
      // Runtime loaders (.mjs) + binaries (.wasm): engine.ts sets
      // env.backends.onnx.wasm.wasmPaths to /ort-wasm/ so main-thread
      // pipelines never touch the jsdelivr CDN (blocked by CSP script-src).
      const files = readdirSync(ortDist)
        .filter((f) => f.startsWith('ort-wasm') && (f.endsWith('.wasm') || f.endsWith('.mjs')));
      let copied = 0;
      // Vite rewrites BASE_URL ('./') relative to the importing bundle, so at
      // runtime ORT requests <bundle-dir>/ort-wasm/* (i.e. dist/assets/…).
      // Cover every location the runtime can plausibly ask for.
      const assetDestDir = resolve(projectRoot, 'dist', 'assets', 'ort-wasm');
      const distDestDir = resolve(projectRoot, 'dist', 'ort-wasm');
      mkdirSync(assetDestDir, { recursive: true });
      mkdirSync(distDestDir, { recursive: true });
      for (const file of files) {
        const src = resolve(ortDist, file);
        // public/ keeps the files for the next `vite preview`/dev serve;
        // dist/ is written too because Vite copies public/ → dist/ at the
        // START of a build (closeBundle runs after that copy), so without
        // this a fresh CI build would ship no ort-wasm directory at all.
        copyFileSync(src, resolve(destDir, file));
        copyFileSync(src, resolve(distDestDir, file));
        copyFileSync(src, resolve(assetDestDir, file));
        copied++;
      }
      console.log(`[copy-ort-wasm] copied ${copied} ORT loader/WASM files → public|dist|dist/assets /ort-wasm/`);
    },
  };
}

/**
 * Vite plugin: serve the ORT runtime files from `/ort-wasm/` during `vite dev`.
 *
 * ORT loads its WASM runtime with a dynamic `import()` of
 * `ort-wasm-simd-threaded.jsep.mjs`. That file lives in `public/ort-wasm/`
 * (copied there by copy-ort-wasm on build, and by npm postinstall for dev),
 * and as of Vite 8 the dev server refuses to serve anything under `public/`
 * as a module:
 *
 *   "This file is in /public and will be copied as-is during build without
 *    going through the plugin transforms, and therefore should not be
 *    imported from source code. It can only be referenced via HTML tags."
 *
 * The dynamic import therefore 500s in dev, ORT reports "no available backend
 * found", and every model that needs the WASM runtime fails to load — Kokoro
 * included, since kokoro-js points at the same directory. Production is
 * unaffected: there the file is emitted into dist/ and imported as a normal
 * module, which is what the copy-ort-wasm plugin is for.
 *
 * So in dev we bypass the transform middleware entirely and stream the file
 * straight off disk. Registered as a pre-middleware (no returned function) so
 * it runs before Vite's own transform handling.
 */
function serveOrtWasmInDevPlugin(): Plugin {
  return {
    name: 'serve-ort-wasm-dev',
    apply: 'serve',
    configureServer(server) {
      const ortDist = resolveOrtDist(process.cwd());
      const prefix = '/ort-wasm/';
      server.middlewares.use((req, res, next) => {
        const rawUrl = (req.url ?? '').split('?')[0];
        if (!rawUrl.startsWith(prefix)) return next();
        const file = resolve(ortDist, '.' + rawUrl.slice(prefix.length - 1));
        // Contain the path inside the ORT dist dir — never let a crafted
        // request escape it with ../.
        if (!file.startsWith(ortDist) || !existsSync(file)) return next();
        res.setHeader(
          'Content-Type',
          file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        );
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [
    serveOrtWasmInDevPlugin(),
    copyPdfWorkerPlugin(),
    copyOrtWasmPlugin(),
    swCacheBustPlugin(),
  ],
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
              id.includes('node_modules/epubjs')) {
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
    // @huggingface/transformers and pdfjs-dist pull in WASM + worker assets
    // at runtime; pre-bundling breaks the dynamic import / ?url resolution
    // paths they rely on. Both ship real ESM, so serving them unbundled in
    // dev works. NOTE: tesseract.js must NOT be listed here — it is plain
    // CommonJS, and an unbundled CJS file cannot load as an ES module in
    // the browser, which hard-crashes the whole module graph under the dev
    // server (`npm run dev`). Vite's dep optimizer provides the CJS→ESM
    // interop that Rollup applies automatically at build time.
    exclude: ['@huggingface/transformers', 'pdfjs-dist'],
  },
  publicDir: 'public',
});
