/**
 * Static capability checks for document extraction.
 *
 * pdfjs-dist 6 uses `Promise.try(...)` inside its message layer
 * (`pdf.mjs` LoopbackPort/MessageHandler dispatch, and the same code runs in
 * the real worker bundle). On engines without the static method — Chrome <
 * ~128, Node < 24 — every worker round-trip throws synchronously before a
 * reply is ever posted back, so `getDocument().promise` NEVER SETTLES: no
 * resolve, no reject. A plain try/catch around extractDocument therefore
 * cannot help; the await just hangs forever and the panel sticks on
 * "Reading PDF file…".
 *
 * The fix has three legs (see src/ui/document-panel.ts):
 *   1. this upfront gate — refuse to even start PDF extraction on an engine
 *      that cannot run pdfjs 6, with an actionable message naming the
 *      minimum version;
 *   2. a stall watchdog — any extraction whose progress events stop for too
 *      long is converted into a rejected promise (covers hangs that are not
 *      the known Promise.try gap, e.g. a wedged worker);
 *   3. an inline error state in the reader panel so the failure is visible
 *      where the user is looking, not only in the top status banner.
 *
 * Kept separate from document-reader.ts (which pulls in heavy pdfjs /
 * tesseract imports) so unit tests can exercise it in isolation.
 */

/** First Chrome/V8 version shipping Promise.try (V8 13.x / Chrome 128). */
export const MIN_PDF_ENGINE_CHROME = 128;

/** True when this engine's Promise has the static `try` pdfjs 6 requires. */
export function engineSupportsPdfJs(): boolean {
  // Promise.try is ES2025; the tsconfig lib is ES2022 so go through a
  // structural probe instead of a direct typed reference.
  const P = Promise as unknown as { try?: unknown };
  return typeof P.try === 'function';
}

/**
 * User-facing explanation when the gate fails. Names the capability, why it
 * matters, and what to do about it (upgrade; other formats still work).
 */
export function pdfUnsupportedMessage(): string {
  return (
    `This browser's PDF engine is missing Promise.try (needs Chrome ${MIN_PDF_ENGINE_CHROME}+, ` +
    `Edge ${MIN_PDF_ENGINE_CHROME}+, Firefox 134+, or Safari 18.3+). ` +
    `PDF reading is disabled; update your browser, or upload TXT/DOCX instead.`
  );
}
