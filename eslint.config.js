// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser globals we actually use
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        FileReader: 'readonly',
        Audio: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        RequestInit: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        DOMParser: 'readonly',
        Document: 'readonly',
        HTMLElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLDetailsElement: 'readonly',
        HTMLPreElement: 'readonly',
        Event: 'readonly',
        File: 'readonly',
        FileList: 'readonly',
        DataTransfer: 'readonly',
        DragEvent: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        // Browser-only APIs we use that aren't in DOM lib but ship in browsers
        gpu: 'readonly',
        requestAdapter: 'readonly',
        queueMicrotask: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      // Match the project's tsconfig.json (which keeps these off so the
      // build doesn't fail on dead code during rapid iteration). ESLint can
      // still warn on truly unused exports via `no-unused-vars` below.
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off', // used heavily in DOM accessors
      // Allow non-null assertions in tests
      'no-unused-vars': 'off', // superseded by @typescript-eslint/no-unused-vars
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: {
      // Tests are allowed to use any freely — mocks need it
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);