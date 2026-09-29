/**
 * Extraction worker: parses DOCX/DOC/ODT/RTF/XLSX/PPTX/CSV/HTML/TXT files
 * off the main thread so a large spreadsheet cannot freeze the reader page.
 *
 * The protocol is the one defined in `document-formats.ts`: a request is
 * `{ id, kind, file }`, replies carry the same `id`, and `{ id, progress }`
 * messages keep the caller's stall watchdog alive between parse stages.
 * Errors travel back as plain text — an Error object's message is the only
 * part that reliably structure-clones across worker boundaries.
 */
import {
  extractFormat,
  type FormatWorkerRequest,
  type FormatWorkerResponse,
} from './document-formats';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FormatWorkerRequest>) => void) | null;
  postMessage(message: FormatWorkerResponse): void;
};

scope.onmessage = async (event: MessageEvent<FormatWorkerRequest>) => {
  const { id, kind, file } = event.data;
  scope.postMessage({ id, progress: `Reading ${kind.toUpperCase()} file…` });
  try {
    const doc = await extractFormat(kind, file);
    scope.postMessage({ id, ok: true, doc });
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
