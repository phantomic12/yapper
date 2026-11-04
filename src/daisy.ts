/**
 * DAISY 3 talking-book export (ANSI/NISO Z39.86-2005).
 *
 * A DAISY book is a file *set* whose point is the synchronization layer, not a
 * playlist around one audio file. What this module emits, at the zip root:
 *
 *   package.opf     OEB 1.2 package: metadata, manifest, reading order
 *   <name>.ncx      the Navigation Control File — one navPoint per chapter
 *   <name>.xml      DTBook full text: a heading per chapter, a <p> per phrase
 *   smil/ch-NNN.smil  one SMIL per chapter; each <par> ties a DTBook element
 *                    to a clip of that chapter's audio
 *   audio/ch-NNN.wav  one PCM WAV per chapter
 *
 * That combination is the `audioFullText` DTB type: a player can announce the
 * text as it is spoken, jump between chapters, and search the document.
 * (DAISY 3's navigation control file is the NCX; `ncc.html` belongs to DAISY
 * 2.02 and is deliberately not emitted, because a DAISY 2 player would also
 * need a second, differently-timed SMIL set to go with it.)
 *
 * Segmentation is the caption cue builder, not a second sentence splitter: a
 * caption cue and a SMIL <par> are the same fact — some words and the span of
 * audio that speaks them. Chapter times come from `chaptersFromSections`, the
 * same content-based mapping the audiobook's chapter track uses, so a player's
 * chapter list and the zip's structure cannot disagree.
 *
 * Audio is WAV (media type audio/x-wav, the type the standard mandates for
 * WAV). Every maintained in-browser MP3 encoder is a port of LAME or Shine
 * under the LGPL, and this project takes no copyleft dependency, so MP3 is not
 * offered at all: a format the app cannot legally encode is not a user choice.
 * `encodeChapterAudio` and `AUDIO_*` below are the only places a future,
 * permissively licensed encoder would need to change.
 */

import { concatenateClips, resampleClip, sliceClip } from './audio-export';
import { float32ToWav } from './engine';
import { buildCaptionCues, formatVttTimestamp } from './captions';
import { chaptersFromSections, type Chapter, type SectionSource } from './chapters';
import { mergeClipTimings } from './word-timings';

const AUDIO_EXTENSION = 'wav';
const AUDIO_MEDIA_TYPE = 'audio/x-wav';
/**
 * Z39.86 requires players to handle 44.1, 22.05 and 11.025 kHz WAV only — not
 * the 24 kHz most neural TTS engines emit. 22.05 kHz is the standard's rate
 * closest to that source (so the resample is a downsample of half a step, not
 * a decimation), and half the bytes of 44.1 with no audible loss for speech.
 */
export const DAISY_SAMPLE_RATE = 22050;
const GENERATOR = 'Yapper';
/**
 * Words per SMIL <par> / DTBook <p>. Caption-sized (6 words) would make a
 * 300-page book tens of thousands of pars; paragraph-sized keeps the
 * synchronization fine-grained enough to follow without bloating the SMIL.
 */
const SEGMENT_WORDS = 24;
const SEGMENT_SECONDS = 12;

export interface DaisyClip {
  text: string;
  audio: Float32Array;
  sampleRate: number;
  /** Per-word start times relative to this clip's start. */
  wordTimings?: number[];
}

export interface DaisyOptions {
  title?: string;
  /** BCP 47 tag for the book's language. */
  language?: string;
  /** The document's sections, whose offsets are into `documentText`. */
  sections?: SectionSource[];
  /** The extracted text the section offsets refer to. */
  documentText?: string;
  /** Silence between clips on the merged timeline. Default 0.35s. */
  gapSeconds?: number;
  /** Override the generated urn. Stable values matter to a library. */
  identifier?: string;
}

export interface DaisySegment {
  /** The words spoken in this span, in reading order. */
  text: string;
  /** Book time where the phrase starts. */
  startSeconds: number;
  /** Book time where the phrase ends — the next phrase's start, or the end. */
  endSeconds: number;
}

/** A phrase with the id it carries into the SMIL and the DTBook. */
export interface DaisyPlannedSegment extends DaisySegment {
  /** Unique across the book: `p<id>` in SMIL, `t<id>` in the DTBook. */
  id: number;
}

