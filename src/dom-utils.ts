/** Shared DOM helpers used by UI modules. */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An actionable button rendered inside a status banner (e.g. "Retry"). */
export interface StatusAction {
  /** Short button label, e.g. "Retry". */
  label: string;
  /** Invoked when the button is clicked. */
  onClick: () => void;
}

export function showStatus(
  type: 'success' | 'error',
  message: string,
  assertive = false,
  action?: StatusAction,
) {
  const container = document.getElementById('status-container')!;
  const icon = type === 'success'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="17"/></svg>`;

  const actionHtml = action
    ? `<button type="button" class="status-banner__action" data-role="status-action">${escapeHtml(action.label)}</button>`
    : '';

  container.innerHTML = `<div class="status-banner status-banner--${type}" role="${assertive ? 'alert' : 'status'}" aria-live="${assertive ? 'assertive' : 'polite'}">${icon}<span class="status-banner__message">${escapeHtml(message)}</span>${actionHtml}</div>`;

  if (action) {
    container
      .querySelector<HTMLButtonElement>('[data-role="status-action"]')
      ?.addEventListener('click', action.onClick);
  }
}

// ─── Generation liveness feedback ────────────────────────────────
// Acceptance criterion: no silent state longer than 5s during generate.
// Worker-backed models stream results without freezing anything, but
// SpeechT5/MMS hold the main thread for the whole synthesis, which can
// starve timers mid-generation. We therefore show a pulsing indicator the
// moment any job starts generating (before the potentially-blocking work),
// and tear it down as soon as no job is generating anymore. Even when
// timer callbacks are starved during the freeze itself, the indicator is
// already visible going in and gets removed on completion — the user is
// never left staring at a silent queue.

const GENERATION_TICK_MS = 1000;

let generationTicker: ReturnType<typeof setInterval> | null = null;

function renderGenerationFeedback(): void {
  const text = document.getElementById('generation-feedback-text');
  if (!text || !lastFeedbackCounts) return;
  const { running } = lastFeedbackCounts;
  if (running >= 1) {
    const noun = running === 1 ? 'job' : 'jobs';
    text.textContent = `Generating audio… ${running} ${noun} in progress`;
  } else {
    text.textContent = 'Preparing generation…';
  }
}

/** Counts from the most recent update, re-read by every ticker tick. */
let lastFeedbackCounts: { active: number; running: number } | null = null;

/**
 * Show the pulsing "Generating…" indicator and run its refresh counter.
 * Safe to call repeatedly while generation continues (updates the counts).
 * `active` = pending + generating jobs; `running` = currently generating.
 */
export function startGenerationFeedback(active: number, running: number): void {
  lastFeedbackCounts = { active: Math.max(0, active), running: Math.max(0, running) };
  const box = document.getElementById('generation-feedback');
  if (box) box.classList.add('generation-feedback--visible');
  renderGenerationFeedback();
  if (generationTicker !== null) return;
  generationTicker = setInterval(renderGenerationFeedback, GENERATION_TICK_MS);
}

/** Hide the indicator and stop the counter. Safe to call when idle. */
export function stopGenerationFeedback(): void {
  lastFeedbackCounts = null;
  if (generationTicker !== null) {
    clearInterval(generationTicker);
    generationTicker = null;
  }
  document.getElementById('generation-feedback')?.classList.remove('generation-feedback--visible');
}
