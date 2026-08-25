import { describe, it, expect } from 'vitest';
import {
  engineSupportsPdfJs,
  pdfUnsupportedMessage,
  MIN_PDF_ENGINE_CHROME,
} from './pdf-capability';

describe('engineSupportsPdfJs', () => {
  it('returns true on engines with Promise.try (Node ≥24, Chrome ≥128)', () => {
    // The vitest runner itself needs Promise.try-free Node OR modern Node;
    // assert the function agrees with a direct probe of the same global.
    const direct = typeof (Promise as unknown as { try?: unknown }).try === 'function';
    expect(engineSupportsPdfJs()).toBe(direct);
  });

  it('is consistent: gate true ⟺ Promise.try is callable', () => {
    const direct = typeof (Promise as { try?: unknown }).try === 'function';
    expect(engineSupportsPdfJs()).toBe(direct);
  });
});

describe('pdfUnsupportedMessage', () => {
  it('names the minimum Chrome version', () => {
    expect(pdfUnsupportedMessage()).toContain(String(MIN_PDF_ENGINE_CHROME));
  });

  it('mentions PDF and suggests an alternative format', () => {
    const msg = pdfUnsupportedMessage();
    expect(msg).toMatch(/PDF/i);
    expect(msg).toMatch(/TXT|DOCX/);
  });
});
