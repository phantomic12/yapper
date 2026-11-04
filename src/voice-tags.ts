/**
 * Per-section voices: let one document be read by more than one speaker.
 *
 * A tag is a character range of the extracted text plus the voice that range
 * should be spoken in — the shape a reader actually reaches for: "this
 * paragraph is dialogue", "this quote is somebody else", "this passage is in
 * another language". Ranges rather than sentence ids because a tag has to
 * survive being made from an arbitrary selection, and the document text is the
 * one coordinate system both the DOM view and the reader agree on.
 *
 * Everything here is pure: ranges in, ranges and chunk plans out. That matters
 * because the hard part is not storing a voice id — it is splitting a chunk
 * that straddles a boundary without moving a single word on the page. That
 * arithmetic is worth testing exactly, so it lives away from the DOM, the TTS
 * engine and `localStorage`.
 *
 * The chunk-splitting rule is one sentence long: **a word belongs to the
 * voice in force at the character where that word starts.** A boundary inside
 * a word therefore snaps to the next word, because cutting a word in half is
 * not something a voice can speak. Everything else — a boundary at a chunk
 * start, mid-chunk, in the whitespace between two sentences, at the very end —
 * falls out of the same rule.
 */

import type { ChunkSegment, ReaderChunk, ReaderSentence } from './reader';

/** One section of a document read in a particular voice. */
export interface VoiceTag {
  /** Stable id, so a single tag can be removed from the list. */
  id: string;
  /** First character of the section in the extracted text, inclusive. */
  start: number;
  /** One past the last character of the section. */
  end: number;
  /** Voice id from the active model's voice list (e.g. a Kokoro voice id). */
  voiceId: string;
}

/** Upper bound on stored tags; a document does not need more than this. */
export const MAX_VOICE_TAGS_PER_DOCUMENT = 200;

const VOICE_TAGS_PREFIX = 'yapper.document-voices.v1:';

/**
 * Per-document storage key, following the same file-identity convention as
 * `documentProgressKey` in `persistence.ts`: name, size and last-modified,
 * never the file's contents. Two different documents that happen to share a
 * name still get separate tags, and the tags cost a few hundred bytes rather
 * than the document itself.
 */
export function documentVoiceTagsKey(
  file: Pick<File, 'name' | 'size' | 'lastModified'>,
): string {
  return `${VOICE_TAGS_PREFIX}${encodeURIComponent(file.name)}:${file.size}:${file.lastModified}`;
}

/**
 * Drop tags that cannot mean anything, and order the rest.
 *
 * Called on everything that enters the system — hand-built UI tags, values
 * read back from storage — so no later code has to defend itself against a
 * NaN offset or an empty voice id. Sorting by start (then end) makes
 * `voiceAt` cheap and makes the UI list read in document order.
 */
