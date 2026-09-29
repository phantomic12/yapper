/**
 * Extraction-level tests for the worker-safe formats.
 *
 * These close the gap the unit tests around `document-html` cannot cover:
 * the markup/text contract is proven there for synthetic blocks, but nothing
 * proved that real XLSX/PPTX zip structures (shared strings, sparse rows,
 * relationship-joined sheet names, DrawingML shape geometry) survive the
 * parsers and still honour that contract. Fixtures are built in-test with
 * JSZip so each case shows exactly the XML it is asserting about.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractFormat,
  odtToBlocks,
  xlsxSheetTitles,
  pptxSlideSize,
  pptxSlideBlocks,
} from './document-formats';

/** Parse generated markup and read back what each stamp claims to cover. */
function stampedTexts(html: string): { text: string; start: number; end: number }[] {
  const host = document.createElement('div');
  host.innerHTML = html;
  return Array.from(host.querySelectorAll<HTMLElement>('[data-off]')).map(el => {
    const [start, end] = (el.dataset.off ?? '').split(':').map(Number);
    return { text: el.textContent ?? '', start, end };
  });
}

async function zipFile(name: string, files: Record<string, string>): Promise<File> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return new File([bytes], name);
}

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Revenue 2026" sheetId="1" r:id="rId1"/>
    <sheet name="Scratch" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

describe('xlsxSheetTitles', () => {
  it('joins workbook sheet names to worksheet parts through relationships', () => {
    expect(xlsxSheetTitles(WORKBOOK_XML, WORKBOOK_RELS_XML)).toEqual({
      'xl/worksheets/sheet1.xml': 'Revenue 2026',
      'xl/worksheets/sheet2.xml': 'Scratch',
    });
  });

  it('ignores non-worksheet relationships and unknown r:id values', () => {
    const workbook = `<?xml version="1.0"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Orphan" sheetId="1" r:id="rId99"/>
          <sheet name="Named" sheetId="2" r:id="rId1"/>
          <sheet name="" sheetId="3" r:id="rId2"/>
        </sheets>
      </workbook>`;
    const rels = `<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet7.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet8.xml"/>
      </Relationships>`;
    expect(xlsxSheetTitles(workbook, rels)).toEqual({
      'xl/worksheets/sheet7.xml': 'Named',
    });
  });

  it('returns nothing rather than throwing when the workbook is missing', () => {
    expect(xlsxSheetTitles('not xml at all <<', undefined)).toEqual({});
  });
});

