import { defineConfig } from 'vite';

export default defineConfig({
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
