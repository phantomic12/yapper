import { describe, it, expect } from 'vitest';
import { SAMPLE_DOCUMENT } from './sample-document';
import { classifyText, renderBlockHtml, countKinds } from './document-classify';

describe('SAMPLE_DOCUMENT', () => {
  const blocks = classifyText(SAMPLE_DOCUMENT.text);
  const counts = countKinds(blocks);

  it('is labelled as a document, not a file', () => {
    expect(SAMPLE_DOCUMENT.name).toBe('Sample document');
    expect(SAMPLE_DOCUMENT.mimeType).toBe('text/markdown');
    expect(SAMPLE_DOCUMENT.text.length).toBeGreaterThan(200);
  });

  it('demonstrates every block kind the reader can render', () => {
    // The point of the sample is to show the structure renderer working, so
    // losing a kind here is a real regression, not a cosmetic one. countKinds
    // reports every kind (zeroes included), hence the filter.
    const present = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([kind]) => kind)
      .sort();
    expect(present).toEqual(['heading', 'list', 'paragraph', 'quote', 'table']);
  });

  it('classifies its title and section names as headings', () => {
    const headings = blocks.filter(b => b.kind === 'heading').map(b => b.text);
    expect(headings.some(h => h.includes('Local text-to-speech'))).toBe(true);
    expect(headings.some(h => h.includes('What the reader handles'))).toBe(true);
  });

  it('keeps the table recognisable so it renders as a grid', () => {
    const table = blocks.find(b => b.kind === 'table')!;
    expect(table).toBeDefined();
    const html = renderBlockHtml('table', table.text);
    expect(html).toContain('<table');
    expect(html).toContain('Needs OCR');
  });

  it('renders one list item per bullet, with no stray markers', () => {
    // A hard-wrapped bullet would turn its continuation line into a second
    // <li>, so the sample keeps one bullet per line and the renderer is
    // checked to agree.
    const list = blocks.find(b => b.kind === 'list')!;
    const html = renderBlockHtml('list', list.text);
    expect(html.match(/<li>/g)).toHaveLength(list.text.split('\n').filter(l => l.trim()).length);
    expect(html).not.toMatch(/<li>-\s/);
  });

  it('renders the quote as a quote, not as a line of ">" characters', () => {
    const quote = blocks.find(b => b.kind === 'quote')!;
    const html = renderBlockHtml('quote', quote.text);
    expect(html).toContain('<blockquote');
    expect(html).not.toContain('&gt;');
  });

  it('renders every block to non-empty markup', () => {
    for (const block of blocks) {
      expect(renderBlockHtml(block.kind, block.text, { maxChars: 240 }).length).toBeGreaterThan(0);
    }
  });

  it('is short enough to read aloud as a demo', () => {
    // Roughly 40 seconds of speech; longer and nobody clicks through it.
    expect(SAMPLE_DOCUMENT.text.length).toBeLessThan(2500);
  });
});
