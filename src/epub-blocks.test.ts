/**
 * EPUB chapter blocks.
 *
 * These exist because EPUB extraction returned *nothing at all* and nothing
 * caught it. epubjs's `Section.load` resolves `xml.documentElement` — the
 * `<html>` **element**, not the Document it came from — and the extraction code
 * asked that element for `.body`, which is a Document property. `undefined` it
 * is, `?? ''` swallowed it, and every EPUB imported as a blank document with no
 * error anywhere to explain why.
 *
 * The fixture below is built to have exactly that shape, and the first test
 * asserts it still does. If a future change makes the fixture a Document
 * again, that assertion fails — which is the point: otherwise these tests keep
 * passing while quietly no longer covering the case they were written for.
 */
import { describe, it, expect } from 'vitest';
import { epubBlocks } from './document-reader';
import { blocksToTextAndHtml } from './document-html';

const CHAPTER = `<!DOCTYPE html>
<html>
  <head><title>A Title That Is Not Part Of The Book</title></head>
  <body>
    <h1>Chapter One</h1>
    <p>The reader should show this as a paragraph.</p>
    <ul><li>Bullet one.</li><li>Bullet two.</li></ul>
  </body>
</html>`;

/**
 * An `<html>` element detached from its Document — the shape epubjs hands back.
 * `body` lives on Document, so this element deliberately does not have one.
 */
function htmlElement(html = CHAPTER): Element {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = html;
  return doc.documentElement;
}

function documentOf(html = CHAPTER): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('epubBlocks', () => {
  it('reads an <html> element that has no .body, which is what epubjs returns', () => {
    const el = htmlElement();
    // The trap, asserted rather than assumed.
    expect((el as unknown as { body?: unknown }).body).toBeUndefined();

    const blocks = epubBlocks(el);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map(b => b.kind)).toEqual(['h1', 'p', 'li', 'li']);
    expect(blocks[0].runs[0].text).toBe('Chapter One');
  });

  it('produces the same blocks from an element and from its Document', () => {
    // Both shapes are real in the wild, so they must not disagree — this is
    // what makes the element path safe to prefer rather than a special case
    // bolted on beside the working one.
    expect(epubBlocks(htmlElement())).toEqual(epubBlocks(documentOf()));
  });

  it('accepts raw markup, for entries epubjs resolves as text', () => {
    expect(epubBlocks(CHAPTER).map(b => b.kind)).toEqual(['h1', 'p', 'li', 'li']);
  });

  it('does not leak the chapter title into the book text', () => {
    const { text } = blocksToTextAndHtml(epubBlocks(htmlElement()));
    expect(text).not.toContain('A Title That Is Not Part Of The Book');
    expect(text.startsWith('Chapter One')).toBe(true);
  });

  it('falls back to one paragraph when a chapter uses no block elements', () => {
    // A chapter can be a bare <div> of prose. Dropping it would silently
    // shorten the book, so the text is kept even though nothing matched.
    const blocks = epubBlocks(htmlElement('<html><body><div>Just prose here.</div></body></html>'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('p');
    expect(blocks[0].runs[0].text).toBe('Just prose here.');
  });

  it('returns nothing for an empty chapter rather than an empty paragraph', () => {
    expect(epubBlocks(htmlElement('<html><body></body></html>'))).toEqual([]);
  });

  it('stamps ranges that still address the text they were built from', () => {
    // The invariant the reader's highlight depends on, checked across the
    // EPUB path specifically so a block-shape change cannot quietly shift
    // every offset in the chapter.
    const { text, html } = blocksToTextAndHtml(epubBlocks(htmlElement()));
    const host = document.createElement('div');
    host.innerHTML = html;
    const stamped = Array.from(host.querySelectorAll<HTMLElement>('[data-off]'));

    expect(stamped.length).toBeGreaterThan(0);
    for (const el of stamped) {
      const [start, end] = (el.dataset.off ?? '').split(':').map(Number);
      expect(text.slice(start, end)).toBe(el.textContent);
    }
  });
});
