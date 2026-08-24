import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { formatGeneratingHint, formatQueuePosition, updateJobCardProgress } from './job-queue';

// ─── Pure formatters ─────────────────────────────────────────────

describe('formatQueuePosition', () => {
  it('labels position 1 as next up', () => {
    expect(formatQueuePosition(1)).toBe('Next up');
  });

  it('uses st/nd/rd/th suffixes correctly', () => {
    expect(formatQueuePosition(2)).toBe('2nd in queue');
    expect(formatQueuePosition(3)).toBe('3rd in queue');
    expect(formatQueuePosition(4)).toBe('4th in queue');
    expect(formatQueuePosition(11)).toBe('11th in queue');
    expect(formatQueuePosition(12)).toBe('12th in queue');
    expect(formatQueuePosition(13)).toBe('13th in queue');
    expect(formatQueuePosition(21)).toBe('21st in queue');
    expect(formatQueuePosition(22)).toBe('22nd in queue');
    expect(formatQueuePosition(23)).toBe('23rd in queue');
    expect(formatQueuePosition(101)).toBe('101st in queue');
    expect(formatQueuePosition(111)).toBe('111th in queue');
  });
});

describe('formatGeneratingHint', () => {
  const base = { phase: 'synthesizing' as const };

  it('shows the timer with no segment info', () => {
    expect(formatGeneratingHint(base, 1500)).toBe('Generating… 1.5s');
  });

  it('shows determinate sentence counts when the total is known', () => {
    expect(formatGeneratingHint({ ...base, segmentsDone: 2, segmentsTotal: 5 }, 3000))
      .toBe('Generating… sentence 2/5 · 3.0s');
  });

  it('shows a running sentence count for unknown totals once multi-segment', () => {
    expect(formatGeneratingHint({ ...base, segmentsDone: 3 }, 4200))
      .toBe('Generating… 3 sentences · 4.2s');
  });

  it('hides the running count until at least 2 sentences are done', () => {
    // 1/N without a total is indistinguishable from noise; keep bare timer.
    expect(formatGeneratingHint({ ...base, segmentsDone: 1 }, 900))
      .toBe('Generating… 0.9s');
  });

  it('labels the phonemizing phase', () => {
    expect(formatGeneratingHint({ phase: 'phonemizing' }, 200))
      .toBe('Writing phonemes… 0.2s');
  });

  it('never produces negative elapsed times', () => {
    expect(formatGeneratingHint(base, -50)).toBe('Generating… 0.0s');
  });
});

// ─── DOM updates (hint node only — no body re-render) ──────────────

describe('updateJobCardProgress', () => {
  let card: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    card = document.createElement('div');
    card.className = 'job-card job-card--generating';
    card.dataset.jobId = 'job-7';
    card.innerHTML = `
      <div class="job-card__body">
        <div class="job-progress" data-role="job-progress" data-mode="indeterminate"><div class="job-progress__fill"></div></div>
        <div class="job-card__hint" data-role="job-hint">Generating… 0.0s</div>
        <button data-action="cancel" data-wired="true">×</button>
      </div>`;
    document.body.appendChild(card);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('updates only the hint text on heartbeat ticks', () => {
    updateJobCardProgress('job-7', {
      jobId: 'job-7', status: 'generating', phase: 'synthesizing', elapsedMs: 2500,
    });
    expect(card.querySelector('[data-role="job-hint"]')!.textContent).toBe('Generating… 2.5s');
    // No structural change: same nodes, no re-render. The cancel button's
    // wiring marker is untouched (a body re-render would have replaced it).
    expect(card.querySelectorAll('[data-role]')).toHaveLength(2);
    expect(card.querySelector('[data-action="cancel"]')!.getAttribute('data-wired')).toBe('true');
    // The progress bar node is the exact same element (not a replacement).
    const bar = card.querySelector('[data-role="job-progress"]')!;
    expect(card.querySelector('.job-card__body')!.contains(bar)).toBe(true);
  });

  it('flips to determinate mode and sets width when totals are known', () => {
    updateJobCardProgress('job-7', {
      jobId: 'job-7', status: 'generating', phase: 'synthesizing',
      elapsedMs: 1000, segmentsDone: 2, segmentsTotal: 5,
    });
    const bar = card.querySelector('[data-role="job-progress"]')!;
    expect(bar.getAttribute('data-mode')).toBe('determinate');
    expect(bar.firstElementChild!.getAttribute('style')).toContain('40%');
  });

  it('ignores progress for jobs whose card is gone', () => {
    expect(() => updateJobCardProgress('job-missing', {
      jobId: 'job-missing', status: 'generating', phase: 'synthesizing', elapsedMs: 1,
    })).not.toThrow();
  });

  it('does not touch unrelated cards', () => {
    const other = document.createElement('div');
    other.className = 'job-card job-card--pending';
    other.dataset.jobId = 'job-8';
    other.innerHTML = '<div class="job-card__hint" data-role="job-hint">2nd in queue</div>';
    document.body.appendChild(other);

    updateJobCardProgress('job-7', {
      jobId: 'job-7', status: 'generating', phase: 'synthesizing', elapsedMs: 5000,
    });
    expect(other.querySelector('[data-role="job-hint"]')!.textContent).toBe('2nd in queue');
  });
});
