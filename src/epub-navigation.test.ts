import { describe, expect, it } from 'vitest';
import { epubSectionsFromChapters, type EpubNavigationItem } from './document-reader';

describe('EPUB chapter navigation', () => {
  const chapters = [
    {
      href: 'OEBPS/chapter1.xhtml',
      blocks: [
        { kind: 'h1' as const, runs: [{ text: 'The Beginning' }] },
        { kind: 'p' as const, runs: [{ text: 'Once upon a time.' }] },
      ],
    },
    { href: 'OEBPS/chapter2.xhtml', blocks: [{ kind: 'p' as const, runs: [{ text: 'The next chapter.' }] }] },
  ];

  it('matches TOC labels and makes continuous text ranges for chapters', () => {
    const toc: EpubNavigationItem[] = [
      { label: 'Prologue', href: 'chapter1.xhtml#start' },
      { label: 'A New Day', href: 'chapter2.xhtml' },
    ];
    expect(epubSectionsFromChapters(chapters, toc)).toEqual([
      { title: 'Prologue', start: 0, end: 'The Beginning\n\nOnce upon a time.'.length },
      {
        title: 'A New Day',
        start: 'The Beginning\n\nOnce upon a time.'.length + 2,
        end: 'The Beginning\n\nOnce upon a time.'.length + 2 + 'The next chapter.'.length,
      },
    ]);
  });

  it('recursively matches nested TOC items and falls back to the heading', () => {
    const sections = epubSectionsFromChapters(chapters, [
      {
        label: 'Part One', href: 'part.xhtml',
        subitems: [{ label: 'Nested Chapter', href: 'OEBPS/chapter2.xhtml#text' }],
      },
    ]);
    expect(sections.map(section => section.title)).toEqual(['The Beginning', 'Nested Chapter']);
  });

  it('does not associate unrelated resources by suffix', () => {
    const sections = epubSectionsFromChapters(chapters, [
      { label: 'Wrong target', href: 'other/chapter1.xhtml' },
    ]);
    expect(sections[0].title).toBe('The Beginning');
  });
});
