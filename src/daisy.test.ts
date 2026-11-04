import { describe, expect, it } from 'vitest';
import {
  buildDaisyDtbook,
  buildDaisyNcx,
  buildDaisyOpf,
  buildDaisySmil,
  buildDaisyTimeline,
  createDaisyBook,
  DAISY_SAMPLE_RATE,
  daisyIdentifier,
  planDaisyBook,
  type DaisyClip,
  type DaisyPlan,
} from './daisy';

const RATE = 1000;

/** A short tone, not silence: the WAV headers and lengths are what matter. */
function tone(seconds: number, value = 0.3): Float32Array {
  const length = Math.round(seconds * RATE);
  return Float32Array.from({ length }, (_, i) => Math.sin(i / 7) * value);
}

const BOOK_TEXT = 'Chapter one opens here. It has two sentences.\n\nChapter two begins now.';

function bookClips(): DaisyClip[] {
  return [
    {
      text: 'Chapter one opens here. It has two sentences.',
      audio: tone(4),
      sampleRate: RATE,
      wordTimings: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    },
    {
      text: 'Chapter two begins now.',
      audio: tone(2),
      sampleRate: RATE,
      wordTimings: [0, 0.5, 1, 1.5],
    },
  ];
}

const SECTIONS = [
  { title: 'One', start: 0 },
  { title: 'Two', start: BOOK_TEXT.indexOf('Chapter two') },
];

function bookOptions() {
  return {
    title: 'My Book',
    sections: SECTIONS,
    documentText: BOOK_TEXT,
    // No gap: makes the expected sample offsets exact.
    gapSeconds: 0,
  };
}

/** Parse an XML member, failing the test on a parser error rather than returning junk. */
function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error(`XML is not well formed: ${error.textContent?.slice(0, 200)}`);
  return doc;
}

async function openBook() {
  const JSZip = (await import('jszip')).default;
  const book = await createDaisyBook(bookClips(), bookOptions());
  return { book, zip: await JSZip.loadAsync(book.zip) };
}

