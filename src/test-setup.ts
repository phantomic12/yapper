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

/**
 * A deterministic `URL.createObjectURL`, replacing jsdom's.
 *
 * jsdom's object-URL path goes through Vitest's `makeCompatBlob`, which finds
 * jsdom's internal blob impl by reading the FIRST OWN SYMBOL off a `Blob`.
 * jsdom 30.1 moved that impl out of a symbol and into a private `#impl` class
 * field, so a Blob now has no own symbols, the lookup yields `undefined`, and
 * every call throws `Cannot read properties of undefined (reading
 * '_buffer')` — which lands inside the job loop right after a clip is
 * synthesised, turning a perfectly good generation into a job error.
 *
 * Tracked upstream as vitest-dev/vitest#11336 (jsdom 30.1.0 and 30.1.1; a
 * Blob in a Request/FormData body is separately broken since 30.0.1,
 * #11294). Until it is fixed, the suite takes object URLs from here instead:
 * a real browser's implementation is opaque anyway, and the only thing the
 * app promises is that a finished job carries a usable URL. Tests that care
 * about the exact string keep using `vi.spyOn(URL, 'createObjectURL')`, which
 * still works over this definition.
 *
 * Delete this once #11336 lands and jsdom's version is unblocked.
 */
if (typeof URL !== 'undefined') {
  let counter = 0;
  const live = new Set<string>();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (obj: Blob | MediaSource): string => {
      void obj;
      const url = `blob:yapper/${++counter}`;
      live.add(url);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string): void => {
      live.delete(url);
    },
  });
  // Exposed only so a test can assert a URL was actually handed out and then
  // revoked; the engine itself never reads it.
  (globalThis as unknown as Record<string, unknown>).__blobUrls = live;
}