export interface DaisyChapterPlan {
  title: string;
  /** Book time where the chapter starts; its audio file begins here. */
  startSeconds: number;
  /** Book time where the chapter ends — the next chapter's start. */
  endSeconds: number;
  /** Zip paths, already relative to the archive root. */
  smilPath: string;
  audioPath: string;
  segments: DaisyPlannedSegment[];
}

export interface DaisyPlan {
  identifier: string;
  title: string;
  language: string;
  /** File name stem for the NCX and DTBook (`<base>.ncx`, `<base>.xml`). */
  base: string;
  totalSeconds: number;
  chapters: DaisyChapterPlan[];
}

export interface DaisyBook {
  zip: Blob;
  identifier: string;
  /** Navigation points in reading order. */
  chapters: { title: string; startSeconds: number }[];
  smilFiles: string[];
  audioFiles: string[];
  totalSeconds: number;
}

// ─── Small pure helpers ──────────────────────────────────────────

/**
 * XML text and attribute content.
 *
 * Characters outside XML 1.0's Char production are removed rather than
 * escaped: there is no representation for them, and document extractors do
 * emit form feeds and stray surrogates, which would make the whole book
 * unparseable. The range checks are the production itself — tab, newline and
 * carriage return, then the legal planes.
 */
function escapeXml(value: string): string {
  let clean = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x9 || code === 0xa || code === 0xd
      || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)
      || code >= 0x10000) {
      clean += char;
    }
  }
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Lower-case, ASCII, hyphenated file stem. Old players read zip entries from
 * FAT-formatted media, and a title is user text; keeping the name tame is the
 * same choice the audiobook bundle makes.
 */
function slug(text: string): string {
  const ascii = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii.slice(0, 40).replace(/-+$/, '') || 'book';
}

/** FNV-1a, 32 bits: a short deterministic suffix for the book's urn. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The book's globally unique identifier.
 *
 * Deterministic rather than random: re-exporting the same reading session must
 * not look like a different book to a bookshelf that keys on dtb:uid. The text
 * is part of the seed so two documents with the same title stay distinct.
 */
export function daisyIdentifier(title: string, clips: DaisyClip[]): string {
  const seed = [title, ...clips.map(clip => clip.text)].join('\u0000');
  return `urn:yapper:${slug(title).slice(0, 24)}-${contentHash(seed)}`;
}

/** `smil/ch-001.smil` — zero-padded so file managers sort them in reading order. */
function chapterFile(dir: string, index: number, extension: string): string {
  return `${dir}/ch-${String(index + 1).padStart(3, '0')}.${extension}`;
}

// ─── Timeline and phrases ────────────────────────────────────────

export interface DaisyTimeline {
  /** The transcript actually spoken, clips rejoined with single spaces. */
  text: string;
  wordTimings: number[];
  totalSeconds: number;
  segments: DaisySegment[];
}

/**
 * Merge the clips onto one timeline and cut that timeline into phrases.
 *
 * `mergeClipTimings` already handles the two awkward cases — a clip whose
 * engine reported no timings gets estimates, and the gap between clips is part
 * of the timeline — so this stays a thin composition rather than another
 * timing model.
 */
export function buildDaisyTimeline(clips: DaisyClip[], gapSeconds = 0.35): DaisyTimeline {
  if (!clips.length) throw new Error('buildDaisyTimeline: no clips');
  const merged = mergeClipTimings(
    clips.map(clip => ({
      text: clip.text,
      durationSeconds: clip.audio.length / clip.sampleRate,
      wordTimings: clip.wordTimings,
    })),
    gapSeconds,
  );
  const words = merged.text.match(/\S+/g) ?? [];
  if (!words.length) throw new Error('buildDaisyTimeline: no spoken text');
  const cues = buildCaptionCues(words, merged.wordTimings, merged.totalSeconds, {
    maxWords: SEGMENT_WORDS,
    maxSeconds: SEGMENT_SECONDS,
  });
  return {
    text: merged.text,
    wordTimings: merged.wordTimings,
    totalSeconds: merged.totalSeconds,
    segments: cues.map(cue => ({
      text: cue.text,
      startSeconds: cue.start,
      endSeconds: cue.end,
    })),
  };
}

/**
 * Lay the book out without touching audio or a zip: which phrases belong to
 * which chapter, where each chapter's file starts and ends, and what it is
 * called. Pure, so the structure can be asserted in tests and the async part
 * below is only encoding.
 *
 * Chapters are flat (depth 1). The document's sections can nest, but a talking
 * book player's chapter keys are a flat list in practice, and inventing a
 * hierarchy the reader never heard would be worse than a level one.
 */
