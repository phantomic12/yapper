import { describe, expect, it } from 'vitest';
import { countWords, formatStatusBar, positionPercent, readingMinutes } from './document-stats';

describe('countWords', () => {
  it('counts runs of non-whitespace', () => {
    expect(countWords('The quick brown fox')).toBe(4);
    expect(countWords('  spaced   out\nwords\t')).toBe(3);
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t  ')).toBe(0);
  });
});

describe('readingMinutes', () => {
  it('rounds to at least one minute for any text', () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(10)).toBe(1);
    expect(readingMinutes(400)).toBe(2);
    expect(readingMinutes(250)).toBe(1);
  });
});

describe('positionPercent', () => {
  it('reports progress through the document', () => {
    expect(positionPercent(50, 200)).toBe(25);
    expect(positionPercent(0, 200)).toBe(0);
    expect(positionPercent(200, 200)).toBe(100);
  });

  it('clamps out-of-range offsets and handles empty documents', () => {
    expect(positionPercent(-10, 200)).toBe(0);
    expect(positionPercent(500, 200)).toBe(100);
    expect(positionPercent(5, 0)).toBe(0);
  });
});

describe('formatStatusBar', () => {
  it('joins the three readings', () => {
    expect(formatStatusBar(25, 1234)).toBe('25% · 1,234 words · ~6 min read');
    expect(formatStatusBar(0, 0)).toBe('0% · 0 words · ~0 min read');
  });
});
