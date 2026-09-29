import { describe, it, expect } from 'vitest';
import {
  blocksToTextAndHtml,
  escapeHtmlText,
  overlappingRanges,
  parseOffsetAttr,
  type DocumentBlock,
} from './document-html';

const p = (...texts: string[]): DocumentBlock => ({
  kind: 'p',
  runs: texts.map(text => ({ text })),
});

/** Parse generated markup and read back what each stamp claims to cover. */
function stampedTexts(html: string): { text: string; start: number; end: number }[] {
  const host = document.createElement('div');
  host.innerHTML = html;
  return Array.from(host.querySelectorAll<HTMLElement>('[data-off]')).map(el => {
    const [start, end] = (el.dataset.off ?? '').split(':').map(Number);
    return { text: el.textContent ?? '', start, end };
  });
}

describe('blocksToTextAndHtml', () => {
  it('keeps the extracted text exactly as the paragraph join produced it', () => {
    // The previous extractor pushed each non-blank paragraph untrimmed and
    // joined with a blank line. Every offset in the app points into this
    // string, so the shape of it is a contract, not a formatting choice.
    const { text } = blocksToTextAndHtml([
      p('First paragraph.'),
      p('   '),
      p('Second paragraph.'),
    ]);
    expect(text).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('stamps ranges that address the text they were built from', () => {
    // The invariant the whole highlight rests on: for every stamped element,
    // the text it holds is exactly the slice of the document text its range
    // names. If this ever fails, every highlight after the drift point is on
    // the wrong paragraph and it looks like a rendering bug, not a data bug.
    const { text, html } = blocksToTextAndHtml([
      { kind: 'h1', runs: [{ text: 'A Heading' }] },
      p('First paragraph with', ' bold text and', ' more.'),
      p('Second paragraph.'),
      { kind: 'li', runs: [{ text: 'A list item' }] },
    ]);
    const stamps = stampedTexts(html);
    expect(stamps.length).toBeGreaterThan(0);
    for (const s of stamps) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('drops blank paragraphs from the markup as well as the text', () => {
    // If a blank paragraph were stamped it would shift every later range by
    // its length, because it contributes nothing to the text.
    const { text, html } = blocksToTextAndHtml([p('A'), p('   '), p('B')]);
    expect(text).toBe('A\n\nB');
    expect(html).not.toContain('   ');
    const stamps = stampedTexts(html);
    expect(stamps.map(s => s.text)).toEqual(['A', 'B']);
    expect(text.slice(stamps[1].start, stamps[1].end)).toBe('B');
  });

  it('gives consecutive blocks the offsets the join separator implies', () => {
    const { text, html } = blocksToTextAndHtml([p('AAAA'), p('BB')]);
    const stamps = stampedTexts(html);
    expect(stamps[0]).toMatchObject({ start: 0, end: 4 });
    // 4 chars + the two-character '\n\n' separator.
    expect(stamps[1]).toMatchObject({ start: 6, end: 8 });
    expect(text.slice(6, 8)).toBe('BB');
  });

  it('splits a paragraph into its runs with correct sub-ranges', () => {
    const { text, html } = blocksToTextAndHtml([
      p('plain ', 'added'),
    ]);
    const stamps = stampedTexts(html);
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toMatchObject({ text: 'plain ', start: 0, end: 6 });
    expect(stamps[1]).toMatchObject({ text: 'added', start: 6, end: 11 });
    for (const s of stamps) expect(text.slice(s.start, s.end)).toBe(s.text);
  });

  it('escapes markup in the document so a file cannot inject into the page', () => {
    // A DOCX is a zip anyone can author. This is the boundary between a
    // document and script execution in the reader.
    const { html } = blocksToTextAndHtml([p('<img src=x onerror=alert(1)>')]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('marks the first block of a chapter without disturbing its range', () => {
    const { text, html } = blocksToTextAndHtml([
      p('Chapter one.'),
      { kind: 'p', runs: [{ text: 'Chapter two.' }], chapterStart: true },
    ]);
    expect(html).toContain('class="doc-chapter-start"');
    for (const s of stampedTexts(html)) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('emits headings and list items as their own elements', () => {
    const { html } = blocksToTextAndHtml([
      { kind: 'h1', runs: [{ text: 'Title' }] },
      { kind: 'h2', runs: [{ text: 'Section' }] },
      { kind: 'li', runs: [{ text: 'Item' }] },
    ]);
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('h1')?.textContent).toBe('Title');
    expect(host.querySelector('h2')?.textContent).toBe('Section');
    expect(host.querySelector('li')?.textContent).toBe('Item');
  });

  it('handles no blocks without pretending there is text', () => {
    expect(blocksToTextAndHtml([])).toEqual({ text: '', html: '' });
    expect(blocksToTextAndHtml([p(''), p('  ')])).toEqual({ text: '', html: '' });
  });
});

describe('parseOffsetAttr', () => {
  it('reads a well-formed range', () => {
    expect(parseOffsetAttr('6:11')).toEqual({ start: 6, end: 11 });
  });

  it('rejects junk rather than trusting a malformed stamp', () => {
    // A bad stamp must be dropped, not coerced into a range pointing at the
    // top of the document.
    expect(parseOffsetAttr(null)).toBeNull();
    expect(parseOffsetAttr('')).toBeNull();
    expect(parseOffsetAttr('abc')).toBeNull();
    expect(parseOffsetAttr('5')).toBeNull();
    expect(parseOffsetAttr('5:x')).toBeNull();
  });

  it('rejects an empty or inverted range', () => {
    expect(parseOffsetAttr('4:4')).toBeNull();
    expect(parseOffsetAttr('9:3')).toBeNull();
  });
});

describe('overlappingRanges', () => {
  const ranges = [
    { start: 0, end: 5 },
    { start: 6, end: 12 },
    { start: 14, end: 20 },
    { start: 22, end: 30 },
  ];

  it('finds a range fully inside a span', () => {
    expect(overlappingRanges(ranges, 6, 12)).toEqual([ranges[1]]);
  });

  it('finds ranges a span only partially covers', () => {
    expect(overlappingRanges(ranges, 4, 8)).toEqual([ranges[0], ranges[1]]);
  });

  it('returns nothing when the span falls in a gap', () => {
    expect(overlappingRanges(ranges, 13, 14)).toEqual([]);
  });

  it('returns nothing for an inverted or empty span', () => {
    expect(overlappingRanges(ranges, 5, 5)).toEqual([]);
    expect(overlappingRanges(ranges, 9, 3)).toEqual([]);
  });

  it('matches a linear scan across every non-empty offset pair', () => {
    // The binary search is only correct because the ranges are start-sorted,
    // which is an invariant of blocksToTextAndHtml. Rather than trusting that
    // silently, compare it against the obvious implementation everywhere.
    //
    // Empty spans are excluded because the two disagree there by design: a
    // range containing the point still satisfies the naive filter, but a
    // zero-width span covers no characters and must highlight nothing. That
    // case is pinned by its own test above.
    for (let start = 0; start <= 32; start++) {
      for (let end = start + 1; end <= 32; end++) {
        const naive = ranges.filter(r => r.end > start && r.start < end);
        expect(overlappingRanges(ranges, start, end)).toEqual(naive);
      }
    }
  });

  it('survives an empty list', () => {
    expect(overlappingRanges([], 0, 100)).toEqual([]);
  });
});

describe('escapeHtmlText', () => {
  it('escapes every character that could break out of text position', () => {
    expect(escapeHtmlText(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtmlText('Hello, world — 42% of “quotes”')).toBe(
      'Hello, world — 42% of “quotes”',
    );
  });
});
