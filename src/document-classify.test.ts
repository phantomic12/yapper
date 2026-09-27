import { describe, it, expect } from 'vitest';
import {
  classifyBlockText,
  classifyText,
  classifyLayoutBlocks,
  countKinds,
  parseTableRows,
  renderBlockHtml,
  MAX_TABLE_ROWS,
  MAX_TABLE_COLS,
} from './document-classify';

describe('classifyBlockText', () => {
  it('detects headings', () => {
    expect(classifyBlockText('Introduction')).toBe('heading');
    expect(classifyBlockText('CHAPTER ONE')).toBe('heading');
    expect(classifyBlockText('Results and Discussion:')).toBe('heading');
    expect(classifyBlockText('# Markdown Title')).toBe('heading');
  });

  it('detects lists', () => {
    expect(classifyBlockText('- first item\n- second item')).toBe('list');
    expect(classifyBlockText('1. numbered\n2. items')).toBe('list');
    expect(classifyBlockText('• bullet')).toBe('list');
  });

  it('detects quotes', () => {
    expect(classifyBlockText('> quoted wisdom')).toBe('quote');
    expect(classifyBlockText('“Famous last words.”')).toBe('quote');
  });

  it('detects tables', () => {
    expect(classifyBlockText('Name    Age\nAlice   30\nBob     25')).toBe('table');
    expect(classifyBlockText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('table');
  });

  it('detects code', () => {
    expect(classifyBlockText('```js\nconst x = 1;\n```')).toBe('code');
    expect(classifyBlockText('function f() {\n    return 1;\n}')).toBe('code');
  });

  it('treats normal prose as paragraphs', () => {
    expect(classifyBlockText('This is a normal sentence with punctuation.')).toBe('paragraph');
    expect(classifyBlockText('A second sentence that continues for a while and explains things.')).toBe('paragraph');
  });
});

describe('classifyText', () => {
  it('splits on blank lines and classifies each block', () => {
    const blocks = classifyText('Chapter One\n\nFirst paragraph here.\n\n- a\n- b');
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'paragraph', 'list']);
  });

  it('ignores extra blank lines', () => {
    const blocks = classifyText('\n\n\nHello\n\n\n');
    expect(blocks).toHaveLength(1);
  });
});

describe('classifyLayoutBlocks', () => {
  it('promotes narrow short blocks on a wide page to headings', () => {
    const blocks = classifyLayoutBlocks([
      { page: 1, text: 'Annual Report', x: 10, y: 20, width: 200, height: 30 },
      { page: 1, text: 'The company performed well this year, with growth across all segments.', x: 10, y: 100, width: 900, height: 60 },
    ]);
    expect(blocks[0].kind).toBe('heading');
    expect(blocks[1].kind).toBe('paragraph');
    expect(blocks[0].page).toBe(1);
  });
});

describe('countKinds', () => {
  it('counts each kind', () => {
    const counts = countKinds([
      { kind: 'heading', text: 'a' },
      { kind: 'heading', text: 'b' },
      { kind: 'paragraph', text: 'c' },
    ]);
    expect(counts.heading).toBe(2);
    expect(counts.paragraph).toBe(1);
    expect(counts.list).toBe(0);
  });
});

describe('parseTableRows', () => {
  it('splits pipe-delimited rows and drops the header rule', () => {
    const rows = parseTableRows('| Name | Size |\n| --- | --- |\n| a | 1 |');
    expect(rows).toEqual([['Name', 'Size'], ['a', '1']]);
  });

  it('handles rows without leading/trailing pipes', () => {
    expect(parseTableRows('Name | Size\n---|---\na | 1'))
      .toEqual([['Name', 'Size'], ['a', '1']]);
  });

  it('splits on runs of two or more spaces (extraction output)', () => {
    expect(parseTableRows('Name    Size\na       1'))
      .toEqual([['Name', 'Size'], ['a', '1']]);
  });

  it('pads ragged rows to the widest row so columns line up', () => {
    const rows = parseTableRows('| a | b | c |\n| 1 |');
    expect(rows[1]).toEqual(['1', '', '']);
  });

  it('returns nothing for a single column — that is a paragraph', () => {
    // The classifier calls any two aligned lines a table; rendering one
    // column as a table would be worse than plain text.
    expect(parseTableRows('just one line')).toEqual([]);
    expect(parseTableRows('alpha\nbeta')).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    expect(parseTableRows('')).toEqual([]);
    expect(parseTableRows('   \n  ')).toEqual([]);
  });

  it('caps the column count', () => {
    const wide = `| ${Array.from({ length: 20 }, (_, i) => `c${i}`).join(' | ')} |`;
    const rows = parseTableRows(`${wide}\n${wide}`);
    expect(rows[0]).toHaveLength(MAX_TABLE_COLS);
  });
});

