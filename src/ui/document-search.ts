/**
 * Text search shared by the PDF and reflowable document views.
 *
 * Regex-based on purpose: matching against the original string keeps every
 * `start` an offset into the extracted text even when case-folding changes
 * lengths (a lowercased "İ" is two characters), which a toLowerCase-index
 * search silently corrupts and every highlight downstream inherits.
 */

export interface SearchMatch {
  start: number;
  end: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /**
   * Treat the query as a regular expression instead of literal text.
   * `wholeWord` is ignored in this mode: a pattern authors its own
   * boundaries, and silently wrapping it in \b would change its meaning.
   */
  regex?: boolean;
}

export interface SearchSummary {
  matches: SearchMatch[];
  /** True when the match list stopped at `maxMatches`. */
  truncated: boolean;
  /** True when `regex` was on and the query was not a valid pattern. */
  invalid?: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find up to `maxMatches` occurrences of `query` in `text`. */
export function findMatches(
  text: string,
  query: string,
  options: SearchOptions = {},
  maxMatches = 200,
): SearchSummary {
  const needle = query.trim();
  if (!needle || !text) return { matches: [], truncated: false };
  let pattern: string;
  if (options.regex) {
    pattern = needle;
  } else {
    const escaped = escapeRegExp(needle);
    // Word boundaries only make sense next to word characters: wrapping a
    // punctuation query like "(cat" in \b can never match at all.
    const open = /^\w/.test(needle[0]) ? '\\b' : '';
    const close = /\w$/.test(needle[needle.length - 1]) ? '\\b' : '';
    pattern = options.wholeWord ? `${open}${escaped}${close}` : escaped;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.caseSensitive ? 'gu' : 'giu');
  } catch {
    return { matches: [], truncated: false, invalid: true };
  }

  const matches: SearchMatch[] = [];
  let truncated = false;
  for (const match of text.matchAll(regex)) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    // Zero-length matches cannot be highlighted or stepped through, and a
    // pattern like `a*` would otherwise report every cursor position.
    if (match[0].length === 0) continue;
    if (match.index !== undefined) {
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return { matches, truncated };
}

export interface MatchSnippet {
  before: string;
  match: string;
  after: string;
}

/** Context around a match for a results list, ellipsised at the edges. */
export function matchSnippet(text: string, match: SearchMatch, radius = 32): MatchSnippet {
  return {
    before: (match.start > radius ? '…' : '') + text.slice(Math.max(0, match.start - radius), match.start),
    match: text.slice(match.start, match.end),
    after: text.slice(match.end, match.end + radius) + (match.end + radius < text.length ? '…' : ''),
  };
}
