/** Shared DOM helpers used by UI modules. */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function showStatus(type: 'success' | 'error', message: string, assertive = false) {
  const container = document.getElementById('status-container')!;
  const icon = type === 'success'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

  container.innerHTML = `<div class="status-banner status-banner--${type}" role="${assertive ? 'alert' : 'status'}" aria-live="${assertive ? 'assertive' : 'polite'}">${icon}<span>${escapeHtml(message)}</span></div>`;
}
