import { describe, expect, it } from 'vitest';
import { createAudiobookBundle } from './audiobook';

describe('createAudiobookBundle', () => {
  it('deflates the bundle instead of storing it', async () => {
    const rate = 1000;
    // A sine, not silence: all-zero samples compress to almost nothing and
    // would make the comparison meaningless.
    const samples = Float32Array.from({ length: rate * 4 }, (_, i) =>
      Math.sin(i / 12) * 0.4);
    const bundle = await createAudiobookBundle([
      { text: 'a tone.', audio: samples, sampleRate: rate },
    ], { name: 'tone' });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bundle.zip);
    const wav = zip.file('tone.wav')!;
    // Read the member's sizes BEFORE decoding: asking for the bytes replaces
    // the compressed metadata with the decompressed data. A stored member has
    // compressedSize === uncompressedSize, so this is the direct proof that
    // the WAV went through deflate rather than being copied verbatim.
    const meta = (wav as unknown as {
      _data?: { compressedSize?: number; uncompressedSize?: number };
    })._data;
    expect(meta?.uncompressedSize).toBeGreaterThan(1000);
    expect(meta!.compressedSize!).toBeLessThan(meta!.uncompressedSize!);

    // It still round-trips: compression must not cost correctness.
    const bytes = await wav.async('uint8array');
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true))
      .toBe(bytes.length - 8);

    // The honest measure of the win: the same members re-zipped with JSZip's
    // default STORE. Deflate is worth a modest double-digit percentage here,
    // not a multiple — 16-bit audio has a high-entropy low byte.
    const stored = new JSZip();
    for (const [name, file] of Object.entries(zip.files)) {
      stored.file(name, await file.async('uint8array'));
    }
    const storedSize = (await stored.generateAsync({ type: 'blob' })).size;
    expect(bundle.zip.size).toBeLessThan(storedSize);
    expect(bundle.zip.size).toBeLessThan(storedSize * 0.9);
  });

  it('packs the merged WAV, document-wide captions, and a karaoke page', async () => {
    const rate = 100;
    const clips = [
      { text: 'one two.', audio: new Float32Array(rate * 2), sampleRate: rate, wordTimings: [0, 1] },
      { text: 'three', audio: new Float32Array(rate * 3), sampleRate: rate, wordTimings: [0.5] },
    ];
    const bundle = await createAudiobookBundle(clips, { name: 'my book', gapSeconds: 0.5 });
    expect(bundle.clipCount).toBe(2);
    // 2s + 0.5s gap + 3s — the merged WAV's real length.
    expect(bundle.totalSeconds).toBe(5.5);
    expect(bundle.hasCaptions).toBe(true);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bundle.zip);
    expect(Object.keys(zip.files).sort()).toEqual([
      'my_book-karaoke.html', 'my_book.vtt', 'my_book.wav',
    ]);

    const vtt = await zip.file('my_book.vtt')!.async('string');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    // The second clip's word lands at 2s + 0.5s gap + 0.5s = 3s on the
    // merged timeline, which is where its cue begins.
    expect(vtt).toContain('00:00:03.000');
    expect(vtt).toContain('one two.');

    const karaoke = await zip.file('my_book-karaoke.html')!.async('string');
    expect(karaoke).toContain('data:audio/wav;base64,');
    expect(karaoke).toContain('three');
    // No sections supplied, so no chapter track and no dead nav buttons.
    expect(bundle.chapters).toEqual([]);
    expect(Object.keys(zip.files)).not.toContain('my_book-chapters.vtt');
    expect(karaoke).not.toContain('chapnav');
  });

  it('adds a chapter track and chapter navigation from the document sections', async () => {
    const rate = 100;
    const clips = [
      { text: 'one two.', audio: new Float32Array(rate * 2), sampleRate: rate, wordTimings: [0, 1] },
      { text: 'three four.', audio: new Float32Array(rate * 3), sampleRate: rate, wordTimings: [0.5, 1.5] },
    ];
    const documentText = 'one two.\n\nthree four.';
    const bundle = await createAudiobookBundle(clips, {
      name: 'chapters',
      gapSeconds: 0.5,
      documentText,
      sections: [
        { title: 'One', start: 0 },
        { title: 'Two', start: documentText.indexOf('three') },
      ],
    });
    expect(bundle.chapters).toEqual([
      { title: 'One', startSeconds: 0 },
      { title: 'Two', startSeconds: 3 },
    ]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bundle.zip);
    expect(Object.keys(zip.files).sort()).toEqual([
      'chapters-chapters.vtt', 'chapters-karaoke.html', 'chapters.vtt', 'chapters.wav',
    ]);
    const chapterVtt = await zip.file('chapters-chapters.vtt')!.async('string');
    expect(chapterVtt).toContain('00:00:00.000 --> 00:00:03.000\nOne');
    expect(chapterVtt).toContain('00:00:03.000 --> 00:00:05.500\nTwo');

    const karaoke = await zip.file('chapters-karaoke.html')!.async('string');
    expect(karaoke).toContain('chapnav');
    expect(karaoke).toContain('data-t="3.000"');
  });

  it('rejects an empty session', async () => {
    await expect(createAudiobookBundle([])).rejects.toThrow(/no clips/);
  });
});
