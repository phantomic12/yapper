import { describe, expect, it } from 'vitest';
import { sectionsFromCsvRows, sectionsFromPlainText } from './text-sections';

describe('sectionsFromPlainText', () => {
  it('reads ATX headings, stripping the hashes and closing markers', () => {
    const text = '# The Beginning\n\nSome prose here.\n\n## The Middle\n\nMore prose.\n';
    expect(sectionsFromPlainText(text)).toEqual([
      { title: 'The Beginning', start: 0, end: text.indexOf('## The Middle') },
      { title: 'The Middle', start: text.indexOf('## The Middle'), end: text.length },
    ]);
  });

  it('reads setext headings underlined with === or ---', () => {
    const text = 'Opening\n=======\n\nBody text.\n\nLater\n-----\n\nMore body.\n';
    expect(sectionsFromPlainText(text).map(s => s.title)).toEqual(['Opening', 'Later']);
  });

  it('infers a heading from a short line alone between blank lines', () => {
    const text = [
      'A Title Here',
      '',
      'First body paragraph, long enough to read as a sentence of prose.',
      '',
      'Second Chapter',
      '',
      'More body text, also long enough to read as a sentence.',
    ].join('\n');
    expect(sectionsFromPlainText(text).map(s => s.title)).toEqual(['A Title Here', 'Second Chapter']);
  });

  it('does not mistake a sentence for a heading', () => {
    const text = [
      'This is an ordinary sentence.',
      'And this is another one.',
      'A third line of running prose.',
      'And a fourth to be sure.',
    ].join('\n\n');
    expect(sectionsFromPlainText(text)).toEqual([]);
  });

  it('does not mistake a long line for a heading', () => {
    const long = 'x'.repeat(200);
    const text = `${long}\n\nBody one.\n\n${long}\n\nBody two.\n`;
    expect(sectionsFromPlainText(text)).toEqual([]);
  });

  it('ignores a setext underline that is itself preceded by a heading', () => {
    // `---` after a blank line is a thematic break, not an underline.
    const text = 'Body paragraph one.\n\n---\n\nBody paragraph two.\n';
    expect(sectionsFromPlainText(text)).toEqual([]);
  });

  it('drops repeated titles so a table of contents does not double up', () => {
    const text = '# Notes\n\nBody one.\n\n# Notes\n\nBody two.\n';
    expect(sectionsFromPlainText(text).map(s => s.title)).toEqual(['Notes']);
  });

  it('returns nothing for a document that is only a title', () => {
    expect(sectionsFromPlainText('# Just A Title\n')).toEqual([]);
  });

  it('does not turn song lyrics into a chapter per line', () => {
    // Every line here passes the heading test: short, alone between blank
    // lines, no terminal punctuation. What the document does not have is
    // prose, and that is the signal that saves it.
    const text = [
      'Twinkle twinkle little star', '',
      'How I wonder what you are', '',
      'Up above the world so high', '',
      'Like a diamond in the sky',
    ].join('\n');
    expect(sectionsFromPlainText(text)).toEqual([]);
  });

  it('does not turn a meeting agenda into chapters', () => {
    const text = [
      'Monday', '', 'Attendees: five', '',
      'Budget review', '',
      'Next steps', '',
      'Owner assigned',
    ].join('\n');
    expect(sectionsFromPlainText(text)).toEqual([]);
  });

  it('does not turn a chat log into chapters', () => {
    const text = 'alice: hey there\nbob: hello\nalice: how are you\nbob: fine thanks';
    expect(sectionsFromPlainText(text)).toEqual([]);
  });

  it('does not treat an indented note as a heading', () => {
    const text = [
      'Some prose that runs on for a while here, long enough to count as a sentence.',
      '',
      '    Note: this is indented commentary.',
      '',
      'More prose after the note, also long enough to count as a sentence.',
    ].join('\n');
    expect(sectionsFromPlainText(text)).toEqual([]);
  });

  it('still finds real chapters in a document of short paragraphs', () => {
    // Chapter prose is often well under the heading length limit, so the
    // prose test keys on sentence punctuation, not on line length.
    const text = [
      'Chapter One', '',
      'It was a bright cold day in April.', '',
      'The clocks were striking thirteen.', '',
      'Chapter Two', '',
      'Winston Smith slipped quickly.', '',
      'His chin nuzzled into the breast of his coat.',
    ].join('\n');
    expect(sectionsFromPlainText(text).map(s => s.title)).toEqual(['Chapter One', 'Chapter Two']);
  });

  it('honours explicit Markdown headings over short, list-like body text', () => {
    // The inferred path would reject this: short lines, no sentences. The
    // author typed `#`, so their structure is taken at its word.
    const text = '# One\n- a\n- b\n# Two\n- c\n- d\n';
    expect(sectionsFromPlainText(text).map(s => s.title)).toEqual(['One', 'Two']);
  });

  it('returns nothing for empty or unpunctuated prose', () => {
    expect(sectionsFromPlainText('')).toEqual([]);
    expect(sectionsFromPlainText('   \n\n  \n')).toEqual([]);
  });

  it('gives every section a range that slices back to its own text', () => {
    // The invariant the chapter map rests on: a section's range must actually
    // cover the heading in the text it names, or the audiobook's chapter
    // markers point at the wrong words.
    const text = '# Alpha\n\nBody.\n\n## Beta\n\nMore body.\n\n## Gamma\n\nLast body.\n';
    for (const section of sectionsFromPlainText(text)) {
      // The title is stripped of its `#` markers, so the line it starts must
      // *contain* it rather than equal it.
      const line = text.slice(section.start).split('\n')[0];
      expect(line).toContain(section.title);
      expect(section.end).toBeGreaterThan(section.start);
    }
  });
});

