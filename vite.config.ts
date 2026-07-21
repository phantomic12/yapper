import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
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

export default defineConfig({
  plugins: [copyPdfWorkerPlugin()],
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
    exclude: ['@huggingface/transformers'],
  },
  publicDir: 'public',
});