export function planDaisyBook(clips: DaisyClip[], options: DaisyOptions = {}): DaisyPlan {
  if (!clips.length) throw new Error('planDaisyBook: no clips');
  const gapSeconds = options.gapSeconds ?? 0.35;
  const timeline = buildDaisyTimeline(clips, gapSeconds);
  const title = options.title?.trim() || 'Talking book';
  const located = chaptersFromSections(
    options.sections,
    options.documentText ?? '',
    timeline.text,
    timeline.wordTimings,
  );
  // No sections (or none that could be located) is still a book: one chapter,
  // which is what a player needs to open it at all.
  const chapters: Chapter[] = located.length ? located : [{ title, startSeconds: 0 }];

  // Bucket phrases by the chapter their *start* falls in. Phrases tile the
  // timeline, so the only phrase that can touch a chapter boundary ends on it.
  const buckets: DaisySegment[][] = chapters.map(() => []);
  let cursor = 0;
  for (const segment of timeline.segments) {
    while (cursor + 1 < chapters.length && segment.startSeconds >= chapters[cursor + 1].startSeconds) {
      cursor++;
    }
    buckets[cursor].push(segment);
  }

  // A chapter with no phrase has no SMIL target and no audio worth a file:
  // its time folds into the chapter before it instead of becoming an empty
  // navPoint that a player would land on in silence.
  const kept = chapters
    .map((chapter, index) => ({ chapter, segments: buckets[index] }))
    .filter(entry => entry.segments.length > 0);
  // Every phrase lands in exactly one bucket, so this is an invariant rather
  // than a case: a book with no chapter would be a file set no player opens.
  if (!kept.length) throw new Error('planDaisyBook: no phrases');

  let nextSegmentId = 1;
  const planned: DaisyChapterPlan[] = kept.map((entry, index) => {
    const startSeconds = Math.max(0, entry.chapter.startSeconds);
    const endSeconds = kept[index + 1]?.chapter.startSeconds ?? timeline.totalSeconds;
    return {
      title: entry.chapter.title,
      startSeconds,
      endSeconds,
      smilPath: chapterFile('smil', index, 'smil'),
      audioPath: chapterFile('audio', index, AUDIO_EXTENSION),
      segments: entry.segments.map(segment => ({
        ...segment,
        // Clamp defensively: a chapter starts on a word, so a phrase ending
        // at that word already stops there, but rounding must never ask a
        // chapter's file for audio it does not contain.
        endSeconds: Math.min(segment.endSeconds, endSeconds),
        id: nextSegmentId++,
      })),
    };
  });

  return {
    identifier: options.identifier?.trim() || daisyIdentifier(title, clips),
    title,
    language: options.language?.trim() || 'en',
    base: slug(title),
    totalSeconds: timeline.totalSeconds,
    chapters: planned,
  };
}

// ─── XML documents ───────────────────────────────────────────────

/**
 * One chapter's SMIL: a sequence of <par>s, each pairing a DTBook element
 * with a clip of the chapter's WAV. clipBegin/clipEnd are relative to the
 * audio file, so the first phrase starts at zero even when the chapter starts
 * hours into the book; dtb:totalElapsedTime carries the book time separately.
 * The timestamps come from the caption formatter: HH:MM:SS.mmm is also SMIL's
 * full clock value, so there is no reason for a second time formatter.
 */
export function buildDaisySmil(plan: DaisyPlan, chapterIndex: number): string {
  const chapter = plan.chapters[chapterIndex];
  if (!chapter) throw new Error(`buildDaisySmil: no chapter ${chapterIndex}`);
  const seqId = `seq${chapterIndex + 1}`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE smil PUBLIC "-//NISO//DTD dtbsmil 2005-1//EN" "http://www.daisy.org/z3986/2005/dtbsmil-2005-1.dtd">',
    `<smil xmlns="http://www.w3.org/2001/SMIL20/" xml:lang="${escapeXml(plan.language)}">`,
    '  <head>',
    `    <meta name="dtb:uid" content="${escapeXml(plan.identifier)}"/>`,
    `    <meta name="dtb:generator" content="${GENERATOR}"/>`,
    `    <meta name="dtb:totalElapsedTime" content="${formatVttTimestamp(chapter.startSeconds)}"/>`,
    '  </head>',
    '  <body>',
    `    <seq id="${seqId}">`,
  ];
  for (const segment of chapter.segments) {
    const clipBegin = Math.max(0, segment.startSeconds - chapter.startSeconds);
    const clipEnd = Math.max(clipBegin + 0.001, segment.endSeconds - chapter.startSeconds);
    lines.push(
      `      <par id="p${segment.id}">`,
      `        <text src="../${plan.base}.xml#t${segment.id}"/>`,
      `        <audio src="../${chapter.audioPath}" clipBegin="${formatVttTimestamp(clipBegin)}" clipEnd="${formatVttTimestamp(clipEnd)}"/>`,
      '      </par>',
    );
  }
  lines.push('    </seq>', '  </body>', '</smil>', '');
  return lines.join('\n');
}

