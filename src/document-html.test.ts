import { describe, it, expect } from 'vitest';
import {
  blocksToTextAndHtml,
  blocksToTextHtmlAndSections,
  escapeHtmlText,
  overlappingRanges,
  parseOffsetAttr,
  alignGridRow,
  gridsToTextAndHtml,
  slidesToTextAndHtml,
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

describe('blocksToTextHtmlAndSections', () => {
  const h = (kind: 'h1' | 'h2' | 'h3', text: string): DocumentBlock => ({
    kind,
    runs: [{ text }],
  });

  it('starts a section at each heading, running to the next one', () => {
    const { text, sections } = blocksToTextHtmlAndSections([
      h('h1', 'First'),
      p('Body one.'),
      h('h2', 'Second'),
      p('Body two.'),
      h('h1', 'Third'),
      p('Body three.'),
    ]);
    expect(sections.map(s => s.title)).toEqual(['First', 'Second', 'Third']);
    for (const section of sections) {
      expect(text.slice(section.start, section.end)).toContain(section.title);
    }
    expect(sections[0].start).toBe(0);
    expect(sections[sections.length - 1].end).toBe(text.length);
  });

  it('does not split at a subheading when real headings are present', () => {
    // A chapter per subheading is not a chapter list; h1/h2 win when they exist.
    const { sections } = blocksToTextHtmlAndSections([
      h('h1', 'One'),
      p('Body.'),
      h('h2', 'Sub'),
      p('More body.'),
      h('h3', 'Deep'),
      p('Even more.'),
    ]);
    expect(sections.map(s => s.title)).toEqual(['One', 'Sub']);
  });

  it('falls back to the shallowest heading when there is no h1 or h2', () => {
    // Templates that style chapter titles as Heading 3 still have structure.
    const { sections } = blocksToTextHtmlAndSections([
      h('h3', 'One'),
      p('Body.'),
      h('h3', 'Two'),
      p('More body.'),
    ]);
    expect(sections.map(s => s.title)).toEqual(['One', 'Two']);
  });

  it('produces no sections for a document of plain paragraphs and list items', () => {
    const { sections } = blocksToTextHtmlAndSections([
      p('Just prose.'),
      { kind: 'li', runs: [{ text: 'A list item' }] },
    ]);
    expect(sections).toEqual([]);
  });

  it('leaves the text and markup untouched, so existing callers do not drift', () => {
    const blocks = [h('h1', 'A Heading'), p('Body text.')];
    const plain = blocksToTextAndHtml(blocks);
    const rich = blocksToTextHtmlAndSections(blocks);
    expect(rich.text).toBe(plain.text);
    expect(rich.html).toBe(plain.html);
  });
});

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

describe('spreadsheet and slide document views', () => {
  it('keeps sparse spreadsheet columns aligned and stamps exact ranges', () => {
    const row = alignGridRow([
      { ref: 'A1', text: 'Name' },
      { ref: 'C1', text: 'Score' },
    ]);
    expect(row).toEqual(['Name', '', 'Score']);
    const built = gridsToTextAndHtml([{ title: 'Sheet 1', rows: [row, ['Ada', '', '98']] }]);
    expect(built.text).toBe('Name\t\tScore\n\nAda\t\t98');
    expect(built.sections).toEqual([{ title: 'Sheet 1', start: 0, end: built.text.length }]);
    const stamps = stampedTexts(built.html);
    for (const stamp of stamps) expect(built.text.slice(stamp.start, stamp.end)).toBe(stamp.text);
    const dom = document.createElement('div');
    dom.innerHTML = built.html;
    expect(dom.querySelectorAll('th')).toHaveLength(3);
    expect(dom.querySelector('table caption')?.textContent).toBe('Sheet 1');
  });

  it('keeps custom spreadsheet delimiters aligned with stamps', () => {
    const built = gridsToTextAndHtml([{
      title: 'Sheet 1', rows: [['A', 'B'], ['C', 'D']], delimiter: ', ', rowSeparator: '\n',
    }]);
    expect(built.text).toBe('A, B\nC, D');
    for (const stamp of stampedTexts(built.html)) {
      expect(built.text.slice(stamp.start, stamp.end)).toBe(stamp.text);
    }
  });

  it('groups slide blocks into positioned shape containers', () => {
    const frame = { x: 5, y: 10, width: 90, height: 30 };
    const built = slidesToTextAndHtml([{ blocks: [
      { kind: 'h2', runs: [{ text: 'Title' }], frame },
      { kind: 'p', runs: [{ text: 'Body' }], frame, separatorBefore: ' ', align: 'center' },
      { kind: 'p', runs: [{ text: 'Footer' }], separatorBefore: ' ' },
    ], aspect: 1.7778 }]);
    const dom = document.createElement('div');
    dom.innerHTML = built.html;
    const shapes = dom.querySelectorAll('.dochtml__slide-shape');
    // Two blocks share one frame: one container, holding both.
    expect(shapes).toHaveLength(1);
    expect(shapes[0].children).toHaveLength(2);
    expect(shapes[0].getAttribute('style')).toContain('left:5.000%');
    expect(dom.querySelector('.dochtml__slide')?.getAttribute('style')).toContain('aspect-ratio:1.7778');
    expect(dom.querySelector('[style*="text-align:center"]')?.textContent).toBe('Body');
    for (const stamp of stampedTexts(built.html)) {
      expect(built.text.slice(stamp.start, stamp.end)).toBe(stamp.text);
    }
  });

  it('renders slides with continuous offsets and named navigation ranges', () => {
    const built = slidesToTextAndHtml([
      { blocks: [{ kind: 'h2', runs: [{ text: 'First slide' }] }, p('Opening') ] },
      { blocks: [{ kind: 'h2', runs: [{ text: 'Second slide' }] }, p('Closing') ] },
    ]);
    expect(built.sections).toEqual([
      { title: 'Slide 1', start: 0, end: 'First slide\n\nOpening'.length },
      { title: 'Slide 2', start: 'First slide\n\nOpening'.length + 2,
        end: 'First slide\n\nOpening'.length + 2 + 'Second slide\n\nClosing'.length },
    ]);
    for (const stamp of stampedTexts(built.html)) {
      expect(built.text.slice(stamp.start, stamp.end)).toBe(stamp.text);
    }
    const slideDom = document.createElement('div');
    slideDom.innerHTML = built.html;
    expect(slideDom.querySelectorAll('.dochtml__slide')).toHaveLength(2);
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
