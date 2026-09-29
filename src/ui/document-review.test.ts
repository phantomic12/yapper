import { describe, expect, it } from 'vitest';
import { buildReviewScript, reviewScriptText } from './document-review';

const source = {
  name: 'report.docx',
  text: 'First paragraph here.\n\nSecond paragraph.',
};

describe('buildReviewScript', () => {
  it('returns an empty script when there are no notes', () => {
    expect(buildReviewScript(source, [], [])).toEqual([]);
  });

  it('speaks highlights and bookmarks interleaved in document order', () => {
    const segments = buildReviewScript(
      source,
      [{ label: 'Later spot', offset: 20 }],
      [{ start: 0, end: 5, color: 'yellow' }],
    );
    expect(segments.map(segment => segment.kind)).toEqual(
      ['intro', 'highlight', 'bookmark', 'outro'],
    );
    expect(segments[0].text).toBe('Review of report.docx: 2 notes.');
    // The highlight at offset 0 comes before the bookmark at offset 20 even
    // though bookmarks were passed first.
    expect(segments[1].start).toBe(0);
    expect(segments[2].start).toBe(20);
    expect(segments[3].text).toBe('End of review.');
  });

  it('quotes the passage and appends the note exactly once punctuated', () => {
    const segments = buildReviewScript(
      source,
      [{ label: 'Key point.', offset: 0, note: 'remember  this.' }],
      [{ start: 0, end: 21, color: 'green', note: 'good   opening.' }],
    );
    expect(segments[1].text).toBe(
      'Highlight 1, green. First paragraph here. Note: good opening.',
    );
    expect(segments[1]).toMatchObject({ start: 0, end: 21 });
    expect(segments[2].text).toBe('Bookmark 1: Key point. Note: remember this.');
    expect(segments[2]).toMatchObject({ start: 0, end: 1 });
  });

  it('speaks highlights without quotes or notes simply', () => {
    const segments = buildReviewScript(
      { name: 'n.txt', text: '' },
      [],
      [{ start: 3, end: 3, color: 'blue' }],
    );
    expect(segments[1].text).toBe('Highlight 1, blue.');
    // A zero-length stored range still gets a paintable span.
    expect(segments[1]).toMatchObject({ start: 3, end: 4 });
  });

  it('numbers each kind separately and handles unknown colours', () => {
    const segments = buildReviewScript(
      source,
      [{ label: 'One', offset: 1 }, { label: 'Two', offset: 2 }],
      [{ start: 0, end: 5, color: 'purple' }],
    );
    expect(segments[1].text).toBe('Highlight 1, purple. First.');
    expect(segments[2].text).toBe('Bookmark 1: One.');
    expect(segments[3].text).toBe('Bookmark 2: Two.');
    expect(segments[0].text).toBe('Review of report.docx: 3 notes.');
  });

  it('uses singular wording for a single note', () => {
    const segments = buildReviewScript(source, [{ label: 'Solo', offset: 0 }], []);
    expect(segments[0].text).toBe('Review of report.docx: 1 note.');
  });
});

describe('reviewScriptText', () => {
  it('flattens segments and keeps every range sliceable back', () => {
    const segments = buildReviewScript(
      source,
      [{ label: 'Spot', offset: 0 }],
      [{ start: 0, end: 5, color: 'yellow' }],
    );
    const built = reviewScriptText(segments);
    expect(built.text.startsWith('Review of report.docx: 2 notes.')).toBe(true);
    expect(built.text).toContain('\n\n');
    expect(built.ranges).toHaveLength(segments.length);
    for (const [index, range] of built.ranges.entries()) {
      expect(built.text.slice(range.start, range.end)).toBe(segments[index].text);
    }
  });

  it('handles an empty script', () => {
    expect(reviewScriptText([])).toEqual({ text: '', ranges: [] });
  });
});
