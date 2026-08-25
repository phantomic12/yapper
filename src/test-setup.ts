/**
 * Vitest setup: environment shims that must exist BEFORE test modules import
 * the app source.
 *
 * pdfjs-dist's canvas display layer constructs a DOMMatrix at module load
 * time, which jsdom does not provide. Any test importing document-reader.ts
 * (directly or transitively) would crash with "DOMMatrix is not defined"
 * before even reaching its assertions, so install a minimal stand-in here
 * where it applies to the whole run.
 */
class DOMMatrixStub {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  m11 = 1; m12 = 0; m13 = 0; m14 = 0;
  m21 = 0; m22 = 1; m23 = 0; m24 = 0;
  m31 = 0; m32 = 0; m33 = 1; m34 = 0;
  m41 = 0; m42 = 0; m43 = 0; m44 = 1;
  is2D = true;
  get isIdentity(): boolean { return true; }
}

if (!('DOMMatrix' in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).DOMMatrix = DOMMatrixStub;
}
