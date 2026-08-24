/**
 * Watchdog tests for document extraction (see withProgressWatchdog in
 * src/document-reader.ts). The DOMMatrix shim lives in src/test-setup.ts
 * (vitest setupFiles) because pdfjs needs it at import time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  withProgressWatchdog,
  ExtractionStalledError,
  EXTRACT_STALL_TIMEOUT_MS,
} from './document-reader';

afterEach(() => {
  vi.useRealTimers();
});

describe('withProgressWatchdog', () => {
  it('passes through the work promise result and clears the timer', async () => {
    vi.useFakeTimers();
    const work = Promise.resolve('done');
    // No caller onProgress → wrapped callback is undefined too, but the
    // watchdog still guards and resolves.
    const { promise, onProgress } = withProgressWatchdog(work, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe('done');
    expect(onProgress).toBeUndefined();
  });

  it('rejects with ExtractionStalledError when nothing settles in time', async () => {
    vi.useFakeTimers();
    const work = Promise.withResolvers<string>();
    const { promise } = withProgressWatchdog(work.promise, 1000);
    const assertion = expect(promise).rejects.toBeInstanceOf(ExtractionStalledError);
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    work.resolve('late'); // must not surface anywhere
  });

  it('a late rejection after a stall does not surface as unhandled', async () => {
    vi.useFakeTimers();
    const work = Promise.withResolvers<string>();
    const { promise } = withProgressWatchdog(work.promise, 1000);
    const assertion = expect(promise).rejects.toBeInstanceOf(ExtractionStalledError);
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    work.reject(new Error('too late'));
  });

  it('progress events reset the deadline', async () => {
    vi.useFakeTimers();
    const work = Promise.withResolvers<number>();
    const { promise, onProgress } = withProgressWatchdog(work.promise, 1000, vi.fn());
    // Keep the watchdog fed just under the deadline, four times over —
    // without resets this would have stalled after the first second.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(800);
      onProgress!(`tick ${i}`);
    }
    work.resolve(42);
    await expect(promise).resolves.toBe(42);
  });

  it('the wrapped onProgress still forwards to the caller callback', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const { onProgress } = withProgressWatchdog(
      Promise.resolve('x'), 1000,
      (msg) => { seen.push(msg); },
    );
    onProgress!('hello');
    expect(seen).toEqual(['hello']);
  });

  it('work rejection propagates unchanged and clears the timer', async () => {
    vi.useFakeTimers();
    const boom = new Error('bad pdf');
    const { promise } = withProgressWatchdog(Promise.reject(boom), 60_000);
    await expect(promise).rejects.toBe(boom);
    // No stray timer: advancing past the stall window changes nothing.
    await vi.advanceTimersByTimeAsync(120_000);
  });

  it('EXTRACT_STALL_TIMEOUT_MS is 30s', () => {
    expect(EXTRACT_STALL_TIMEOUT_MS).toBe(30_000);
  });
});
