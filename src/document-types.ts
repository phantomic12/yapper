/**
 * Pure helpers for document routing. Kept in a separate file so they can
 * be unit-tested without pulling in pdfjs / tesseract / jszip / epubjs.
 */

export function getMimeType(ext: string, fallback: string): string {
  const e = ext.toLowerCase();
  if (e === 'pdf') return 'application/pdf';
  if (e === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (e === 'odt') return 'application/vnd.oasis.opendocument.text';
  if (e === 'epub') return 'application/epub+zip';
  if (e === 'txt') return 'text/plain';
  if (e === 'md' || e === 'markdown') return 'text/markdown';
  return fallback;
}

/**
 * Extract the file extension (lowercase, no dot) from a file name. Returns
 * the empty string when no extension is present.
 */
export function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}