describe('sectionsFromCsvRows', () => {
  const sep = ', ';
  const asText = (rows: string[][]): string => rows.map(row => row.join(sep)).join('\n');

  const sorted: string[][] = [
    ['Region', 'Sales'],
    ['North', '10'], ['North', '20'],
    ['South', '30'], ['South', '40'],
    ['East', '50'],
  ];

  it('chapters a sorted table by the column it groups on', () => {
    expect(sectionsFromCsvRows(sorted).map(s => s.title)).toEqual(['North', 'South', 'East']);
  });

  it('gives ranges that address the rows they name', () => {
    const text = asText(sorted);
    for (const section of sectionsFromCsvRows(sorted)) {
      expect(text.slice(section.start, section.end)).toContain(section.title);
    }
  });

  it('rejects a column whose values interleave', () => {
    // Repeating is not enough: an unsorted export has no order to navigate.
    expect(sectionsFromCsvRows([
      ['Region', 'Sales'],
      ['North', '10'], ['South', '20'], ['North', '30'], ['South', '40'],
    ])).toEqual([]);
  });

  it('rejects a column with a different value on every row', () => {
    expect(sectionsFromCsvRows([
      ['Name', 'Sales'], ['alpha', '10'], ['beta', '20'], ['gamma', '30'],
    ])).toEqual([]);
  });

  it('rejects a table with too few rows to show a pattern', () => {
    expect(sectionsFromCsvRows([
      ['Region', 'Sales'], ['North', '10'], ['South', '20'],
    ])).toEqual([]);
  });

  it('rejects a table with only one distinct group', () => {
    expect(sectionsFromCsvRows([
      ['Region', 'Sales'], ['North', '10'], ['North', '20'], ['North', '30'],
    ])).toEqual([]);
  });

  it('falls through to a later column when the first has no structure', () => {
    expect(sectionsFromCsvRows([
      ['Order', 'Status'], ['1', 'Open'], ['2', 'Open'], ['3', 'Closed'], ['4', 'Closed'],
    ]).map(s => s.title)).toEqual(['Open', 'Closed']);
  });
});
