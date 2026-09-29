/**
 * A self-contained karaoke transcript: one HTML file that plays the clip and
 * moves a word-by-word highlight over its text.
 *
 * Everything lives inside the file — audio as a data URL, timings as data
 * attributes, styling and logic inline — so it works from a downloads
 * folder, an email attachment, or a shared drive with no server and no build
 * step. Word text and title are escaped: the transcript must never execute
 * anything the document contained.
 */

import { timedWords } from './word-timings';
import type { Chapter } from './chapters';

/** Blob → base64, chunked so large clips never hit call-stack limits. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** mm:ss, the form a chapter list and an audiobook player both use. */
function formatStamp(seconds: number): string {
  const total = isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

const CHAPTER_STYLE = `  .chapnav { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; }
  .chapnav button { font: inherit; padding: 4px 10px; border: 1px solid #ccc;
    background: #fff; border-radius: 6px; cursor: pointer; }
  .chapnav button:disabled { opacity: 0.4; cursor: default; }
  .chapnav .name { flex: 1; color: #444; text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chaplist { list-style: none; margin: 14px 0 0; padding: 0; border-top: 1px solid #eee; }
  .chaplist li { border-bottom: 1px solid #eee; }
  .chaplist button { font: inherit; text-align: left; width: 100%; padding: 6px 2px;
    background: none; border: 0; cursor: pointer; color: #333; }
  .chaplist li.now button { color: #000; font-weight: 600; }
  .chaplist .ts { color: #888; margin-right: 8px; font-variant-numeric: tabular-nums; }`;

/**
 * Chapter navigation markup plus the script that drives it, or empty strings
 * when there are no chapters — a transcript of one document should not carry
 * dead buttons.
 *
 * Times go in as data attributes rather than a JSON blob so the page stays
 * readable, and titles stay escaped: a chapter title is document content.
 */
function buildChapterNav(chapters: Chapter[]): { style: string; html: string; script: string } {
  // A transcript of a single document should carry no dead markup: the
  // controls, their styles, and their script all arrive together or not at all.
  if (chapters.length < 1) return { style: '', html: '', script: '' };
  const items = chapters.map((chapter, index) =>
    `<li data-i="${index}"><button type="button" data-t="${chapter.startSeconds.toFixed(3)}">`
    + `<span class="ts">${formatStamp(chapter.startSeconds)}</span>`
    + `<span class="t">${escapeHtmlText(chapter.title)}</span></button></li>`)
    .join('');
  const html = `<div class="chapnav" id="cn">`
    + '<button type="button" id="prev">&#8592; Prev</button>'
    + '<span class="name" id="cname"></span>'
    + '<button type="button" id="next">Next &#8594;</button>'
    + `</div><ul class="chaplist" id="cl">${items}</ul>`;
  const script = `
  var list = document.getElementById('cl');
  if (list) {
    var entries = Array.prototype.slice.call(list.querySelectorAll('button'));
    var titles = Array.prototype.slice.call(list.querySelectorAll('.t'));
    var times = entries.map(function (b) { return parseFloat(b.dataset.t); });
    var name = document.getElementById('cname');
    var prev = document.getElementById('prev');
    var next = document.getElementById('next');
    var current = -1;
    function seek(i) {
      if (i < 0 || i >= times.length) return;
      audio.currentTime = times[i];
      audio.play();
    }
    // Latest chapter at or before the playhead: a binary search, same
    // reasoning as the word highlight above.
    function chapterAt(t) {
      var lo = 0, hi = times.length - 1, best = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (times[mid] <= t) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best;
    }
    function syncChapters() {
      var i = chapterAt(audio.currentTime);
      if (i === current) return;
      current = i;
      name.textContent = titles[i] ? titles[i].textContent : '';
      for (var k = 0; k < entries.length; k++) {
        entries[k].parentNode.className = k === i ? 'now' : '';
      }
      prev.disabled = i <= 0;
      next.disabled = i >= times.length - 1;
    }
    prev.addEventListener('click', function () { seek(chapterAt(audio.currentTime) - 1); });
    next.addEventListener('click', function () { seek(chapterAt(audio.currentTime) + 1); });
    entries.forEach(function (b, i) {
      b.addEventListener('click', function () { seek(i); });
    });
    audio.addEventListener('timeupdate', syncChapters);
    audio.addEventListener('seeked', syncChapters);
    syncChapters();
  }`;
  return { style: CHAPTER_STYLE, html, script };
}

export interface KaraokeHtmlOptions {
  title: string;
  text: string;
  /** Per-word start times in seconds. */
  wordTimings: number[];
  /** Clip length in seconds; closes the last word. */
  endSeconds: number;
  /** The clip's audio, base64-encoded WAV. */
  wavBase64: string;
  /** Chapter markers on this clip's timeline; omit for a plain transcript. */
  chapters?: Chapter[];
}

export function buildKaraokeHtml(options: KaraokeHtmlOptions): string {
  const words = timedWords(options.text, options.wordTimings, options.endSeconds);
  const spans = words.map(word =>
    `<span class="w" data-s="${word.start.toFixed(3)}" data-e="${word.end.toFixed(3)}">${escapeHtmlText(word.text)}</span>`)
    .join(' ');
  const nav = buildChapterNav(options.chapters ?? []);
  const navStyle = nav.style;
  const navHtml = nav.html;
  const navScript = nav.script;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtmlText(options.title)} — karaoke</title>
<style>
  body { font: 1.1rem/1.9 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; color: #555; }
  audio { width: 100%; position: sticky; top: 0; background: #fff; padding: 8px 0; }
  .w { border-radius: 4px; cursor: pointer; transition: background 0.12s; }
  .w.past { color: #888; }
  .w.now { background: #ffe27a; color: #000; }
${navStyle}
</style>
</head>
<body>
<h1>${escapeHtmlText(options.title)}</h1>
<audio id="a" controls src="data:audio/wav;base64,${options.wavBase64}"></audio>
${navHtml}
<p id="t">${spans}</p>
<script>
(function () {
  var audio = document.getElementById('a');
  var spans = Array.prototype.slice.call(document.querySelectorAll('#t .w'));
  var last = -1;
  function pick(t) {
    var lo = 0, hi = spans.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (parseFloat(spans[mid].dataset.s) <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }
  function paint() {
    var i = pick(audio.currentTime);
    if (i === last) return;
    for (var k = 0; k < spans.length; k++) {
      spans[k].className = 'w' + (k < i ? ' past' : k === i ? ' now' : '');
    }
    last = i;
    if (i >= 0) spans[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  audio.addEventListener('timeupdate', paint);
  spans.forEach(function (span) {
    span.addEventListener('click', function () {
      audio.currentTime = parseFloat(span.dataset.s);
      audio.play();
    });
  });
${navScript}
})();
</script>
</body>
</html>
`;
}