/** The DTBook textual content file: full text, synchronized by smilref. */
export function buildDaisyDtbook(plan: DaisyPlan): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE dtbook PUBLIC "-//NISO//DTD dtbook 2005-1//EN" "http://www.daisy.org/z3986/2005/dtbook-2005-1.dtd">',
    `<dtbook xmlns="http://www.daisy.org/z3986/2005/dtbook/" version="2005-1" xml:lang="${escapeXml(plan.language)}">`,
    '  <head>',
    `    <meta name="dtb:uid" content="${escapeXml(plan.identifier)}"/>`,
    `    <meta name="dc:Title" content="${escapeXml(plan.title)}"/>`,
    '  </head>',
    '  <book>',
    '    <bodymatter>',
  ];
  plan.chapters.forEach((chapter, index) => {
    const seqId = `seq${index + 1}`;
    lines.push(`      <level1 id="level${index + 1}">`);
    // The heading is spoken as the chapter opens, so it points at the
    // chapter's time container rather than pretending to have its own clip.
    lines.push(
      `        <h1 id="h${index + 1}" smilref="${chapter.smilPath}#${seqId}">${escapeXml(chapter.title)}</h1>`,
    );
    for (const segment of chapter.segments) {
      lines.push(
        `        <p id="t${segment.id}" smilref="${chapter.smilPath}#p${segment.id}">${escapeXml(segment.text)}</p>`,
      );
    }
    lines.push('      </level1>');
  });
  lines.push('    </bodymatter>', '  </book>', '</dtbook>', '');
  return lines.join('\n');
}

/**
 * The NCX: every navigation point, in reading order. `playOrder` is the
 * index, which the standard requires to be 1-based and to increase by one per
 * referenced time container — our chapters are one container each.
 */
export function buildDaisyNcx(plan: DaisyPlan): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">',
    `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeXml(plan.language)}">`,
    '  <head>',
    `    <meta name="dtb:uid" content="${escapeXml(plan.identifier)}"/>`,
    `    <meta name="dtb:depth" content="1"/>`,
    `    <meta name="dtb:generator" content="${GENERATOR}"/>`,
    `    <meta name="dtb:totalPageCount" content="0"/>`,
    `    <meta name="dtb:maxPageNumber" content="0"/>`,
    '  </head>',
    '  <docTitle>',
    `    <text>${escapeXml(plan.title)}</text>`,
    '  </docTitle>',
    '  <navMap>',
  ];
  plan.chapters.forEach((chapter, index) => {
    lines.push(
      `    <navPoint id="nav${index + 1}" class="chapter" playOrder="${index + 1}">`,
      '      <navLabel>',
      `        <text>${escapeXml(chapter.title)}</text>`,
      '      </navLabel>',
      `      <content src="${chapter.smilPath}#seq${index + 1}"/>`,
      '    </navPoint>',
    );
  });
  lines.push('  </navMap>', '</ncx>', '');
  return lines.join('\n');
}

/**
 * The package file. The manifest must list every file that is part of the
 * book — this one included — and the spine is the reading order, which is why
 * it repeats the chapter order the NCX already expresses.
 */
