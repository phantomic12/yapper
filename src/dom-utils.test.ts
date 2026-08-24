import { describe, it, expect, beforeEach, vi } from 'vitest';
import { showStatus, startGenerationFeedback, stopGenerationFeedback } from './dom-utils';
import { MODELS } from './engine';

describe('showStatus action button (AC1 retry affordance)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="status-container"></div>';
  });

  it('renders a clickable Retry button and wires its handler', () => {
    let clicked = false;
    showStatus('error', 'Load failed: network unreachable', true, {
      label: 'Retry',
      onClick: () => { clicked = true; },
    });

    const banner = document.querySelector('.status-banner--error')!;
    expect(banner.textContent).toContain('Load failed: network unreachable');

    const btn = document.querySelector<HTMLButtonElement>('[data-role="status-action"]')!;
    expect(btn).toBeTruthy();
    expect(btn.textContent!.trim()).toBe('Retry');

    btn.click();
    expect(clicked).toBe(true);
  });

  it('renders no button without an action', () => {
    showStatus('success', 'Model is ready.');
    expect(document.querySelector('[data-role="status-action"]')).toBeNull();
    expect(document.querySelector('.status-banner')!.textContent).toContain('Model is ready.');
  });
});

describe('generation feedback (AC4 no silent generation)', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="generation-feedback"><span id="generation-feedback-text">Generating…</span></div>';
    vi.useFakeTimers();
  });

  it('shows the indicator immediately with job counts', () => {
    startGenerationFeedback(3, 1);
    const box = document.getElementById('generation-feedback')!;
    expect(box.classList.contains('generation-feedback--visible')).toBe(true);
    expect(document.getElementById('generation-feedback-text')!.textContent)
      .toContain('1 job in progress');
  });

  it('refreshes counts while running and hides when stopped', () => {
    startGenerationFeedback(2, 1);
    // A queued sibling starts → count updates on the next tick.
    startGenerationFeedback(2, 2);
    vi.advanceTimersByTime(1000);
    expect(document.getElementById('generation-feedback-text')!.textContent)
      .toContain('2 jobs in progress');

    stopGenerationFeedback();
    expect(document.getElementById('generation-feedback')!.classList.contains('generation-feedback--visible'))
      .toBe(false);
    // Ticker is gone: advancing time must not throw or resurrect content.
    vi.advanceTimersByTime(5000);
  });

  it('is safe to stop when never started', () => {
    expect(() => stopGenerationFeedback()).not.toThrow();
  });
});

describe('main-thread model registry flag (AC2)', () => {
  it('marks SpeechT5 and MMS as main-thread, worker-backed models not', () => {
    const mainThread = MODELS.filter(m => m.runsOnMainThread).map(m => m.id);
    expect(mainThread).toContain('speecht5');
    expect(MODELS.filter(m => m.id.startsWith('mms-tts-')).every(m => m.runsOnMainThread)).toBe(true);
    // Worker-backed custom engines stay off the main thread.
    for (const id of ['kokoro-82m', 'kokoro-82m-fp16', 'kitten-nano', 'kitten-mini']) {
      expect(MODELS.find(m => m.id === id)?.runsOnMainThread ?? false).toBe(false);
    }
  });
});