/** `../my-book.xml#t3` and `my-book.xml#t3` both name `my-book.xml`. */
function hrefParts(href: string): { path: string; fragment: string } {
  const [rawPath, fragment = ''] = href.split('#');
  return { path: rawPath.replace(/^\.\.\//, ''), fragment };
}

describe('buildDaisyTimeline', () => {
  it('cuts the merged transcript into phrases that tile it exactly', () => {
    const timeline = buildDaisyTimeline(bookClips(), 0.5);
    expect(timeline.totalSeconds).toBe(6.5);
    expect(timeline.segments.map(segment => segment.text)).toEqual([
      'Chapter one opens here.',
      'It has two sentences.',
      'Chapter two begins now.',
    ]);
    // First phrase starts the book, each ends where the next begins, the last
    // closes on the end of the audio — no gaps and no overlaps.
    expect(timeline.segments[0].startSeconds).toBe(0);
    expect(timeline.segments[1].startSeconds).toBe(timeline.segments[0].endSeconds);
    expect(timeline.segments[2].startSeconds).toBe(timeline.segments[1].endSeconds);
    expect(timeline.segments[2].endSeconds).toBe(timeline.totalSeconds);
    // Every word of the transcript appears exactly once.
    expect(timeline.segments.map(segment => segment.text).join(' ')).toBe(timeline.text);
  });

  it('refuses a session with no spoken text', () => {
    expect(() => buildDaisyTimeline([])).toThrow(/no clips/);
    expect(() => buildDaisyTimeline([
      { text: '   ', audio: tone(1), sampleRate: RATE },
    ])).toThrow(/no spoken text/);
  });
});

describe('planDaisyBook', () => {
  it('gives each section its own chapter and its own audio file', () => {
    const plan = planDaisyBook(bookClips(), bookOptions());
    expect(plan.title).toBe('My Book');
    expect(plan.base).toBe('my-book');
    // No gap in bookOptions: 4s + 2s.
    expect(plan.totalSeconds).toBe(6);
    expect(plan.chapters.map(chapter => chapter.title)).toEqual(['One', 'Two']);
    expect(plan.chapters[0]).toMatchObject({
      startSeconds: 0,
      endSeconds: 4,
      smilPath: 'smil/ch-001.smil',
      audioPath: 'audio/ch-001.wav',
    });
    expect(plan.chapters[1]).toMatchObject({
      startSeconds: 4,
      endSeconds: 6,
      smilPath: 'smil/ch-002.smil',
      audioPath: 'audio/ch-002.wav',
    });
    // Phrases went to the chapter their first word falls in.
    expect(plan.chapters[0].segments.map(segment => segment.text)).toEqual([
      'Chapter one opens here.',
      'It has two sentences.',
    ]);
    expect(plan.chapters[1].segments.map(segment => segment.text)).toEqual([
      'Chapter two begins now.',
    ]);
  });

  it('falls back to a single chapter when the document has no sections', () => {
    const plan = planDaisyBook(bookClips(), { title: 'Solo', gapSeconds: 0 });
    expect(plan.chapters).toHaveLength(1);
    expect(plan.chapters[0].title).toBe('Solo');
    expect(plan.chapters[0].startSeconds).toBe(0);
    expect(plan.chapters[0].endSeconds).toBe(6);
  });

  it('never asks a chapter for audio past its own end', () => {
    const plan = planDaisyBook(bookClips(), bookOptions());
    for (const chapter of plan.chapters) {
      for (const segment of chapter.segments) {
        expect(segment.startSeconds).toBeGreaterThanOrEqual(chapter.startSeconds);
        expect(segment.endSeconds).toBeLessThanOrEqual(chapter.endSeconds);
        expect(segment.endSeconds).toBeGreaterThan(segment.startSeconds);
      }
    }
  });

  it('numbers every phrase uniquely across the book', () => {
    const plan = planDaisyBook(bookClips(), bookOptions());
    const ids = plan.chapters.flatMap(chapter => chapter.segments.map(segment => segment.id));
    expect(ids).toEqual([1, 2, 3]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('daisyIdentifier', () => {
  it('is stable for the same reading and distinct for different text', () => {
    const first = daisyIdentifier('My Book', bookClips());
    expect(first).toBe(daisyIdentifier('My Book', bookClips()));
    expect(first).toMatch(/^urn:yapper:my-book-[0-9a-f]{8}$/);
    const other = bookClips();
    other[0].text = 'Something else entirely.';
    expect(daisyIdentifier('My Book', other)).not.toBe(first);
  });
});

describe('createDaisyBook', () => {
  it('packs a DAISY 3 file set at the archive root', async () => {
    const { book, zip } = await openBook();
    // JSZip records explicit folders for the smil/ and audio/ paths; a DAISY
    // set is its files, so compare those.
    const members = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
    expect(members).toEqual([
      'audio/ch-001.wav',
      'audio/ch-002.wav',
      'my-book.ncx',
      'my-book.xml',
      'package.opf',
      'smil/ch-001.smil',
      'smil/ch-002.smil',
    ]);
    expect(book.chapters).toEqual([
      { title: 'One', startSeconds: 0 },
      { title: 'Two', startSeconds: 4 },
    ]);
    expect(book.totalSeconds).toBe(6);
    expect(book.smilFiles).toEqual(['smil/ch-001.smil', 'smil/ch-002.smil']);
    expect(book.audioFiles).toEqual(['audio/ch-001.wav', 'audio/ch-002.wav']);
  });

  it('writes well-formed XML for every document in the set', async () => {
    const { zip } = await openBook();
    const xmlMembers = ['package.opf', 'my-book.ncx', 'my-book.xml', 'smil/ch-001.smil', 'smil/ch-002.smil'];
    for (const member of xmlMembers) {
      const xml = await zip.file(member)!.async('string');
      expect(() => parseXml(xml), member).not.toThrow();
      // Namespaced roots, because a DTB is a namespaced XML application.
      expect(parseXml(xml).documentElement.namespaceURI, member).toMatch(/^(http:\/\/www\.daisy\.org|http:\/\/openebook\.org|http:\/\/www\.w3\.org\/2001\/SMIL20)/);
    }
  });

  it('synchronizes each phrase to a real clip of its chapter audio', async () => {
    const { zip } = await openBook();
    const smilOne = parseXml(await zip.file('smil/ch-001.smil')!.async('string'));
    const smilTwo = parseXml(await zip.file('smil/ch-002.smil')!.async('string'));

    const parsOne = Array.from(smilOne.getElementsByTagName('par'));
    const parsTwo = Array.from(smilTwo.getElementsByTagName('par'));
    expect(parsOne).toHaveLength(2);
    expect(parsTwo).toHaveLength(1);
    expect(parsOne.map(par => par.getAttribute('id'))).toEqual(['p1', 'p2']);
    expect(parsTwo.map(par => par.getAttribute('id'))).toEqual(['p3']);

    const clip = (par: Element) => {
      const audio = par.getElementsByTagName('audio')[0];
      return {
        src: audio.getAttribute('src')!,
        begin: audio.getAttribute('clipBegin')!,
        end: audio.getAttribute('clipEnd')!,
      };
    };
    expect(clip(parsOne[0])).toEqual({ src: '../audio/ch-001.wav', begin: '00:00:00.000', end: '00:00:02.000' });
    expect(clip(parsOne[1])).toEqual({ src: '../audio/ch-001.wav', begin: '00:00:02.000', end: '00:00:04.000' });
    // The second chapter's file starts at zero even though the book does not:
    // clip times are relative to the audio file, book time lives in elapsedTime.
    expect(clip(parsTwo[0])).toEqual({ src: '../audio/ch-002.wav', begin: '00:00:00.000', end: '00:00:02.000' });
    expect(smilTwo.getElementsByTagName('meta')[2].getAttribute('content')).toBe('00:00:04.000');
  });

  it('maps SMIL text references onto the DTBook elements they name', async () => {
    const { zip } = await openBook();
    const dtbook = parseXml(await zip.file('my-book.xml')!.async('string'));
    const paragraphs = Array.from(dtbook.getElementsByTagName('p'));
    const byId = new Map(paragraphs.map(paragraph => [paragraph.getAttribute('id'), paragraph]));

    for (const chapter of ['smil/ch-001.smil', 'smil/ch-002.smil']) {
      const smil = parseXml(await zip.file(chapter)!.async('string'));
      for (const par of Array.from(smil.getElementsByTagName('par'))) {
        const { path, fragment } = hrefParts(par.getElementsByTagName('text')[0].getAttribute('src')!);
        expect(path).toBe('my-book.xml');
        const element = byId.get(fragment);
        expect(element, `${chapter}#${fragment}`).toBeDefined();
        // The element points back at the par that speaks it.
        expect(element!.getAttribute('smilref')).toBe(`${chapter}#${par.getAttribute('id')}`);
        expect(element!.textContent).toBeTruthy();
      }
    }
  });

  it('lists every chapter in the NCX, in order, pointing at a real time container', async () => {
    const { zip } = await openBook();
    const ncx = parseXml(await zip.file('my-book.ncx')!.async('string'));
    const navPoints = Array.from(ncx.getElementsByTagName('navPoint'));
    expect(navPoints.map(point => point.getAttribute('playOrder'))).toEqual(['1', '2']);
    expect(navPoints.map(point => point.getElementsByTagName('text')[0].textContent)).toEqual(['One', 'Two']);

    for (const point of navPoints) {
      const seqId = `seq${point.getAttribute('playOrder')}`;
      const { path, fragment } = hrefParts(point.getElementsByTagName('content')[0].getAttribute('src')!);
      expect(fragment).toBe(seqId);
      const smil = parseXml(await zip.file(path)!.async('string'));
      // Not getElementById: XML parsed without a DTD has no id-typed
      // attributes, so the map from id to element is our own lookup.
      const seq = Array.from(smil.getElementsByTagName('seq'))
        .find(element => element.getAttribute('id') === seqId);
      expect(seq, `${path}#${seqId}`).toBeDefined();
    }
    expect(ncx.getElementsByTagName('meta')[0].getAttribute('name')).toBe('dtb:uid');
  });

  it('declares the full text book type and lists every member in the manifest', async () => {
    const { zip } = await openBook();
    const opf = parseXml(await zip.file('package.opf')!.async('string'));
    const meta = Array.from(opf.getElementsByTagName('meta'));
    const byName = new Map(meta.map(entry => [entry.getAttribute('name'), entry.getAttribute('content')]));
    expect(byName.get('dtb:multimediaType')).toBe('audioFullText');
    expect(byName.get('dtb:multimediaContent')).toBe('audio,text');
    expect(byName.get('dtb:audioFormat')).toBe('WAV');
    expect(byName.get('dtb:totalTime')).toBe('00:00:06.000');

    const items = Array.from(opf.getElementsByTagName('item'));
    const hrefs = items.map(item => item.getAttribute('href')).sort();
    expect(hrefs).toEqual(Object.keys(zip.files).filter(name => !zip.files[name].dir).sort());
    expect(items.every(item => !!item.getAttribute('media-type'))).toBe(true);

    const spine = Array.from(opf.getElementsByTagName('itemref')).map(ref => ref.getAttribute('idref'));
    expect(spine).toEqual(['smil-1', 'smil-2']);
    const byId = new Map(items.map(item => [item.getAttribute('id'), item.getAttribute('href')]));
    expect(spine.map(id => byId.get(id))).toEqual(['smil/ch-001.smil', 'smil/ch-002.smil']);
  });

  it('carries one identifier through every file that must agree on it', async () => {
    const { book, zip } = await openBook();
    const opf = await zip.file('package.opf')!.async('string');
    const ncx = await zip.file('my-book.ncx')!.async('string');
    const dtbook = await zip.file('my-book.xml')!.async('string');
    const smilOne = await zip.file('smil/ch-001.smil')!.async('string');
    expect(opf).toContain(`<dc:Identifier id="uid">${book.identifier}</dc:Identifier>`);
    expect(opf).toContain('unique-identifier="uid"');
    for (const xml of [ncx, dtbook, smilOne]) {
      expect(xml).toContain(`<meta name="dtb:uid" content="${book.identifier}"/>`);
    }
  });

  it('cuts chapter audio out of the merged timeline at the chapter boundary', async () => {
    // Two constant tones so the split is visible in the samples themselves.
    const clips: DaisyClip[] = [
      { text: 'first part.', audio: new Float32Array(RATE * 2).fill(0.5), sampleRate: RATE, wordTimings: [0, 0.6] },
      { text: 'second part.', audio: new Float32Array(RATE * 2).fill(-0.5), sampleRate: RATE, wordTimings: [0, 0.6] },
    ];
    const JSZip = (await import('jszip')).default;
    const book = await createDaisyBook(clips, {
      title: 'Split',
      gapSeconds: 0,
      documentText: 'first part.\n\nsecond part.',
      sections: [{ title: 'First', start: 0 }, { title: 'Second', start: 12 }],
    });
    const zip = await JSZip.loadAsync(book.zip);
    const wavOne = new Uint8Array(await zip.file('audio/ch-001.wav')!.async('arraybuffer'));
    const wavTwo = new Uint8Array(await zip.file('audio/ch-002.wav')!.async('arraybuffer'));

    const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleCount = (bytes: Uint8Array) => (bytes.length - 44) / 2;
    expect(new TextDecoder().decode(wavOne.subarray(0, 4))).toBe('RIFF');
    // 24 kHz engines are not in the standard's required set; every chapter is
    // resampled to the 22.05 kHz rate DAISY players must handle.
    expect(view(wavOne).getUint32(24, true)).toBe(DAISY_SAMPLE_RATE);
    expect(view(wavOne).getUint16(34, true)).toBe(16);
    expect(sampleCount(wavOne)).toBe(DAISY_SAMPLE_RATE * 2);
    expect(sampleCount(wavTwo)).toBe(DAISY_SAMPLE_RATE * 2);
    expect((sampleCount(wavOne) + sampleCount(wavTwo)) / DAISY_SAMPLE_RATE).toBeCloseTo(4, 5);
    // First sample of each chapter is that chapter's tone, not its neighbour's.
    expect(view(wavOne).getInt16(44, true)).toBe(16384);
    expect(view(wavTwo).getInt16(44, true)).toBe(-16384);
  });

  it('produces a playable one-chapter book when there are no sections', async () => {
    const JSZip = (await import('jszip')).default;
    const book = await createDaisyBook(bookClips(), { title: 'Solo Book', gapSeconds: 0 });
    const zip = await JSZip.loadAsync(book.zip);
    expect(Object.keys(zip.files).filter(name => !zip.files[name].dir).sort()).toEqual([
      'audio/ch-001.wav', 'package.opf', 'smil/ch-001.smil', 'solo-book.ncx', 'solo-book.xml',
    ]);
    const ncx = parseXml(await zip.file('solo-book.ncx')!.async('string'));
    expect(ncx.getElementsByTagName('navPoint')).toHaveLength(1);
    expect(ncx.getElementsByTagName('navPoint')[0].getElementsByTagName('text')[0].textContent).toBe('Solo Book');
    const dtbook = parseXml(await zip.file('solo-book.xml')!.async('string'));
    expect(dtbook.getElementsByTagName('p')).toHaveLength(3);
  });

  it('rejects an empty session', async () => {
    await expect(createDaisyBook([])).rejects.toThrow(/no clips/);
  });
});

describe('DAISY document builders', () => {
  const plan = (): DaisyPlan => planDaisyBook(bookClips(), bookOptions());

  it('keeps clip times inside their chapter file', () => {
    const smil = buildDaisySmil(plan(), 1);
    expect(smil).toContain('clipBegin="00:00:00.000"');
    expect(smil).toContain('src="../audio/ch-002.wav"');
    expect(() => buildDaisySmil(plan(), 2)).toThrow(/no chapter/);
  });

  it('escapes user text everywhere it lands in XML', () => {
    const clips = bookClips();
    // The form feed is what a PDF extractor leaves behind; XML 1.0 has no
    // character for it, so it must be dropped, not escaped.
    clips[0].text = 'A & B <tag> "quoted" — done.';
    clips[0].wordTimings = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
    const escaped = planDaisyBook(clips, { title: 'Tom & Jerry <1>', gapSeconds: 0 });
    const dtbook = buildDaisyDtbook(escaped);
    expect(dtbook).toContain('Tom &amp; Jerry &lt;1&gt;');
    expect(dtbook).toContain('A &amp; B &lt;tag&gt; &quot;quoted&quot;');
    expect(dtbook).not.toContain('');
    expect(() => parseXml(dtbook)).not.toThrow();
    expect(() => parseXml(buildDaisyNcx(escaped))).not.toThrow();
    expect(() => parseXml(buildDaisyOpf(escaped))).not.toThrow();
  });
});
