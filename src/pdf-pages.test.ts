import { describe, it, expect } from 'vitest';
import { PDF_LINE_SEPARATOR, assemblePdfPages, type PdfPageLine } from './pdf-pages';

const box = (x: number) => ({ x, y: 20, width: 10, height: 10 });

function textLine(text: string, rect = box(0)): PdfPageLine {
  return { text, rect };
}

function runLine(text: string, runs: string[]): PdfPageLine {
  const result: PdfPageLine['runs'] = [];
  let at = 0;
  runs.forEach((run, index) => {
    result.push({ ...box(10 + index * 10), start: at, end: at + run.length });
    at += run.length;
    if (index < runs.length - 1) at += 1; // the space between items
  });
  return { text, runs: result };
}

describe('assemblePdfPages', () => {
  it('joins pages with a blank line and points anchors at the right characters', () => {
    const result = assemblePdfPages([
      [runLine('Page one', ['Page', 'one'])],
      [runLine('Page two', ['Page', 'two'])],
    ]);
    expect(result.text).toBe('Page one\n\nPage two');
    expect(result.anchors).toHaveLength(4);
    expect(result.anchors[0]).toMatchObject({ start: 0, end: 4, page: 1 });
    expect(result.anchors[1]).toMatchObject({ start: 5, end: 8, page: 1 });
    // 8 characters + a two-character separator.
    expect(result.anchors[2]).toMatchObject({ start: 10, end: 14, page: 2 });
    expect(result.anchors[3]).toMatchObject({ start: 15, end: 18, page: 2 });
  });

  it('uses the exported separator constant', () => {
    expect(PDF_LINE_SEPARATOR).toBe('\n\n');
    const result = assemblePdfPages([[textLine('a')], [textLine('b')]]);
    expect(result.text).toBe(`a${PDF_LINE_SEPARATOR}b`);
  });

  it('emits layout blocks for OCR lines only, with corrected text', () => {
    const result = assemblePdfPages(
      [
        [textLine('modem report', box(5))],
        [textLine('second page', box(7))],
      ],
      { corrections: [{ find: 'modem', replace: 'modern' }] },
    );
    expect(result.layoutBlocks).toEqual([
      { page: 1, text: 'modern report', x: 5, y: 20, width: 10, height: 10 },
      { page: 2, text: 'second page', x: 7, y: 20, width: 10, height: 10 },
    ]);
    expect(result.replacements).toBe(1);
  });

  it('skips blank lines instead of adding empty paragraphs', () => {
    const result = assemblePdfPages([[textLine('one'), textLine('   '), textLine('two')]]);
    expect(result.text).toBe('one\n\ntwo');
  });

  it('keeps per-run anchors when no correction fires on the line', () => {
    const result = assemblePdfPages([[runLine('modem report', ['modem', 'report'])]], {
      corrections: [{ find: 'printer', replace: 'press' }],
    });
    expect(result.anchors).toHaveLength(2);
    expect(result.anchors[0]).toMatchObject({ start: 0, end: 5, x: 10 });
    expect(result.anchors[1]).toMatchObject({ start: 6, end: 12, x: 20 });
  });

  it('coarsens a corrected line to one line-wide anchor', () => {
    const result = assemblePdfPages([[runLine('modem report', ['modem', 'report'])]], {
      corrections: [{ find: 'modem', replace: 'modern' }],
    });
    expect(result.text).toBe('modern report');
    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0]).toMatchObject({
      start: 0,
      end: 13,
      x: 10,
      y: 20,
      width: 20,
      height: 10,
    });
  });

  it('does not coarsen when a rule is present but does not match', () => {
    const result = assemblePdfPages([[runLine('clean text', ['clean', 'text'])]], {
      corrections: [{ find: 'dirty', replace: 'clean' }],
    });
    expect(result.anchors).toHaveLength(2);
    expect(result.replacements).toBe(0);
  });

  describe('header/footer suppression', () => {
    const pages: PdfPageLine[][] = [
      [textLine('Running Head'), textLine('Body one')],
      [textLine('Running Head'), textLine('Body two')],
      [textLine('Running Head'), textLine('Body three')],
      [textLine('Running Head'), textLine('Body four')],
    ];

    it('drops the repeated line and reflows every later offset', () => {
      const result = assemblePdfPages(pages, { stripPageMargins: true });
      expect(result.text).toBe('Running Head\n\nBody one\n\nBody two\n\nBody three\n\nBody four');
      expect(result.removedLines).toBe(3);
      // 'Running Head' is 12 characters, then the separator.
      expect(result.anchors[1]).toMatchObject({ start: 14, end: 22, page: 1 });
      expect(result.anchors[2]).toMatchObject({ start: 24, end: 32, page: 2 });
    });

    it('keeps everything when suppression is off', () => {
      const result = assemblePdfPages(pages, { stripPageMargins: false });
      expect(result.removedLines).toBe(0);
      expect(result.text.startsWith('Running Head\n\nBody one\n\nRunning Head')).toBe(true);
    });

    it('judges the page before corrections run', () => {
      // The rule would rewrite the header, but suppression is decided on the
      // raw line — a correction must not hide furniture from the heuristic.
      const result = assemblePdfPages(pages, {
        stripPageMargins: true,
        corrections: [{ find: 'Running Head', replace: 'A Title' }],
      });
      expect(result.removedLines).toBe(3);
      expect(result.text).toBe('A Title\n\nBody one\n\nBody two\n\nBody three\n\nBody four');
    });

    it('passes margin options through to the detector', () => {
      const narrow: PdfPageLine[][] = Array.from({ length: 4 }, (_, index) => [
        textLine(`Layer one ${index}`),
        textLine(`Layer two ${index}`),
        textLine('Header'),
        textLine(`Layer four ${index}`),
        textLine(`Layer five ${index}`),
      ]);
      // "Header" is the third line, outside the default two-line band.
      expect(assemblePdfPages(narrow, { stripPageMargins: true }).removedLines).toBe(0);
      expect(assemblePdfPages(narrow, {
        stripPageMargins: true,
        marginOptions: { marginLines: 3 },
      }).removedLines).toBe(3);
    });
  });

  it('returns an empty document for empty pages', () => {
    const result = assemblePdfPages([]);
    expect(result).toEqual({
      text: '',
      anchors: [],
      layoutBlocks: [],
      removedLines: 0,
      replacements: 0,
    });
  });

  it('leaves text-only pages unanchored without failing', () => {
    const result = assemblePdfPages([[{ text: 'bare text' }]]);
    expect(result.text).toBe('bare text');
    expect(result.anchors).toEqual([]);
  });
});
