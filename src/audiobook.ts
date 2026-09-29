/**
 * The audiobook bundle: a reader session's generated clips, assembled into
 * one listenable artifact.
 *
 * Four files in one zip (the last two only when the document has sections):
 *   • the session's clips concatenated into a single WAV (short silence
 *     gaps between chunks, as the queue's "Download all" does),
 *   • one document-wide WebVTT built from the combined word timings, with
 *     each clip's timings shifted onto the merged timeline,
 *   • a chapter track mapping the document's sections onto that timeline,
 *   • a self-contained karaoke page playing that same audio, with chapter
 *     navigation when there are chapters.
 *
 * Assembly is async (zip + base64) but the timeline math is pure and lives
 * in word-timings.ts.
 */

import { concatenateClips } from './audio-export';
import { float32ToWav } from './engine';
import { buildWebVtt } from './captions';
import { mergeClipTimings } from './word-timings';
import { blobToBase64, buildKaraokeHtml } from './karaoke-transcript';
import { buildChapterVtt, chaptersFromSections, type Chapter, type SectionSource } from './chapters';

export interface AudiobookClip {
  text: string;
  audio: Float32Array;
  sampleRate: number;
  /** Per-word start times relative to this clip's start. */
  wordTimings?: number[];
}

export interface AudiobookBundle {
  zip: Blob;
  clipCount: number;
  totalSeconds: number;
  hasCaptions: boolean;
  /** Chapters mapped onto the merged timeline; empty when the document has none. */
  chapters: Chapter[];
}

/** File names inside the zip are user-visible; keep them tame. */
function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 60).replace(/^_+|_+$/g, '') || 'audiobook';
}

export async function createAudiobookBundle(
  clips: AudiobookClip[],
  options: {
    name?: string;
    gapSeconds?: number;
    /** The document's sections, whose offsets are into `documentText`. */
    sections?: SectionSource[];
    /** The extracted text the section offsets refer to. */
    documentText?: string;
  } = {},
): Promise<AudiobookBundle> {
  if (!clips.length) throw new Error('createAudiobookBundle: no clips');
  const gapSeconds = options.gapSeconds ?? 0.35;
  const name = safeName(options.name ?? 'audiobook');

  const merged = mergeClipTimings(clips.map(clip => ({
    text: clip.text,
    durationSeconds: clip.audio.length / clip.sampleRate,
    wordTimings: clip.wordTimings,
  })), gapSeconds);

  const combined = concatenateClips(
    clips.map(clip => ({ audio: clip.audio, sampleRate: clip.sampleRate })),
    gapSeconds,
  );
  const wav = float32ToWav(combined.audio, combined.sampleRate);
  const vtt = buildWebVtt(merged.text, merged.wordTimings, merged.totalSeconds);
  // The chapter map needs the merged transcript, so it can only be built once
  // the timeline is: sections are located in the text that was actually read.
  const chapters = chaptersFromSections(
    options.sections,
    options.documentText ?? '',
    merged.text,
    merged.wordTimings,
  );
  const chapterVtt = buildChapterVtt(chapters, merged.totalSeconds);
  const karaoke = buildKaraokeHtml({
    title: name,
    text: merged.text,
    wordTimings: merged.wordTimings,
    endSeconds: merged.totalSeconds,
    wavBase64: await blobToBase64(wav),
    chapters,
  });

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file(`${name}.wav`, await wav.arrayBuffer());
  if (vtt) zip.file(`${name}.vtt`, vtt);
  if (chapterVtt) zip.file(`${name}-chapters.vtt`, chapterVtt);
  zip.file(`${name}-karaoke.html`, karaoke);

  return {
    // DEFLATE explicitly: JSZip's default is STORE, which puts the WAV in
    // the bundle verbatim. 16-bit audio does not compress dramatically (the
    // low byte of a slow waveform is close to noise), so expect a modest
    // win rather than a dramatic one — but the karaoke page's base64 payload
    // and the caption tracks shrink well, and it costs nothing.
    zip: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }),
    clipCount: clips.length,
    totalSeconds: merged.totalSeconds,
    hasCaptions: !!vtt,
    chapters,
  };
}
