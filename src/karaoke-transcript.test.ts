import { describe, expect, it } from 'vitest';
import { blobToBase64, buildKaraokeHtml } from './karaoke-transcript';

describe('blobToBase64', () => {
  it('encodes bytes as base64', async () => {
    const blob = new Blob([new Uint8Array([72, 105])]);
    expect(await blobToBase64(blob)).toBe('SGk=');
  });
});

describe('buildKaraokeHtml', () => {
  const html = buildKaraokeHtml({
    title: 'My clip',
    text: 'Hello brave new world',
    wordTimings: [0, 0.5, 1.0, 2.0],
    endSeconds: 3,
    wavBase64: 'AAAA',
  });

  it('is a complete standalone document with the audio embedded', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('src="data:audio/wav;base64,AAAA"');
    expect(html).toContain('<script>');
    expect(html).toContain('timeupdate');
  });

  it('stamps every word with its timing span', () => {
    expect(html).toContain('data-s="0.000" data-e="0.500">Hello</span>');
    expect(html).toContain('data-s="2.000" data-e="3.000">world</span>');
    expect(html.match(/class="w"/g)).toHaveLength(4);
  });

  it('escapes title and words so the transcript cannot execute content', () => {
    const hostile = buildKaraokeHtml({
      title: '<script>alert(1)</script>',
      text: '<img src=x onerror=alert(1)> <b>bold</b>',
      wordTimings: [0, 1, 2],
      endSeconds: 3,
      wavBase64: 'AAAA',
    });
    expect(hostile).not.toContain('<script>alert(1)');
    expect(hostile).not.toContain('<img');
    expect(hostile).toContain('&lt;img');
  });

  it('lets a click on a word seek the audio', () => {
    expect(html).toContain('audio.currentTime = parseFloat(span.dataset.s)');
  });

  it('omits chapter navigation when there are no chapters', () => {
    expect(html).not.toContain('chapnav');
  });
});

describe('buildKaraokeHtml with chapters', () => {
  const html = buildKaraokeHtml({
    title: 'Book',
    text: 'Hello brave new world',
    wordTimings: [0, 0.5, 1.0, 2.0],
    endSeconds: 3,
    wavBase64: 'AAAA',
    chapters: [
      { title: 'One', startSeconds: 0 },
      { title: 'Two', startSeconds: 1 },
    ],
  });

  it('lists every chapter with its timestamp', () => {
    expect(html).toContain('id="prev"');
    expect(html).toContain('id="next"');
    expect(html).toContain('data-t="0.000"><span class="ts">00:00</span><span class="t">One</span>');
    expect(html).toContain('data-t="1.000"><span class="ts">00:01</span><span class="t">Two</span>');
  });

  it('follows the playhead and seeks to the chosen chapter', () => {
    expect(html).toContain('audio.addEventListener(\'timeupdate\', syncChapters)');
    expect(html).toContain('function chapterAt(t)');
    expect(html).toContain('audio.currentTime = times[i]');
  });

  it('escapes chapter titles so a heading cannot inject markup', () => {
    const hostile = buildKaraokeHtml({
      title: 'Book',
      text: 'Hello',
      wordTimings: [0],
      endSeconds: 1,
      wavBase64: 'AAAA',
      chapters: [{ title: '<script>alert(1)</script>', startSeconds: 0 }],
    });
    expect(hostile).not.toContain('<script>alert(1)');
    expect(hostile).toContain('&lt;script&gt;');
  });
});
