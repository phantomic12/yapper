// ─── Document block classification ───────────────────────────────
// Pure heuristics that label extracted document blocks by kind so the
// Document Reader page can present structure (headings, lists, quotes…)
// instead of a wall of text. No DOM, no OCR deps — unit-testable.

import type { LayoutBlock } from './document-reader';

export type BlockKind = 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'table';

export interface ClassifiedBlock {
  kind: BlockKind;
  text: string;
  /** 1-based page number for PDF/OCR blocks. */
  page?: number;
}

const KIND_LABELS: Record<BlockKind, string> = {
  heading: 'Heading',
  paragraph: 'Paragraph',
  list: 'List',
  quote: 'Quote',
  code: 'Code',
  table: 'Table',
};

export function kindLabel(kind: BlockKind): string {
  return KIND_LABELS[kind];
}

/**
 * Classify a single block of text. Order matters: the more specific
 * shapes (code, table, quote, list) are tested before the loose
 * heading/paragraph distinction.
 */
export function classifyBlockText(text: string): BlockKind {
  const trimmed = text.trim();
  if (!trimmed) return 'paragraph';
  const lines = trimmed.split('\n');

  // Code: fenced markdown, or most lines indented / brace-heavy.
  if (trimmed.startsWith('```') || trimmed.startsWith('    ')) return 'code';
  const indented = lines.filter(l => /^\s{4,}\S/.test(l)).length;
  const braced = lines.filter(l => /[{};]\s*$/.test(l)).length;
  if (lines.length >= 2 && (indented >= lines.length / 2 || braced >= lines.length / 2)) {
    return 'code';
  }

  // Table: pipes or 2+ column-aligned gaps on several lines.
  const piped = lines.filter(l => /\|/.test(l)).length;
  const spaced = lines.filter(l => /\S\s{2,}\S/.test(l)).length;
  if (lines.length >= 2 && (piped >= lines.length / 2 || spaced >= Math.max(2, lines.length / 2))) {
    return 'table';
  }

  // Quote: markdown/copy-quote markers.
  if (/^(>|"|“|”|'|‘)/.test(trimmed)) return 'quote';

  // List: bullet or numbered first line.
  if (/^\s*([-*•·–]|\d+[.)])\s+\S/.test(lines[0])) return 'list';

  // Heading: short, few words, and no sentence-final punctuation —
  // optionally marked up (#) or ending in a colon.
  const words = trimmed.split(/\s+/);
  const stripped = trimmed.replace(/^#+\s*/, '');
  const endsLikeSentence = /[.!?。！？…][)"'”’]?$/.test(stripped);
  if (
    stripped.length <= 80 &&
    words.length <= 10 &&
    !endsLikeSentence &&
    (
      /^#+\s/.test(trimmed) ||
      /:$/.test(stripped) ||
      stripped === stripped.toUpperCase() ||
      words.every(w => w.length <= 1 || /^[A-Z0-9]/.test(w))
    )
  ) {
    return 'heading';
  }

  return 'paragraph';
}

/**
 * Classify plain text: split into paragraph blocks (blank-line separated)
 * and classify each.
 */
export function classifyText(text: string): ClassifiedBlock[] {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => ({ kind: classifyBlockText(p), text: p }));
}

/**
 * Classify OCR layout blocks. Text heuristics first, with one geometry
 * hint: a short block narrower than most of its page, sitting high on
 * the page, is likely a heading even if it ends in punctuation.
 */
export function classifyLayoutBlocks(blocks: LayoutBlock[]): ClassifiedBlock[] {
  const maxWidthByPage = new Map<number, number>();
  for (const b of blocks) {
    maxWidthByPage.set(b.page, Math.max(maxWidthByPage.get(b.page) ?? 0, b.x + b.width));
  }
  return blocks.map(b => {
    let kind = classifyBlockText(b.text);
    const pageWidth = maxWidthByPage.get(b.page) ?? 0;
    if (
      kind === 'paragraph' &&
      b.text.trim().length <= 60 &&
      pageWidth > 0 &&
      b.width < pageWidth * 0.6
    ) {
      kind = 'heading';
    }
    return { kind, text: b.text, page: b.page };
  });
}

/** Count blocks per kind (for the stats chips). */
export function countKinds(blocks: ClassifiedBlock[]): Record<BlockKind, number> {
  const counts: Record<BlockKind, number> = {
    heading: 0, paragraph: 0, list: 0, quote: 0, code: 0, table: 0,
  };
  for (const b of blocks) counts[b.kind]++;
  return counts;
}