export function buildDaisyOpf(plan: DaisyPlan): string {
  const manifest = [
    '    <item id="opf" href="package.opf" media-type="text/xml"/>',
    `    <item id="ncx" href="${plan.base}.ncx" media-type="application/x-dtbncx+xml"/>`,
    `    <item id="dtbook" href="${plan.base}.xml" media-type="application/x-dtbook+xml"/>`,
  ];
  plan.chapters.forEach((chapter, index) => {
    manifest.push(
      `    <item id="smil-${index + 1}" href="${chapter.smilPath}" media-type="application/smil"/>`,
      `    <item id="audio-${index + 1}" href="${chapter.audioPath}" media-type="${AUDIO_MEDIA_TYPE}"/>`,
    );
  });
  const spine = plan.chapters.map((_, index) => `    <itemref idref="smil-${index + 1}"/>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE package PUBLIC "+//ISBN 0-9673008-1-9//DTD OEB 1.2 Package//EN" "http://openebook.org/dtds/oeb-1.2/oebpkg12.dtd">',
    '<package xmlns="http://openebook.org/namespaces/oeb-package/1.0/" unique-identifier="uid">',
    '  <metadata>',
    '    <dc-metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `      <dc:Title>${escapeXml(plan.title)}</dc:Title>`,
    `      <dc:Identifier id="uid">${escapeXml(plan.identifier)}</dc:Identifier>`,
    `      <dc:Language>${escapeXml(plan.language)}</dc:Language>`,
    '      <dc:Format>ANSI/NISO Z39.86-2005</dc:Format>',
    '    </dc-metadata>',
    '    <x-metadata>',
    `      <meta name="dtb:multimediaType" content="audioFullText"/>`,
    `      <meta name="dtb:multimediaContent" content="audio,text"/>`,
    `      <meta name="dtb:audioFormat" content="WAV"/>`,
    `      <meta name="dtb:totalTime" content="${formatVttTimestamp(plan.totalSeconds)}"/>`,
    `      <meta name="dtb:generator" content="${GENERATOR}"/>`,
    '    </x-metadata>',
    '  </metadata>',
    '  <manifest>',
    ...manifest,
    '  </manifest>',
    '  <spine>',
    ...spine,
    '  </spine>',
    '</package>',
    '',
  ].join('\n');
}

// ─── Assembly ────────────────────────────────────────────────────

/**
 * Encode one chapter's PCM as the book's audio format.
 *
 * WAV via the engine's own writer: no dependency, mono 16-bit, and exactly the
 * MIME type the package declares. This is the single seam a permissively
 * licensed MP3 encoder would replace; see the header for why there is not one.
 */
async function encodeChapterAudio(samples: Float32Array, sampleRate: number): Promise<ArrayBuffer> {
  return float32ToWav(samples, sampleRate).arrayBuffer();
}

/**
 * Assemble the zip. The plan decides the structure; this only renders the XML
 * and cuts each chapter's audio out of the merged timeline, so the audio and
 * the SMIL cannot drift apart — both read their boundaries from the plan.
 */
export async function createDaisyBook(
  clips: DaisyClip[],
  options: DaisyOptions = {},
): Promise<DaisyBook> {
  if (!clips.length) throw new Error('createDaisyBook: no clips');
  const plan = planDaisyBook(clips, options);
  const gapSeconds = options.gapSeconds ?? 0.35;
  const merged = concatenateClips(
    clips.map(clip => ({ audio: clip.audio, sampleRate: clip.sampleRate })),
    gapSeconds,
  );
  // One resample of the assembled book, then cut: cutting first would resample
  // every chapter separately and put a seam at each chapter boundary.
  const audio = resampleClip(
    { audio: merged.audio, sampleRate: merged.sampleRate },
    DAISY_SAMPLE_RATE,
  );

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('package.opf', buildDaisyOpf(plan));
  zip.file(`${plan.base}.ncx`, buildDaisyNcx(plan));
  zip.file(`${plan.base}.xml`, buildDaisyDtbook(plan));

  for (const [index, chapter] of plan.chapters.entries()) {
    zip.file(chapter.smilPath, buildDaisySmil(plan, index));
    const samples = sliceClip(
      { audio, sampleRate: DAISY_SAMPLE_RATE },
      chapter.startSeconds,
      chapter.endSeconds,
    );
    zip.file(chapter.audioPath, await encodeChapterAudio(samples, DAISY_SAMPLE_RATE));
  }

  return {
    // DEFLATE for the same reason the audiobook uses it: the XML shrinks a
    // lot and 16-bit audio a little, and the default STORE would do neither.
    zip: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }),
    identifier: plan.identifier,
    chapters: plan.chapters.map(chapter => ({
      title: chapter.title,
      startSeconds: chapter.startSeconds,
    })),
    smilFiles: plan.chapters.map(chapter => chapter.smilPath),
    audioFiles: plan.chapters.map(chapter => chapter.audioPath),
    totalSeconds: plan.totalSeconds,
  };
}
