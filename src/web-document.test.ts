import { describe, expect, it } from 'vitest';
import { extractWebDocument } from './web-document';

function htmlResponse(body: string, type = 'text/html'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': type } });
}

describe('extractWebDocument', () => {
  it('extracts readable text from an HTML page', async () => {
    const html = `<html><head><title>My Article</title><style>x{}</style></head>
      <body><nav>menu</nav><article><h1>Title</h1><p>First para.</p><p>Second   para.</p></article><footer>foot</footer></body></html>`;
    const doc = await extractWebDocument('https://x.test/a', async () => htmlResponse(html));
    expect(doc.name).toBe('My Article');
    expect(doc.text).toContain('First para.');
    expect(doc.text).toContain('Second para.');
    expect(doc.text).not.toContain('menu');
    expect(doc.text).not.toContain('foot');
  });

  it('prefers the article element over boilerplate', async () => {
    const html = `<html><body><header>hdr</header><article><p>Content.</p></article><aside>ads</aside></body></html>`;
    const doc = await extractWebDocument('https://x.test/a', async () => htmlResponse(html));
    expect(doc.text).toBe('Content.');
  });

  it('treats non-HTML responses as plain text', async () => {
    const doc = await extractWebDocument('https://x.test/a.txt',
      async () => htmlResponse('line one\n\nline two', 'text/plain'));
    expect(doc.text).toBe('line one\nline two');
    expect(doc.mimeType).toBe('text/plain');
    expect(doc.name).toBe('x.test/a.txt');
  });

  it('reports HTTP failures and network failures honestly', async () => {
    await expect(extractWebDocument('https://x.test/404',
      async () => new Response('nope', { status: 404, statusText: 'Not Found' })))
      .rejects.toThrow('404');
    await expect(extractWebDocument('https://x.test/x',
      async () => { throw new TypeError('failed to fetch'); }))
      .rejects.toThrow('could not be fetched');
  });

  it('rejects pages with no readable text', async () => {
    await expect(extractWebDocument('https://x.test/e',
      async () => htmlResponse('<html><body><script>1</script></body></html>')))
      .rejects.toThrow('No readable text');
  });
});
