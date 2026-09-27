/**
 * A built-in sample document for the Reader page.
 *
 * The Reader's whole point — structure-aware reading — is invisible until
 * you feed it a document, and "go find a PDF" is a poor first impression for
 * a feature the visitor has not seen work yet. This sample is deliberately
 * shaped to exercise the whole pipeline: a heading, prose, a list, a block
 * quote, a markdown table and a code block, so every branch of the
 * classifier and the block renderer has something to show.
 *
 * The text is original, short enough to read aloud in well under a minute,
 * and says what the app does — a sample that describes itself is more useful
 * than lorem ipsum with a table in it.
 */

import type { ExtractedDocument } from './document-reader';

const SAMPLE_TEXT = `# Local text-to-speech, end to end

Yapper turns a document into speech without sending a byte anywhere. Drop a
file in and it extracts the text, works out what each block of that text is,
and reads it back to you in a voice you pick.

## What the reader handles

- PDF, DOCX, ODT, RTF, EPUB, PPTX, XLSX, CSV, HTML, Markdown and plain text
- Scanned PDFs, through OCR, when a file has no text layer to extract
- Long documents: a few parts are queued ahead of the one playing, so speech starts almost immediately

## Every block gets a label

The reader does not hand you a wall of text. It splits the document into
blocks and works out what each one is, so a heading looks like a heading, a
list keeps its items, and a table stays a table.

> A tool that keeps your documents on your machine is not the slow option. It is the honest one.

## Formats at a glance

| Format | Text extracted | Needs OCR |
| --- | --- | --- |
| PDF | yes | only for scans |
| DOCX, ODT, RTF | yes | no |
| EPUB, HTML, Markdown | yes | no |
| Scanned image | no | yes |

Nothing above was uploaded to get here. The models, the clips and these
settings all live in this tab, and they go when you close it.
`;

export const SAMPLE_DOCUMENT: ExtractedDocument = {
  name: 'Sample document',
  mimeType: 'text/markdown',
  text: SAMPLE_TEXT,
};
