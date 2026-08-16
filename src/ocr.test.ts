import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const terminate = vi.fn(async () => undefined);
const recognize = vi.fn(async () => ({
  data: {
    text: 'hello from tesseract',
    words: [
      {
        text: 'hello',
        bbox: { x0: 1, y0: 2, x1: 3, y1: 4 },
        confidence: 90,
      },
    ],
  },
}));

const createWorker = vi.fn(async () => ({
  recognize,
  terminate,
}));

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorker(...args),
}));

describe('OcrEngine', () => {
  beforeEach(() => {
    recognize.mockClear();
    terminate.mockClear();
    createWorker.mockClear();
  });

  afterEach(async () => {
    const { disposeAllOcrEngines } = await import('./ocr');
    await disposeAllOcrEngines();
    vi.resetModules();
  });

  it('createWorker is called with self-hosted asset paths (no CDN)', async () => {
    const { getOcrEngine } = await import('./ocr');
    const engine = getOcrEngine('eng');
    await engine.load();

    expect(createWorker).toHaveBeenCalledTimes(1);
    const [lang, oem, opts] = createWorker.mock.calls[0];
    expect(lang).toBe('eng');
    expect(oem).toBe(1);
    expect(opts.workerPath).toMatch(/lib\/tesseract\/worker\.min\.js$/);
    expect(opts.corePath).toMatch(/lib\/tesseract\/core$/);
    expect(opts.langPath).toMatch(/lib\/tesseract\/lang$/);
    expect(opts.gzip).toBe(false);
  });

  it('load is single-flight / idempotent', async () => {
    const { getOcrEngine } = await import('./ocr');
    const engine = getOcrEngine('eng');
    await Promise.all([engine.load(), engine.load(), engine.load()]);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('recognize returns text from the worker', async () => {
    const { getOcrEngine } = await import('./ocr');
    const engine = getOcrEngine('eng');
    const result = await engine.recognize(new Blob(['x']));
    expect(result.text).toBe('hello from tesseract');
    expect(result.words).toBeUndefined();
    expect(recognize).toHaveBeenCalled();
  });

  it('recognize returns word boxes when includeWords is set', async () => {
    const { getOcrEngine } = await import('./ocr');
    const engine = getOcrEngine('eng');
    const result = await engine.recognize(new Blob(['x']), { includeWords: true });
    expect(result.text).toBe('hello from tesseract');
    expect(result.words).toHaveLength(1);
    expect(result.words![0].text).toBe('hello');
    expect(result.words![0].bbox).toEqual({ x0: 1, y0: 2, x1: 3, y1: 4 });
  });

  it('getOcrEngine reuses one instance per language', async () => {
    const { getOcrEngine } = await import('./ocr');
    const a = getOcrEngine('eng');
    const b = getOcrEngine('eng');
    const c = getOcrEngine('deu');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('disposeAllOcrEngines terminates workers and clears the cache', async () => {
    const { getOcrEngine, disposeAllOcrEngines } = await import('./ocr');
    const engine = getOcrEngine('eng');
    await engine.load();
    await disposeAllOcrEngines();
    expect(terminate).toHaveBeenCalled();

    // Next get creates a fresh engine; load hits createWorker again.
    const again = getOcrEngine('eng');
    await again.load();
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it('forwards progress callbacks around recognize', async () => {
    const { getOcrEngine } = await import('./ocr');
    const engine = getOcrEngine('eng');
    const events: Array<{ status: string; progress: number }> = [];
    await engine.recognize(new Blob(['x']), {
      onProgress: (p) => events.push(p),
    });
    expect(events[0]).toEqual({ status: 'recognizing text', progress: 0 });
    expect(events.at(-1)).toEqual({ status: 'done', progress: 1 });
  });
});
