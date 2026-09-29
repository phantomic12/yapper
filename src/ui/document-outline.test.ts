import { describe, expect, it } from 'vitest';
import {
  buildOutline,
  outlineFromHtml,
  outlineFromSections,
  outlineIndexForOffset,
  outlineIndexForPage,
  outlineIndexForPageNear,
} from './document-outline';

const sections = [
  { title: 'Sheet1', start: 0, end: 100 },
  { title: 'Sheet2', start: 100, end: 250 },
];

const html = [
  '<h1 data-off="0:10">Intro</h1>',
  '<p data-off="10:40">body text here</p>',
  '<h2 data-off="40:55">Details</h2>',
  '<h2>Unstamped heading</h2>',
].join('');

describe('outlineFromSections', () => {
  it('maps sections to flat items with offsets', () => {
    expect(outlineFromSections(sections)).toEqual([
      { title: 'Sheet1', level: 0, start: 0 },
      { title: 'Sheet2', level: 0, start: 100 },
    ]);
  });
});

describe('outlineFromHtml', () => {
  it('keeps heading levels and offsets, skipping unstamped headings', () => {
    const outline = outlineFromHtml(html);
    expect(outline).toEqual([
      { title: 'Intro', level: 1, start: 0 },
      { title: 'Details', level: 2, start: 40 },
    ]);
  });
});

describe('buildOutline', () => {
  it('prefers real headings over sections', () => {
    const outline = buildOutline(html, sections);
    expect(outline.map(item => item.title)).toEqual(['Intro', 'Details']);
  });

  it('falls back to sections when there are no headings', () => {
    const outline = buildOutline('<p data-off="0:5">plain</p>', sections);
    expect(outline.map(item => item.title)).toEqual(['Sheet1', 'Sheet2']);
  });

  it('returns empty when neither exists', () => {
    expect(buildOutline(undefined, undefined)).toEqual([]);
    expect(buildOutline('<p>x</p>', [])).toEqual([]);
  });
});

describe('outline lookups', () => {
  const outline = [
    { title: 'A', level: 1, start: 0 },
    { title: 'B', level: 1, start: 50 },
    { title: 'C', level: 1, start: 120 },
  ];

  it('finds the item an offset falls inside', () => {
    expect(outlineIndexForOffset(outline, 0)).toBe(0);
    expect(outlineIndexForOffset(outline, 49)).toBe(0);
    expect(outlineIndexForOffset(outline, 50)).toBe(1);
    expect(outlineIndexForOffset(outline, 500)).toBe(2);
    expect(outlineIndexForOffset([], 5)).toBe(-1);
  });

  it('finds page matches exactly and approximately', () => {
    const pages = [
      { title: 'A', level: 0, page: 1 },
      { title: 'B', level: 0, page: 5 },
      { title: 'C', level: 0, page: 9 },
    ];
    expect(outlineIndexForPage(pages, 5)).toBe(1);
    expect(outlineIndexForPage(pages, 6)).toBe(-1);
    expect(outlineIndexForPageNear(pages, 5)).toBe(1);
    expect(outlineIndexForPageNear(pages, 6)).toBe(1);
    expect(outlineIndexForPageNear(pages, 9)).toBe(2);
    expect(outlineIndexForPageNear(pages, 0)).toBe(-1);
  });
});
