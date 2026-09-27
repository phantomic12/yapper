import { describe, it, expect } from 'vitest';
import {
  classifyBlockText,
  classifyText,
  classifyLayoutBlocks,
  countKinds,
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
