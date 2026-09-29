/**
 * Exporting a document (and its notes) as files the user can keep.
 *
 * Everything here is a pure string builder: the download plumbing lives in
 * the panel, so these can be tested without a DOM, a Blob, or a click.
 */

export type ExportFormat = 'markdown' | 'html' | 'text';

export interface ExportSource {
  name: string;
  text: string;
  /** Stamped markup, when the document has a visual form. */
  html?: string;
}

export interface ExportedBookmark {
  label: string;
  offset: number;
  note?: string;
}

export interface ExportedHighlight {
  start: number;
  end: number;
  color: string;
  note?: string;
}

export interface ExportFile {
  filename: string;
  mime: string;
  content: string;
}

const EXTENSIONS: Record<ExportFormat, string> = {
  markdown: 'md',
  html: 'html',
  text: 'txt',
};

const MIME_TYPES: Record<ExportFormat, string> = {
  markdown: 'text/markdown',
  html: 'text/html',
  text: 'text/plain',
};

/** `report.docx` → `report.txt`; names without a suffix get the extension appended. */
export function exportFilename(name: string, format: ExportFormat): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'document';
  return `${base}.${EXTENSIONS[format]}`;
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the downloadable file for a document in the requested format. */
export function buildExport(source: ExportSource, format: ExportFormat): ExportFile {
  const filename = exportFilename(source.name, format);
  const mime = MIME_TYPES[format];
  if (format === 'text') {
    return { filename, mime, content: source.text };
  }
  if (format === 'html') {
    const body = source.html
      ?? `<pre>${escapeHtmlText(source.text)}</pre>`;
    const content = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n`
      + `<title>${escapeHtmlText(source.name)}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
    return { filename, mime, content };
  }
  // Markdown: the extracted text is already paragraph-separated prose, so it
  // passes through with only a heading above it.
  const content = `# ${source.name}\n\n${source.text.trim()}\n`;
  return { filename, mime, content };
}

/**
 * Bookmarks and highlights as one Markdown note page.
 *
 * Highlight quotes come from `source.text` at the stored offsets, so the
 * export reads like annotated prose instead of a table of numbers.
 */
export function buildNotesExport(
  source: ExportSource,
  bookmarks: ExportedBookmark[],
  highlights: ExportedHighlight[],
): ExportFile {
  const base = source.name.replace(/\.[^./\\]+$/, '') || 'document';
  const lines: string[] = [`# Notes — ${source.name}`, ''];
  if (bookmarks.length) {
    lines.push('## Bookmarks', '');
    for (const bookmark of bookmarks) {
      lines.push(`- **${bookmark.label}** (at ${bookmark.offset})`);
      if (bookmark.note) lines.push(`  - ${bookmark.note}`);
    }
    lines.push('');
  }
  if (highlights.length) {
    lines.push('## Highlights', '');
    for (const highlight of highlights) {
      const quote = source.text.slice(highlight.start, highlight.end).replace(/\s+/g, ' ').trim();
      lines.push(`- (${highlight.color}) ${quote ? `“${quote}”` : `[${highlight.start}–${highlight.end}]`}`);
      if (highlight.note) lines.push(`  - ${highlight.note}`);
    }
    lines.push('');
  }
  if (!bookmarks.length && !highlights.length) {
    lines.push('_No bookmarks or highlights yet._', '');
  }
  return {
    filename: `${base}-notes.md`,
    mime: MIME_TYPES.markdown,
    content: lines.join('\n'),
  };
}
