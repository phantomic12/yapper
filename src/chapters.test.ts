import { describe, expect, it } from 'vitest';
import { buildChapterVtt, chaptersFromSections } from './chapters';

describe('chaptersFromSections', () => {
  const documentText = 'The first chapter opens here.\n\nThe second chapter picks up after it.';
  const first = documentText.indexOf('The first');
  const second = documentText.indexOf('The second');
  const sections = [
    { title: 'Chapter One', start: first },
    { title: 'Chapter Two', start: second },
  ];
  const merged = 'The first chapter opens here. The second chapter picks up after it.';
  // "The first" opens at word 0, "The second" at word 5, "picks up" at word 8.
  const timings = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  it('maps each section to the time its words are spoken', () => {
    const chapters = chaptersFromSections(sections, documentText, merged, timings);
    expect(chapters).toEqual([
      { title: 'Chapter One', startSeconds: 0 },
      { title: 'Chapter Two', startSeconds: 5 },
    ]);
  });

  it('ignores case and punctuation when locating a section', () => {
    const chapters = chaptersFromSections(
      [{ title: 'Noisy', start: documentText.indexOf('the first') + 1 }],
      documentText,
      merged,
      timings,
    );
    expect(chapters).toEqual([{ title: 'Noisy', startSeconds: 0 }]);
  });

  it('shortens the probe when the longest one is not present', () => {
    const chapters = chaptersFromSections(
      [{ title: 'Later', start: documentText.indexOf('picks up') }],
      documentText,
      merged,
      timings,
    );
    // Reading began mid-document, so the track gains a name for the opening.
    expect(chapters).toEqual([
      { title: 'Start', startSeconds: 0 },
      { title: 'Later', startSeconds: 8 },
    ]);
  });

  it('drops sections that never appear in what was read', () => {
    const chapters = chaptersFromSections(
      [{ title: 'Missing', start: documentText.length + 100 }],
      documentText,
      merged,
      timings,
    );
    expect(chapters).toEqual([]);
  });

  it('anchors a leading chapter at zero when reading started mid-document', () => {
    const chapters = chaptersFromSections(
      [{ title: 'Chapter Two', start: second }],
      documentText,
      merged,
      timings,
    );
    // The excerpt opens at the second chapter's text, so the track needs a
    // name for the stretch before it rather than starting mid-file.
    expect(chapters).toEqual([
      { title: 'Start', startSeconds: 0 },
      { title: 'Chapter Two', startSeconds: 5 },
    ]);
  });

  it('keeps the first of two sections landing at the same time', () => {
    const chapters = chaptersFromSections(
      [
        { title: 'One', start: first },
        { title: 'Two', start: first + 1 },
      ],
      documentText,
      merged,
      timings,
    );
    expect(chapters.map(c => c.title)).toEqual(['One']);
  });

  it('returns nothing without sections, text, or words', () => {
    expect(chaptersFromSections(undefined, documentText, merged, timings)).toEqual([]);
    expect(chaptersFromSections(sections, '', merged, timings)).toEqual([]);
    expect(chaptersFromSections(sections, documentText, '', [])).toEqual([]);
  });

  it('skips untitled and malformed sections', () => {
    const chapters = chaptersFromSections(
      [
        { title: '  ', start: first },
        { title: 'Bad', start: NaN },
        { title: 'Good', start: first },
      ],
      documentText,
      merged,
      timings,
    );
    expect(chapters.map(c => c.title)).toEqual(['Good']);
  });
});

describe('buildChapterVtt', () => {
  const chapters = [
    { title: 'Opening', startSeconds: 0 },
    { title: 'Middle', startSeconds: 65.5 },
  ];

  it('writes a cue per chapter, each ending where the next begins', () => {
    const vtt = buildChapterVtt(chapters, 200)!;
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:01:05.500\nOpening');
    expect(vtt).toContain('00:01:05.500 --> 00:03:20.000\nMiddle');
  });

  it('returns nothing when there are no chapters', () => {
    expect(buildChapterVtt([], 200)).toBeNull();
  });
});
