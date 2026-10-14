/**
 * Read-the-web: open a URL as a document.
 *
 * The page is fetched straight from its origin — same privacy rule as
 * the rest of the app: the text goes into the local reader and nowhere
 * else. Cross-origin pages that refuse to be read (CORS) surface as an
 * honest error rather than a silently empty document.
 */

import type { ExtractedDocument } from './document-reader';

/** Elements that are never content worth reading aloud. */
const STRIP_SELECTOR = 'script, style, noscript, iframe, svg, template, nav, header, footer, aside, form';

function collapseWhitespace(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Readable title for the document chip: page title, else the URL. */
function documentName(parsed: Document | null, url: string): string {
  const title = parsed?.querySelector('title')?.textContent?.trim();
  if (title) return title;
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * Fetch `url` and produce an ExtractedDocument. HTML pages are reduced
 * to their readable text (article/body minus boilerplate elements);
 * everything else is taken as plain text. `fetchImpl` is injectable
 * for tests.
 */
export async function extractWebDocument(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtractedDocument> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch {
    throw new Error(
      'The page could not be fetched — the site may block cross-origin reads, or the network may be offline.',
    );
  }
  if (!response.ok) {
    throw new Error(`The site answered ${response.status} ${response.statusText || '— nothing to read'}.`);
  }
  const type = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (!body.trim()) throw new Error('The page was empty.');

  if (type.includes('html')) {
    const parsed = new DOMParser().parseFromString(body, 'text/html');
    parsed.querySelectorAll(STRIP_SELECTOR).forEach(el => el.remove());
    const article = parsed.querySelector('article')
      ?? parsed.querySelector('main')
      ?? parsed.body;
    const text = collapseWhitespace(article?.textContent ?? '');
    if (!text) throw new Error('No readable text found on that page.');
    return {
      text,
      mimeType: 'text/html',
      name: documentName(parsed, url),
    };
  }

  const text = collapseWhitespace(body);
  if (!text) throw new Error('No readable text found in that response.');
  return {
    text,
    mimeType: 'text/plain',
    name: documentName(null, url),
  };
}
