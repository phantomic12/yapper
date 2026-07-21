import { describe, it, expect } from 'vitest';
import { getMimeType, getFileExtension, MAX_PDF_PAGES } from './document-types';

describe('MAX_PDF_PAGES default', () => {
  it('is exported and is a positive integer', () => {
    expect(typeof MAX_PDF_PAGES).toBe('number');
    expect(MAX_PDF_PAGES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_PDF_PAGES)).toBe(true);
  });
});

describe('getMimeType', () => {
  it.each([
    ['pdf', 'application/pdf'],
    ['PDF', 'application/pdf'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['odt', 'application/vnd.oasis.opendocument.text'],
    ['epub', 'application/epub+zip'],
    ['txt', 'text/plain'],
    ['md', 'text/markdown'],
    ['markdown', 'text/markdown'],
  ])('maps .%s → %s', (ext, mime) => {
    expect(getMimeType(ext, '')).toBe(mime);
  });

  it('falls back to the provided mime for unknown extensions', () => {
    expect(getMimeType('xyz', 'application/octet-stream')).toBe('application/octet-stream');
    expect(getMimeType('', '')).toBe('');
  });

  it('returns the empty fallback when ext is unknown and no fallback given', () => {
    expect(getMimeType('xyz', '')).toBe('');
  });
});

describe('getFileExtension', () => {
  it.each([
    ['report.pdf', 'pdf'],
    ['REPORT.PDF', 'pdf'],
    ['my.epub', 'epub'],
    ['noextension', ''],
    ['trailing.dot.', ''],
    ['.hidden', 'hidden'],
    ['archive.tar.gz', 'gz'],
    ['with spaces.docx', 'docx'],
    ['mixed.CaSe.TxT', 'txt'],
  ])('%s → %s', (name, expected) => {
    expect(getFileExtension(name)).toBe(expected);
  });
});