export function normalizeVoiceTags(tags: readonly VoiceTag[]): VoiceTag[] {
  const seen = new Set<string>();
  return tags
    .filter(tag =>
      Number.isFinite(tag.start)
      && Number.isFinite(tag.end)
      && tag.start >= 0
      && tag.end > tag.start
      && typeof tag.voiceId === 'string'
      && tag.voiceId.trim().length > 0)
    .map(tag => ({ ...tag, voiceId: tag.voiceId.trim() }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter(tag => {
      // Duplicate ids cannot be cleared individually; keep the first, which
      // after sorting is the leftmost occurrence.
      const id = tag.id || `voice-tag-${tag.start}-${tag.end}`;
      if (seen.has(id)) return false;
      seen.add(id);
      tag.id = id;
      return true;
    });
}

/**
 * The voice in force at a character offset, if any.
 *
 * Overlapping tags are resolved in favour of the one that starts latest: a
 * narrow tag dropped inside a wide one is the more specific intent, and it is
 * also the one the user just made. Ties go to the shorter range for the same
 * reason. `undefined` means "the model's own default voice" — the absence of
 * a tag is not an error.
 */
export function voiceAt(tags: readonly VoiceTag[], offset: number): string | undefined {
  let best: VoiceTag | undefined;
  for (const tag of tags) {
    if (offset < tag.start || offset >= tag.end) continue;
    if (!best || tag.start > best.start || (tag.start === best.start && tag.end < best.end)) {
      best = tag;
    }
  }
  return best?.voiceId;
}

/**
 * Replace whatever was there with a new tag, trimming the old ranges.
 *
 * The alternative — stacking a second tag on top and letting `voiceAt` pick —
 * leaves a fringe of the old voice peeking out on both sides and looks like a
 * boundary that drifted. Here the newest tag owns its range exactly: an old
 * tag is split in two around it, shortened where it merely overlaps, and
 * dropped where it is entirely covered. Retrimmed pieces get derived ids so
 * each remains individually removable.
 */
export function applyVoiceTag(tags: readonly VoiceTag[], tag: VoiceTag): VoiceTag[] {
  if (!(tag.end > tag.start) || !tag.voiceId.trim()) return normalizeVoiceTags(tags);
  const next: VoiceTag[] = [];
  for (const existing of normalizeVoiceTags(tags)) {
    if (existing.end <= tag.start || existing.start >= tag.end) {
      next.push(existing);
      continue;
    }
    if (existing.start < tag.start) {
      next.push({ ...existing, id: `${existing.id}~l${tag.start}`, end: tag.start });
    }
    if (existing.end > tag.end) {
      next.push({ ...existing, id: `${existing.id}~r${tag.end}`, start: tag.end });
    }
  }
  next.push({ ...tag });
  return normalizeVoiceTags(next);
}

/** Remove one tag by id. */
export function removeVoiceTag(tags: readonly VoiceTag[], id: string): VoiceTag[] {
  return normalizeVoiceTags(tags.filter(tag => tag.id !== id));
}

/**
 * The character range of the paragraph holding a sentence, or null when the
 * paragraph cannot be located.
 *
 * A paragraph is several reader sentences, so its range runs from the first
 * sentence's start to the last sentence's end. Sentences without offsets are
 * skipped rather than allowed to drag the range to zero: a wrong range would
 * tag the top of the document instead of the paragraph in front of the
 * reader.
 */
export function paragraphRangeAt(
  sentences: readonly ReaderSentence[],
  sentenceIndex: number,
): { start: number; end: number } | null {
  const anchor = sentences.find(sentence => sentence.globalIndex === sentenceIndex);
  if (!anchor) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const sentence of sentences) {
    if (sentence.paragraphIndex !== anchor.paragraphIndex) continue;
    if (sentence.start === undefined || sentence.end === undefined) continue;
    start = Math.min(start, sentence.start);
    end = Math.max(end, sentence.end);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

// ─── Chunk math ────────────────────────────────────────────────────

/** Words spoken by a chunk. Segments are word windows, not whole sentences. */
export function chunkWordCount(chunk: Pick<ReaderChunk, 'segments'>): number {
  return chunk.segments.reduce((sum, segment) => sum + (segment.endWord - segment.startWord), 0);
}

/**
 * Turn a chunk-local written-word index back into a document position.
 *
 * This is the inverse of the chunk's word numbering and the reason a split
 * chunk can still highlight correctly: word 0 of the second half of a
 * sentence is not word 0 of that sentence, and only the segment's `startWord`
 * knows the difference. `null` means the index is outside the chunk, which
 * callers treat as "no highlight" rather than clamping onto a neighbour.
 */
export function chunkWordPosition(
  chunk: Pick<ReaderChunk, 'segments'>,
  writtenWordIndex: number,
): { sentenceIndex: number; wordIndex: number } | null {
  if (writtenWordIndex < 0) return null;
  let offset = 0;
  for (const segment of chunk.segments) {
    const length = segment.endWord - segment.startWord;
    if (writtenWordIndex < offset + length) {
      return {
        sentenceIndex: segment.sentence.globalIndex,
        wordIndex: segment.startWord + (writtenWordIndex - offset),
      };
    }
    offset += length;
  }
  return null;
}

/** Absolute character offset of every word in a sentence, or null if unknown. */
function sentenceWordStarts(sentence: ReaderSentence): number[] | null {
  if (sentence.start === undefined) return null;
  const starts: number[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sentence.text)) !== null) {
    starts.push(sentence.start + match.index);
  }
  // `words` and the whitespace runs of `text` are produced by the same split,
  // but a mismatch means this sentence cannot be located reliably — better to
  // leave it in the surrounding voice than to guess an offset.
  return starts.length === sentence.words.length ? starts : null;
}

interface WordSlot {
  sentence: ReaderSentence;
  wordIndex: number;
  /** Character offset where the word starts; null when unlocatable. */
  offset: number | null;
}

/**
 * Split chunks so no chunk spans two voices.
 *
 * Every word of a chunk is stamped with the voice in force where it starts,
 * and consecutive words sharing a voice become one output chunk. That single
 * pass covers every boundary the reader can throw at it:
 *
 *   • boundary at a chunk start — the whole chunk already has one voice, no
 *     split, and its `voiceId` is the new one;
 *   • boundary mid-chunk — two chunks, one on each side;
 *   • boundary mid-word — the word goes to the voice it started in, so the
 *     split lands on the next word boundary and no word is ever halved;
 *   • boundary at the end — nothing after it, so the last chunk is unchanged;
 *   • a tag over the whole document — every word shares a voice, the chunk
 *     count is identical to the untagged plan.
 *
 * The page is untouched: `text` is rebuilt from the same word tokens the
 * reader already highlights, `segments` keep each word's original sentence and
 * word index, and `sentences` still lists the sentences a chunk speaks. The
 * only thing that changes is which synthesis job reads which words.
 */
export function splitChunksByVoice(
  chunks: readonly ReaderChunk[],
  tags: readonly VoiceTag[],
): ReaderChunk[] {
  const ordered = normalizeVoiceTags(tags);
  if (!ordered.length) return chunks.map((chunk, index) => ({ ...chunk, index }));
  const startsBySentence = new Map<number, number[] | null>();
  const out: ReaderChunk[] = [];

  for (const chunk of chunks) {
    const slots: WordSlot[] = [];
    for (const segment of chunk.segments) {
      let starts = startsBySentence.get(segment.sentence.globalIndex);
      if (starts === undefined) {
        starts = sentenceWordStarts(segment.sentence);
        startsBySentence.set(segment.sentence.globalIndex, starts);
      }
      for (let word = segment.startWord; word < segment.endWord; word++) {
        slots.push({
          sentence: segment.sentence,
          wordIndex: word,
          offset: starts ? starts[word] ?? null : null,
        });
      }
    }
    if (!slots.length) {
      out.push({ ...chunk, index: out.length });
      continue;
    }

    const pieces: Array<{ voiceId?: string; slots: WordSlot[] }> = [];
    let voice: string | undefined;
    for (const slot of slots) {
      // An unlocatable word keeps the surrounding voice: with no offset there
      // is no honest way to say a boundary falls before it.
      if (slot.offset !== null) voice = voiceAt(ordered, slot.offset);
      const last = pieces[pieces.length - 1];
      if (last && last.voiceId === voice) last.slots.push(slot);
      else pieces.push({ voiceId: voice, slots: [slot] });
    }

    const whole = pieces.length === 1;
    for (const piece of pieces) {
      const segments: ChunkSegment[] = [];
      for (const slot of piece.slots) {
        const last = segments[segments.length - 1];
        if (last && last.sentence === slot.sentence) last.endWord = slot.wordIndex + 1;
        else segments.push({
          sentence: slot.sentence,
          startWord: slot.wordIndex,
          endWord: slot.wordIndex + 1,
        });
      }
      // An unsplit chunk keeps its original text byte for byte, so a document
      // with a whole-document tag is synthesized exactly as before. Split
      // pieces are rebuilt from their words — internal runs of whitespace
      // collapse to one space, which only affects what the voice hears.
      const text = whole
        ? chunk.text
        : segments.map(segment =>
          segment.startWord === 0 && segment.endWord >= segment.sentence.words.length
            ? segment.sentence.text
            : segment.sentence.words.slice(segment.startWord, segment.endWord).join(' '),
        ).join(' ');
      out.push({
        text,
        index: out.length,
        sentences: segments.map(segment => segment.sentence),
        segments,
        voiceId: piece.voiceId,
      });
    }
  }
  return out;
}

// ─── Storage (localStorage) ────────────────────────────────────────
// Best-effort, like everything in `persistence.ts`: a private browser or a
// full quota must lose the tags, not the reading session.

export function loadVoiceTags(key: string): VoiceTag[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return [];
    return normalizeVoiceTags(values.slice(0, MAX_VOICE_TAGS_PER_DOCUMENT).flatMap((value, index) => {
      const entry = value as Partial<VoiceTag>;
      if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end)) return [];
      if ((entry.start ?? -1) < 0 || (entry.end ?? -1) <= (entry.start ?? Infinity)) return [];
      if (typeof entry.voiceId !== 'string' || !entry.voiceId.trim()) return [];
      return [{
        id: typeof entry.id === 'string' && entry.id ? entry.id : `voice-tag-${index}`,
        start: entry.start!,
        end: entry.end!,
        voiceId: entry.voiceId,
      }];
    }));
  } catch {
    return [];
  }
}

export function saveVoiceTags(key: string, tags: readonly VoiceTag[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(normalizeVoiceTags(tags).slice(0, MAX_VOICE_TAGS_PER_DOCUMENT)));
  } catch {
    // Best-effort: a blocked/full store must not interrupt reading.
  }
}