describe('renderBlockHtml', () => {
  it('renders a table with a header row and scoped headers', () => {
    const html = renderBlockHtml('table', '| Name | Size |\n| --- | --- |\n| a | 1 |');
    expect(html).toContain('<table class="classify-table">');
    expect(html).toContain('<th scope="col">Name</th>');
    expect(html).toContain('<td>a</td>');
  });

  it('falls back to a paragraph when a "table" has one column', () => {
    const html = renderBlockHtml('table', 'alpha\nbeta');
    expect(html).not.toContain('<table');
    expect(html).toContain('<p');
  });

  it('says how many table rows it hid', () => {
    const many = ['| n | v |', ...Array.from({ length: 60 }, (_, i) => `| ${i} | x |`)].join('\n');
    const html = renderBlockHtml('table', many);
    expect(html).toContain('more rows not shown');
    expect((html.match(/<tr>/g) ?? []).length).toBeLessThanOrEqual(MAX_TABLE_ROWS + 1);
  });

  it('renders code in a pre and strips the markdown fence', () => {
    const html = renderBlockHtml('code', '```js\nconst a = 1;\n```');
    expect(html).toContain('<pre class="classify-code"><code>');
    expect(html).toContain('const a = 1;');
    expect(html).not.toContain('```');
  });

  it('preserves code indentation', () => {
    const html = renderBlockHtml('code', 'function f() {\n    return 1;\n}');
    expect(html).toContain('    return 1;');
  });

  it('renders a list as items without the bullet markers', () => {
    const html = renderBlockHtml('list', '- first\n- second\n3. third');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
    expect(html).toContain('<li>third</li>');
  });

  it('renders a quote as a blockquote and a heading as a heading', () => {
    expect(renderBlockHtml('quote', '> hello')).toContain('<blockquote');
    const h = renderBlockHtml('heading', '## Install');
    expect(h).toContain('<h4 class="classify-heading">Install</h4>');
  });

  it('strips the ">" markers instead of showing them as content', () => {
    // Same reasoning as the list branch dropping bullets: the blockquote
    // already means "this was quoted", so the source marker is noise.
    expect(renderBlockHtml('quote', '> hello')).toContain('>hello<');
    expect(renderBlockHtml('quote', '> hello')).not.toContain('&gt;');
    // A wrapped quote repeats the marker on every line; all of them go.
    const wrapped = renderBlockHtml('quote', '> one line\n> and the next');
    expect(wrapped).toBe('<blockquote class="classify-quote">one line\nand the next</blockquote>');
    // Text that only looks quoted keeps its own punctuation.
    expect(renderBlockHtml('quote', '"Famous last words."')).toContain('&quot;Famous last words.&quot;');
  });

  it('escapes document text in every kind', () => {
    // The one rule for this module: block text is never interpolated raw.
    const nasty = '<img src=x onerror="alert(1)">';
    for (const kind of ['paragraph', 'heading', 'quote', 'list', 'code', 'table'] as const) {
      const html = renderBlockHtml(kind, nasty);
      expect(html, kind).not.toContain('<img');
      expect(html, kind).toContain('&lt;img');
    }
  });

  it('escapes ampersands and quotes without mangling them', () => {
    const html = renderBlockHtml('paragraph', `Tom & "Jerry" <b>`);
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('truncates long text and marks it with an ellipsis', () => {
    const html = renderBlockHtml('paragraph', 'x'.repeat(500), { maxChars: 10 });
    expect(html).toContain('…');
    expect(html).not.toContain('x'.repeat(11));
  });

  it('leaves text under the cap untouched', () => {
    const html = renderBlockHtml('paragraph', 'short', { maxChars: 240 });
    expect(html).toBe('<p class="classify-paragraph">short</p>');
  });
});
