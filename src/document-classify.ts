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
// ─── Block rendering ──────────────────────────────────────────────
// A classified block rendered as a flat <div> of escaped text throws away
// the structure the classifier just worked out: a table becomes an
// unreadable run of pipes, code loses its indentation, a list loses its
// bullets. These builders turn a block into the markup its kind deserves.
//
// They return HTML *strings* and escape every piece of document text, so
// the one rule is: never interpolate raw block text. Kept here, next to
// the classifier, because the two must agree on what a table looks like.

/** Escape for HTML text content. Mirrors dom-utils.escapeHtml. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Rows/columns beyond this are dropped so a 5000-line table cannot hang the page. */
export const MAX_TABLE_ROWS = 40;
export const MAX_TABLE_COLS = 12;

/**
 * Split a tabular block into rows of cells.
 *
 * Handles the three shapes extraction actually produces: markdown pipes
 * (`a | b`), separator rows (`---|---`, dropped), and column-aligned
 * whitespace runs. Returns an empty array when there is no consistent
 * second column, so the caller can fall back to plain text rather than
 * render a one-column "table".
 */
export function parseTableRows(text: string): string[][] {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    // Drop markdown separator rows: |---|---|, ---|---, | :-- | --: |
    .filter(l => !/^[\s|:-]+$/.test(l));
  if (lines.length < 2) return [];

  const rows = lines.map((line) => {
    if (line.includes('|')) {
      return line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map(c => c.trim());
    }
    return line.split(/\s{2,}/).map(c => c.trim());
  });

  // Clamp before padding, otherwise the ragged-row padding below would
  // immediately re-expand the row past the cap.
  const maxCols = Math.min(Math.max(...rows.map(r => r.length)), MAX_TABLE_COLS);
  // A single column is not a table — it is a paragraph that happened to be
  // classified loosely (e.g. two short lines of prose).
  if (maxCols < 2) return [];
  return rows.map(r => {
    const padded = r.slice(0, maxCols);
    while (padded.length < maxCols) padded.push('');
    return padded;
  });
}

export interface RenderBlockOptions {
  /** Truncate the block's text to this many characters first. */
  maxChars?: number;
}

/**
 * Markup for a classified block's body. Every branch escapes the text, and
 * a kind we don't special-case degrades to a plain paragraph rather than
 * dropping content.
 */
export function renderBlockHtml(
  kind: BlockKind,
  text: string,
  options: RenderBlockOptions = {},
): string {
  const maxChars = options.maxChars ?? 0;
  let body = text;
  if (maxChars > 0 && body.length > maxChars) {
    // Ellipsis goes on the text itself so every branch below inherits it.
    body = body.slice(0, maxChars).trimEnd() + '…';
  }

  switch (kind) {
    case 'table': {
      const rows = parseTableRows(body);
      if (rows.length === 0) return `<p>${esc(body)}</p>`;
      const [head, ...rest] = rows;
      const th = head.map(c => `<th scope="col">${esc(c)}</th>`).join('');
      const tb = rest
        .slice(0, MAX_TABLE_ROWS)
        .map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('');
      const hidden = rest.length > MAX_TABLE_ROWS
        ? `<p class="classify-table-more">${rest.length - MAX_TABLE_ROWS} more rows not shown</p>`
        : '';
      return `<table class="classify-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>${hidden}`;
    }
    case 'code': {
      // Strip a leading ``` fence so the marker isn't shown as content,
      // and keep whitespace exactly.
      const unfenced = body.replace(/^```[a-zA-Z0-9]*\n?/, '').replace(/```\s*$/, '');
      return `<pre class="classify-code"><code>${esc(unfenced)}</code></pre>`;
    }
    case 'quote':
      return `<blockquote class="classify-quote">${esc(body)}</blockquote>`;
    case 'list': {
      const items = body
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        // Drop the bullet/number marker: the <li> supplies it visually, and
        // leaving it in doubles the glyph.
        .map(l => l.replace(/^\s*([-*•·–]|\d+[.)])\s+/, ''));
      return `<ul class="classify-list">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    }
    case 'heading': {
      const text_ = esc(body.replace(/^#+\s*/, ''));
      return `<h4 class="classify-heading">${text_}</h4>`;
    }
    case 'paragraph':
    default:
      return `<p class="classify-paragraph">${esc(body)}</p>`;
  }
}

export function countKinds(blocks: ClassifiedBlock[]): Record<BlockKind, number> {
  const counts: Record<BlockKind, number> = {
    heading: 0, paragraph: 0, list: 0, quote: 0, code: 0, table: 0,
  };
  for (const b of blocks) counts[b.kind]++;
  return counts;
}
