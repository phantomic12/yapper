import { describe, it, expect } from 'vitest';
import {
  getMimeType, getFileExtension, MAX_PDF_PAGES, quadToBbox,
  stripRtfControlWords, parseCsv,
  type OcrMode, type QuadWord,
} from './document-types';

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
    ['doc', 'application/msword'],
    ['odt', 'application/vnd.oasis.opendocument.text'],
    ['rtf', 'application/rtf'],
    ['epub', 'application/epub+zip'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['csv', 'text/csv'],
    ['html', 'text/html'],
    ['htm', 'text/html'],
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

// ─── OcrMode type ─────────────────────────────────────────────────

describe('OcrMode type', () => {
  it('accepts tesseract and llm values', () => {
    const tesseract: OcrMode = 'tesseract';
    const llm: OcrMode = 'llm';
    expect(tesseract).toBe('tesseract');
    expect(llm).toBe('llm');
  });
});

// ─── quadToBbox — Florence-2 quad → axis-aligned bbox conversion ──

describe('quadToBbox', () => {
  it('converts an axis-aligned quad to the correct bbox', () => {
    const word: QuadWord = {
      text: 'Hello',
      quad: [10, 20, 60, 20, 60, 50, 10, 50],
    };
    const result = quadToBbox(word);
    expect(result.text).toBe('Hello');
    expect(result.bbox).toEqual({ x0: 10, y0: 20, x1: 60, y1: 50 });
  });

  it('converts a rotated quad to the bounding rectangle', () => {
    // A diamond shape: top=10,20  right=50,10  bottom=10,50  left=20,40
    // Wait — let's use a real rotated rectangle:
    // Point order: top-left, top-right, bottom-right, bottom-left
    // For a 45°-rotated square:
    const word: QuadWord = {
      text: 'rotated',
      quad: [30, 0, 40, 10, 30, 20, 20, 10],
    };
    const result = quadToBbox(word);
    // Bounding box: x0=20, y0=0, x1=40, y1=20
    expect(result.bbox).toEqual({ x0: 20, y0: 0, x1: 40, y1: 20 });
  });

  it('handles degenerate quad (all same point)', () => {
    const word: QuadWord = {
      text: 'point',
      quad: [50, 50, 50, 50, 50, 50, 50, 50],
    };
    const result = quadToBbox(word);
    expect(result.bbox).toEqual({ x0: 50, y0: 50, x1: 50, y1: 50 });
  });

  it('preserves the text field', () => {
    const word: QuadWord = {
      text: 'Florence-2',
      quad: [0, 0, 100, 0, 100, 30, 0, 30],
    };
    const result = quadToBbox(word);
    expect(result.text).toBe('Florence-2');
  });

  it('handles negative coordinates', () => {
    const word: QuadWord = {
      text: 'negative',
      quad: [-10, -20, 30, -20, 30, 10, -10, 10],
    };
    const result = quadToBbox(word);
    expect(result.bbox).toEqual({ x0: -10, y0: -20, x1: 30, y1: 10 });
  });

  it('correctly computes bbox when quad points are not in TL-TR-BR-BL order', () => {
    // Points in random order: BR, TL, BL, TR
    const word: QuadWord = {
      text: 'shuffled',
      quad: [60, 50, 10, 20, 10, 50, 60, 20],
    };
    const result = quadToBbox(word);
    // Should still compute the correct bounding box regardless of point order
    expect(result.bbox).toEqual({ x0: 10, y0: 20, x1: 60, y1: 50 });
  });
});

// ─── stripRtfControlWords ─────────────────────────────────────────

describe('stripRtfControlWords', () => {
  it('extracts plain text from a simple RTF document', () => {
    const rtf = '{\\rtf1\\ansi Hello World\\par\\0}';
    const text = stripRtfControlWords(rtf);
    expect(text).toContain('Hello World');
  });

  it('converts \\par to newlines', () => {
    const rtf = '{\\rtf1 Line 1\\par Line 2\\par Line 3}';
    const text = stripRtfControlWords(rtf);
    expect(text).toBe('Line 1\nLine 2\nLine 3');
  });

  it('converts \\tab to tabs', () => {
    const rtf = '{\\rtf1 Col1\\tab Col2}';
    const text = stripRtfControlWords(rtf);
    // \tab produces a tab; the space after Col2 is part of the text
    expect(text).toContain('Col1');
    expect(text).toContain('\t');
    expect(text).toContain('Col2');
  });

  it('handles Unicode escapes (\\uN?)', () => {
    // \u8212? is the em dash (—)
    const rtf = '{\\rtf1 Hello\\u8212? World}';
    const text = stripRtfControlWords(rtf);
    expect(text).toBe('Hello\u2014 World');
  });

  it('handles negative Unicode escapes', () => {
    // \u-32768? maps to 32768 in unsigned 16-bit
    const rtf = '{\\rtf1 \\u-32768?}';
    const text = stripRtfControlWords(rtf);
    expect(text).toBe(String.fromCharCode(32768));
  });

  it('handles hex escapes (\\\'XX)', () => {
    // \'e9 is é in Latin-1
    const rtf = "{\\rtf1 caf\\'e9}";
    const text = stripRtfControlWords(rtf);
    expect(text).toBe('caf\u00e9');
  });

  it('skips control word parameters', () => {
    // \fs24 is a font size control word with parameter 24
    const rtf = '{\\rtf1\\fs24 Hello}';
    const text = stripRtfControlWords(rtf);
    expect(text).toBe('Hello');
  });

  it('skips group delimiters { and }', () => {
    const rtf = '{\\rtf1 {\\b Bold} text}';
    const text = stripRtfControlWords(rtf);
    expect(text).toBe('Bold text');
  });

  it('collapses excessive whitespace', () => {
    const rtf = '{\\rtf1   Hello    World   \\par\\par\\par\\par Next}';
    const text = stripRtfControlWords(rtf);
    // The \par control words produce newlines; spaces before \par are
    // preserved as a single space, then the newline follows.
    expect(text).toContain('Hello World');
    expect(text).toContain('Next');
    // No more than 2 consecutive newlines
    expect(text).not.toMatch(/\n{3,}/);
    // No multiple consecutive spaces (except after tabs)
    expect(text).not.toMatch(/(?<!\t)  +/);
  });

  it('returns empty string for RTF with no text', () => {
    const rtf = '{\\rtf1\\ansi\\fs24}';
    const text = stripRtfControlWords(rtf);
    expect(text).toBe('');
  });
});

// ─── parseCsv ─────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('parses a simple CSV', () => {
    const csv = 'a,b,c\n1,2,3';
    const rows = parseCsv(csv);
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quoted fields with commas', () => {
    const csv = '"hello, world","foo"\n"bar","baz"';
    const rows = parseCsv(csv);
    expect(rows).toEqual([['hello, world', 'foo'], ['bar', 'baz']]);
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    const csv = '"She said ""hello""","next"';
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(['She said "hello"', 'next']);
  });

  it('handles quoted fields with embedded newlines', () => {
    const csv = '"line1\nline2","second"';
    const rows = parseCsv(csv);
    expect(rows).toEqual([['line1\nline2', 'second']]);
  });

  it('handles \\r\\n line endings', () => {
    const csv = 'a,b\r\nc,d';
    const rows = parseCsv(csv);
    expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('handles \\r-only line endings', () => {
    const csv = 'a,b\rc,d';
    const rows = parseCsv(csv);
    expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('handles empty fields', () => {
    const csv = 'a,,c\n,,';
    const rows = parseCsv(csv);
    expect(rows).toEqual([['a', '', 'c'], ['', '', '']]);
  });

  it('handles a single row without trailing newline', () => {
    const csv = 'a,b,c';
    const rows = parseCsv(csv);
    expect(rows).toEqual([['a', 'b', 'c']]);
  });

  it('handles empty input', () => {
    const rows = parseCsv('');
    expect(rows).toEqual([]);
  });

  it('handles numbers and special characters', () => {
    const csv = '123.45,$10.00,50%\n-1,1e5,<5';
    const rows = parseCsv(csv);
    expect(rows).toEqual([['123.45', '$10.00', '50%'], ['-1', '1e5', '<5']]);
  });
});