describe('XLSX extraction', () => {
  it('extracts sparse sheets with workbook names and exact stamped ranges', async () => {
    const file = await zipFile('books.xlsx', {
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/_rels/workbook.xml.rels': WORKBOOK_RELS_XML,
      'xl/sharedStrings.xml': `<?xml version="1.0"?>
        <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <si><t>Name</t></si><si><t>Score</t></si><si><t>Ada</t></si>
        </sst>`,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetData>
            <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>98</v></c></row>
          </sheetData>
        </worksheet>`,
      'xl/worksheets/sheet2.xml': `<?xml version="1.0"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetData>
            <row r="1"><c r="A1" t="inlineStr"><is><t>Only</t></is></c></row>
          </sheetData>
        </worksheet>`,
    });

    const doc = await extractFormat('xlsx', file);
    expect(doc.text).toBe('Name, , Score\nAda, , 98\n\nOnly');
    expect(doc.sections).toEqual([
      { title: 'Revenue 2026', start: 0, end: 'Name, , Score\nAda, , 98'.length },
      { title: 'Scratch', start: 'Name, , Score\nAda, , 98'.length + 2, end: doc.text.length },
    ]);
    for (const stamp of stampedTexts(doc.html ?? '')) {
      expect(doc.text.slice(stamp.start, stamp.end)).toBe(stamp.text);
    }
    const dom = document.createElement('div');
    dom.innerHTML = doc.html ?? '';
    expect(Array.from(dom.querySelectorAll('table caption')).map(c => c.textContent))
      .toEqual(['Revenue 2026', 'Scratch']);
  });
});

const PRESENTATION_XML = `<?xml version="1.0"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="914400" cy="685800"/>
</p:presentation>`;

const SLIDE_XML = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="100000"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="91440" y="100000"/><a:ext cx="731520" cy="585800"/></a:xfrm></p:spPr>
      <p:txBody>
        <a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t> world</a:t></a:r></a:p>
        <a:p><a:pPr algn="ctr"/><a:r><a:t>Second line</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

describe('PPTX slide geometry', () => {
  it('reads the declared slide size', () => {
    expect(pptxSlideSize(PRESENTATION_XML)).toEqual({ cx: 914400, cy: 685800 });
    expect(pptxSlideSize('<presentation><sldSz cx="0" cy="9"/></presentation>')).toBeNull();
  });

  it('keeps the spoken text contract while attaching shape frames', () => {
    const { blocks, aspect } = pptxSlideBlocks(SLIDE_XML, pptxSlideSize(PRESENTATION_XML));
    expect(blocks.map(block => block.runs.map(run => run.text).join('')))
      .toEqual(['Quarterly Review', 'Hello world', 'Second line']);
    // Legacy flattening: runs join with spaces inside a paragraph, and
    // paragraphs join with spaces across the slide.
    expect(blocks.slice(1).every(block => block.separatorBefore === ' ')).toBe(true);
    expect(blocks[0].kind).toBe('h2');
    expect(blocks[0].frame).toEqual({ x: 0, y: 0, width: 100, height: 100000 / 685800 * 100 });
    expect(blocks[1].frame).toEqual({ x: 10, y: 100000 / 685800 * 100, width: 80, height: 585800 / 685800 * 100 });
    expect(blocks[2].align).toBe('center');
    expect(blocks[1].align).toBeUndefined();
    expect(aspect).toBeCloseTo(914400 / 685800);
  });

  it('heads slides without a title placeholder and drops frames when no size is known', () => {
    const bare = `<?xml version="1.0"?>
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:spTree><p:sp>
          <p:nvSpPr><p:cNvPr id="1" name="A"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm></p:spPr>
          <p:txBody><a:p><a:r><a:t>First</a:t></a:r></a:p><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:txBody>
        </p:sp></p:spTree></p:cSld>
      </p:sld>`;
    const withSize = pptxSlideBlocks(bare, { cx: 100, cy: 100 });
    expect(withSize.blocks.map(block => block.kind)).toEqual(['h2', 'p']);
    expect(withSize.blocks[0].frame).toEqual({ x: 10, y: 20, width: 30, height: 40 });

    const withoutSize = pptxSlideBlocks(bare, null);
    expect(withoutSize.blocks.every(block => !block.frame)).toBe(true);
    expect(withoutSize.aspect).toBeUndefined();
  });
});

describe('PPTX extraction', () => {
  it('produces named slide sections with continuous stamped offsets', async () => {
    const file = await zipFile('deck.pptx', {
      'ppt/presentation.xml': PRESENTATION_XML,
      'ppt/slides/slide1.xml': SLIDE_XML,
      'ppt/slides/slide2.xml': `<?xml version="1.0"?>
        <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
               xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:cSld><p:spTree><p:sp>
            <p:nvSpPr><p:cNvPr id="1" name="A"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="342900"/></a:xfrm></p:spPr>
            <p:txBody><a:p><a:r><a:t>Closing</a:t></a:r></a:p></p:txBody>
          </p:sp></p:spTree></p:cSld>
        </p:sld>`,
    });

    const doc = await extractFormat('pptx', file);
    expect(doc.text).toBe('Quarterly Review Hello world Second line\n\nClosing');
    expect(doc.sections).toEqual([
      { title: 'Slide 1', start: 0, end: 'Quarterly Review Hello world Second line'.length },
      {
        title: 'Slide 2',
        start: 'Quarterly Review Hello world Second line'.length + 2,
        end: doc.text.length,
      },
    ]);
    for (const stamp of stampedTexts(doc.html ?? '')) {
      expect(doc.text.slice(stamp.start, stamp.end)).toBe(stamp.text);
    }
    const dom = document.createElement('div');
    dom.innerHTML = doc.html ?? '';
    expect(dom.querySelectorAll('.dochtml__slide')).toHaveLength(2);
    // Both shapes on slide 1 keep their proportional placement.
    expect(dom.querySelectorAll('.dochtml__slide-shape')).toHaveLength(3);
  });
});

describe('plain-text extraction', () => {
  it('reads text files through the same dispatch the worker uses', async () => {
    const file = new File(['Hello from a note.'], 'note.txt');
    const doc = await extractFormat('text', file);
    expect(doc.text).toBe('Hello from a note.');
    // A single unstructured note has no structure to find.
    expect(doc.sections).toBeUndefined();
  });

  it('infers sections from Markdown headings so .md files get chapters', async () => {
    const file = new File(
      ['# Opening\n\nThe body of the opening.\n\n## Closing\n\nThe body of the close.\n'],
      'notes.md',
    );
    const doc = await extractFormat('text', file);
    expect(doc.sections).toEqual([
      { title: 'Opening', start: 0, end: doc.text.indexOf('## Closing') },
      { title: 'Closing', start: doc.text.indexOf('## Closing'), end: doc.text.length },
    ]);
  });
});

describe('RTF extraction', () => {
  const rtf = (body: string): File => new File([body], 'doc.rtf');

  it('reads headings from the document stylesheet when it declares one', async () => {
    // `\s1` mapped to "heading 1" is a declaration, not an inference, so it
    // outranks anything the formatting alone would suggest.
    const doc = await extractFormat('rtf', rtf(String.raw`{\rtf1\ansi\deff0
{\fonttbl{\f0 Times;}}
{\stylesheet{\s0\fs24 Normal;}{\s1\fs32\outlinelevel0 heading 1;}{\s2\fs28\outlinelevel1 heading 2;}}
\pard\s1 A Study in Scarlet\par
\pard\s1 Chapter One\par
\pard\s2 The Sign of the Four\par
\pard\s0 In the year eighteen seventy-eight I took my degree.\par
\pard\s2 The Science of Deduction\par
\pard\s0 I was rapidly losing the habit of sleeping.\par
}`));
    expect(doc.sections?.map(s => s.title)).toEqual([
      'A Study in Scarlet', 'Chapter One', 'The Sign of the Four', 'The Science of Deduction',
    ]);
  });

  it('never speaks the stylesheet, font table, or colour table as prose', async () => {
    // Those groups hold style names, not content. Reading them out is how
    // "Times;Normal;heading 1;" ends up in the middle of the narration.
    const doc = await extractFormat('rtf', rtf(String.raw`{\rtf1\ansi\deff0
{\fonttbl{\f0 Times New Roman;}}
{\colortbl ;\red0\green0\blue0;}
{\stylesheet{\s0\fs24 Normal;}{\s1\fs32 heading 1;}}
\pard\s1 Chapter One\par
\pard\s0 Body text of the chapter.\par
}`));
    expect(doc.text).toBe('Chapter One\n\nBody text of the chapter.');
  });

  it('falls back to font size when the file has no stylesheet', async () => {
    const doc = await extractFormat('rtf', rtf(String.raw`{\rtf1\ansi{\fonttbl{\f0 Times;}}\fs24
\b\fs36 The Big Title\b0\fs24\par
\fs24 Some ordinary body text that goes on for a while here.\par
\b\fs28 A Section Heading\b0\fs24\par
\fs24 More ordinary body text, also long enough to be a sentence.\par
}`));
    expect(doc.sections?.map(s => s.title)).toEqual(['The Big Title', 'A Section Heading']);
  });

  it('does not call bold body text a heading when no font is enlarged', async () => {
    // Bold is how emphasis is written; without a size to set it apart from,
    // a bold sentence is a sentence.
    const doc = await extractFormat('rtf', rtf(String.raw`{\rtf1\fs24
\b Bold but not a heading, and long enough to be a sentence.\b0\par
\fs24 Plain body text, also long enough to be a sentence.\par
\fs24 Another plain body line, long enough to be a sentence too.\par
}`));
    expect(doc.sections).toBeUndefined();
    expect(doc.text).toContain('Bold but not a heading');
  });

  it('sees a bold heading whose letters are written as escapes', async () => {
    // Escaped characters have to count toward the paragraph's bold verdict,
    // or a heading written with \\u escapes looks unbold and is missed.
    const doc = await extractFormat('rtf', rtf(String.raw`{\rtf1\fs24
\b\fs32 Fi\u114 st Heading\b0\fs24\par
\fs24 Some ordinary body text that goes on for a while here.\par
\b\fs28 Secon\u100  Heading\b0\fs24\par
\fs24 More ordinary body text, also long enough to be a sentence.\par
}`));
    // The space after \uN is RTF's delimiter, not content: "Fi\u72 st" is
    // "First", not "Fi r st".
    expect(doc.sections?.map(s => s.title)).toEqual(['First Heading', 'Second Heading']);
  });

  it('rejects a file with no readable text', async () => {
    await expect(extractFormat('rtf', rtf('{\\rtf1}'))).rejects.toThrow(/empty or corrupted/);
  });
});

describe('ODT extraction', () => {
  const odt = async (body: string): Promise<File> => {
    const content = `<?xml version="1.0"?>
      <office:document-content
        xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
        xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
        <office:body><office:text>${body}</office:text></office:body>
      </office:document-content>`;
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('content.xml', content);
    return new File([await zip.generateAsync({ type: 'uint8array' })], 'book.odt');
  };

  it('keeps headings, which were previously dropped from the text entirely', async () => {
    // ODT headings are `text:h`, not `text:p`. The old extractor queried only
    // `text:p`, so this heading did not merely lack a chapter — it was missing
    // from the document altogether.
    const doc = await extractFormat('odt', await odt(
      '<text:h text:outline-level="1">A Study in Scarlet</text:h>'
      + '<text:p>In the year eighteen seventy-eight I took my degree.</text:p>'
      + '<text:h text:outline-level="2">The Sign of the Four</text:h>'
      + '<text:p>I was rapidly losing the habit of sleeping.</text:p>',
    ));
    expect(doc.text).toBe('A Study in Scarlet\n\nIn the year eighteen seventy-eight I took my degree.'
      + '\n\nThe Sign of the Four\n\nI was rapidly losing the habit of sleeping.');
    expect(doc.sections?.map(s => s.title)).toEqual(['A Study in Scarlet', 'The Sign of the Four']);
  });

  it('keeps list items, which nest their own text elements', async () => {
    const doc = await extractFormat('odt', await odt(
      '<text:h text:outline-level="1">Shopping</text:h>'
      + '<text:list><text:list-item><text:p>Milk</text:p></text:list-item>'
      + '<text:list-item><text:p>Bread</text:p></text:list-item></text:list>',
    ));
    expect(doc.text).toBe('Shopping\n\nMilk\n\nBread');
  });

  it('uses only the top two heading levels, matching the other formats', async () => {
    const doc = await extractFormat('odt', await odt(
      '<text:h text:outline-level="1">Part One</text:h><text:p>Opening.</text:p>'
      + '<text:h text:outline-level="2">Chapter A</text:h><text:p>Body A.</text:p>'
      + '<text:h text:outline-level="3">A subheading</text:h><text:p>Sub body.</text:p>'
      + '<text:h text:outline-level="3">Another subheading</text:h><text:p>Sub body two.</text:p>',
    ));
    // A chapter per subheading is not a chapter list.
    expect(doc.sections?.map(s => s.title)).toEqual(['Part One', 'Chapter A']);
    // The deeper headings are still part of the document.
    expect(doc.text).toContain('A subheading');
  });

  it('rejects a file with no readable text', async () => {
    await expect(extractFormat('odt', await odt(''))).rejects.toThrow(/empty/);
  });
});

describe('CSV extraction', () => {
  const csv = (text: string): File => new File([text], 'data.csv');

  it('chapters a sorted table by the column it groups on', async () => {
    const doc = await extractFormat('csv', csv(
      'Region,Sales\nNorth,10\nNorth,20\nSouth,30\nSouth,40\nEast,50',
    ));
    expect(doc.sections?.map(s => s.title)).toEqual(['North', 'South', 'East']);
    for (const section of doc.sections ?? []) {
      expect(doc.text.slice(section.start, section.end)).toContain(section.title);
    }
  });

  it('groups on whichever column carries the structure, not just the first', async () => {
    const doc = await extractFormat('csv', csv(
      'Order,Status\n1,Open\n2,Open\n3,Closed\n4,Closed',
    ));
    expect(doc.sections?.map(s => s.title)).toEqual(['Open', 'Closed']);
  });

  it('gives an unsorted table no chapters rather than invented ones', async () => {
    // The values repeat but interleave, so the column is not a grouping and
    // the rows have no order a listener could navigate by.
    const doc = await extractFormat('csv', csv(
      'Region,Sales\nNorth,10\nSouth,20\nNorth,30\nSouth,40',
    ));
    expect(doc.sections).toBeUndefined();
  });

  it('gives a table with no repeated values no chapters', async () => {
    const doc = await extractFormat('csv', csv('Name,Sales\nalpha,10\nbeta,20\ngamma,30'));
    expect(doc.sections).toBeUndefined();
  });

  it('keeps the existing row text exactly as it was', async () => {
    const doc = await extractFormat('csv', csv('a,b\n1,2\n3,4'));
    expect(doc.text).toBe('a, b\n1, 2\n3, 4');
  });
});

describe('HTML extraction', () => {
  const page = (body: string): File => new File(
    [`<!DOCTYPE html><html><head><title>T</title></head><body>${body}</body></html>`],
    'page.html',
  );

  it('keeps headings as sections instead of flattening the page to text', async () => {
    // The previous extractor read body.textContent, which discarded every
    // heading and left HTML documents with no chapter track at all.
    const doc = await extractFormat('html', page(
      '<h1>The Title</h1><p>Opening body.</p><h2>First Section</h2><p>First body.</p>',
    ));
    expect(doc.sections?.map(s => s.title)).toEqual(['The Title', 'First Section']);
    for (const section of doc.sections ?? []) {
      expect(doc.text.slice(section.start, section.end)).toContain(section.title);
    }
  });

  it('separates blocks with a blank line so sentences do not run together', async () => {
    const doc = await extractFormat('html', page('<p>One.</p><p>Two.</p><p>Three.</p>'));
    expect(doc.text).toBe('One.\n\nTwo.\n\nThree.');
  });

  it('separates text that lives in divs, which carry no block tag of their own', async () => {
    // Real pages wrap content in divs constantly. Treating them as opaque
    // produced "First div.Second div." with the sentences glued together.
    const doc = await extractFormat('html', page('<div>First div.</div><div>Second div.</div>'));
    expect(doc.text).toBe('First div.\n\nSecond div.');
  });

  it('reads through wrappers to find the real blocks', async () => {
    const doc = await extractFormat('html', page(
      '<div><div><section><h2>Deep Heading</h2><p>Deep body.</p></section></div></div>',
    ));
    expect(doc.sections?.map(s => s.title)).toEqual(['Deep Heading']);
    expect(doc.text).toBe('Deep Heading\n\nDeep body.');
  });

  it('keeps the text of a block wrapped in another block', async () => {
    // A blockquote containing a paragraph is quoted *by* the paragraph; if both
    // were skipped as duplicates the quote would vanish from the document.
    const doc = await extractFormat('html', page(
      '<blockquote><p>Quoted paragraph.</p></blockquote><div><p>Plain paragraph.</p></div>',
    ));
    expect(doc.text).toBe('Quoted paragraph.\n\nPlain paragraph.');
  });

  it('speaks a table row as one phrase rather than a column of cells', async () => {
    const doc = await extractFormat('html', page(
      '<h1>Data</h1><table><tr><th>Name</th><th>Value</th></tr>'
      + '<tr><td>alpha</td><td>1</td></tr></table>',
    ));
    expect(doc.text).toBe('Data\n\nName, Value\n\nalpha, 1');
  });

  it('never reads script, style, or head content as prose', async () => {
    const doc = await extractFormat('html', page(
      '<h1>Real Heading</h1><script>var secret = "do not read";</script>'
      + '<style>h1 { color: red; }</style><p>Real body.</p>',
    ));
    expect(doc.text).toBe('Real Heading\n\nReal body.');
  });

  it('preserves bold and italic runs as real formatting', async () => {
    const doc = await extractFormat('html', page(
      '<p>Plain <strong>bold</strong> and <em>italic</em> text.</p>',
    ));
    const dom = document.createElement('div');
    dom.innerHTML = doc.html ?? '';
    expect(dom.querySelector('strong')?.textContent).toBe('bold');
    expect(dom.querySelector('em')?.textContent).toBe('italic');
    for (const stamp of stampedTexts(doc.html ?? '')) {
      expect(doc.text.slice(stamp.start, stamp.end)).toBe(stamp.text);
    }
  });

  it('falls back to flattened text for a page with no block elements', async () => {
    const doc = await extractFormat('html', page('Loose text with no elements at all.'));
    expect(doc.text).toBe('Loose text with no elements at all.');
  });

  it('rejects a page with no readable content', async () => {
    await expect(extractFormat('html', page(''))).rejects.toThrow(/no body content/);
  });

  it('produces no sections for a page with no headings', async () => {
    const doc = await extractFormat('html', page('<p>Just one paragraph.</p><p>And another.</p>'));
    expect(doc.sections).toBeUndefined();
  });
});

describe('DOCX extraction', () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
        <w:p><w:r><w:t>Body of the first chapter.</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>A Subheading</w:t></w:r></w:p>
        <w:p><w:r><w:t>Body beneath the subheading.</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Chapter Two</w:t></w:r></w:p>
        <w:p><w:r><w:t>Body of the second chapter.</w:t></w:r></w:p>
      </w:body>
    </w:document>`;

  it('turns heading styles into sections that address the extracted text', async () => {
    const file = await zipFile('book.docx', { 'word/document.xml': documentXml });
    const doc = await extractFormat('docx', file);
    expect(doc.sections?.map(section => section.title))
      .toEqual(['Chapter One', 'A Subheading', 'Chapter Two']);
    for (const section of doc.sections ?? []) {
      // The chapter map searches the text for these titles, so a section whose
      // range does not actually contain its title is a broken chapter.
      expect(doc.text.slice(section.start, section.end)).toContain(section.title);
    }
  });

  it('keeps stamped markup aligned to the same text the sections index', async () => {
    const file = await zipFile('book.docx', { 'word/document.xml': documentXml });
    const doc = await extractFormat('docx', file);
    for (const stamp of stampedTexts(doc.html ?? '')) {
      expect(doc.text.slice(stamp.start, stamp.end)).toBe(stamp.text);
    }
    const dom = document.createElement('div');
    dom.innerHTML = doc.html ?? '';
    expect(dom.querySelectorAll('h1')).toHaveLength(2);
    expect(dom.querySelectorAll('h2')).toHaveLength(1);
  });

  it('omits sections for a document with no headings at all', async () => {
    const flat = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Just one paragraph.</w:t></w:r></w:p>
          <w:p><w:r><w:t>And another.</w:t></w:r></w:p>
        </w:body>
      </w:document>`;
    const file = await zipFile('flat.docx', { 'word/document.xml': flat });
    const doc = await extractFormat('docx', file);
    expect(doc.sections).toBeUndefined();
    expect(doc.text).toBe('Just one paragraph.\n\nAnd another.');
  });
});

// The list cases are the ones the fixture cannot cover: it has a single flat
// list, so nothing here proves that a paragraph AFTER a list stays prose or
// that a nested item is not attributed to its parent.
describe('odtToBlocks lists', () => {
  const parse = (body: string) => odtToBlocks(new DOMParser().parseFromString(
    `<office:document-content
       xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
       xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
       <office:body><office:text>${body}</office:text></office:body>
     </office:document-content>`, 'application/xml'));

  it('marks paragraphs inside list items as list items', () => {
    const blocks = parse(`<text:list>
      <text:list-item><text:p>First item.</text:p></text:list-item>
      <text:list-item><text:p>Second item.</text:p></text:list-item>
    </text:list>`);
    expect(blocks.map(b => b.kind)).toEqual(['li', 'li']);
    expect(blocks.map(b => b.runs[0].text)).toEqual(['First item.', 'Second item.']);
  });

  it('keeps a paragraph after a list as prose', () => {
    // The trap: every ancestor of this paragraph is inside <office:text>, so a
    // naive "is any ancestor a list" check would be right by accident. What
    // matters is that the previous sibling being a list changes nothing.
    const blocks = parse(`<text:list>
        <text:list-item><text:p>Item.</text:p></text:list-item>
      </text:list>
      <text:p>After the list.</text:p>`);
    expect(blocks.map(b => b.kind)).toEqual(['li', 'p']);
    expect(blocks[1].runs[0].text).toBe('After the list.');
  });

  it('marks a nested item as a list item, not as body text', () => {
    const blocks = parse(`<text:list>
      <text:list-item>
        <text:p>Outer item.</text:p>
        <text:list><text:list-item><text:p>Inner item.</text:p></text:list-item></text:list>
      </text:list-item>
    </text:list>`);
    expect(blocks.map(b => b.kind)).toEqual(['li', 'li']);
    expect(blocks.map(b => b.runs[0].text)).toEqual(['Outer item.', 'Inner item.']);
  });

  it('handles a list item holding its text with no nested paragraph', () => {
    const blocks = parse('<text:list><text:list-item>Bare item.</text:list-item></text:list>');
    expect(blocks.map(b => b.kind)).toEqual(['li']);
    expect(blocks[0].runs[0].text).toBe('Bare item.');
  });

  it('reads numbered lists the same as bulleted ones', () => {
    // ODT numbers a list with text:style-name; the kind does not care, but
    // the earlier flattening did, so both styles go through the same path.
    const blocks = parse(`<text:list text:style-name="L1">
      <text:list-item><text:p>Step one.</text:p></text:list-item>
    </text:list>`);
    expect(blocks.map(b => b.kind)).toEqual(['li']);
  });
});

// The other fixtures under public/test-docs/ are exercised end-to-end by
// the browser suite; ODT gets the same treatment here because it is the one
// format whose package layout (a stored `mimetype` member, an ODF manifest)
// nothing else in the suite can catch. A synthetic zip would sail past a
// malformed package that a real writer never produces.
describe('the committed ODT fixture', () => {
  it('extracts headings, list items and sections from the real file', async () => {
    const bytes = readFileSync(resolve(__dirname, '../public/test-docs/test.odt'));
    const file = new File([bytes], 'test.odt', {
      type: 'application/vnd.oasis.opendocument.text',
    });
    const doc = await extractFormat('odt', file);

    expect(doc.text).toContain('Reader Probe');
    expect(doc.text).toContain('Bullet two does as well');
    // A list item's paragraph must not be swallowed by its parent <text:list>.
    expect(doc.text).not.toContain('Bullet one carries a sentence of own');

    const dom = document.createElement('div');
    dom.innerHTML = doc.html ?? '';
    expect(dom.querySelectorAll('h1')[0]?.textContent).toBe('Reader Probe');
    expect(dom.querySelectorAll('h2')[0]?.textContent).toBe('Outline levels');
    // Bullets must render as bullets. The DOCX path already does this and the
    // browser suite asserts it; the ODT path used to flatten list items into
    // plain paragraphs, so the same document rendered differently per format.
    const items = dom.querySelectorAll('li');
    expect([...items].map(li => li.textContent)).toEqual([
      'Bullet one carries a sentence of its own.',
      'Bullet two does as well, and the exporter still finds it in the transcript.',
    ]);
    // The prose around the list stays prose.
    expect(dom.querySelectorAll('p')).toHaveLength(3);

    expect((doc.sections ?? []).map(s => s.title)).toEqual([
      'Reader Probe', 'Outline levels',
    ]);
  });
});
