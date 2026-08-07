import type { GenerationJob } from '../engine';
import type { AppState } from '../app-state';
import { escapeHtml, showStatus } from '../dom-utils';

// ─── Job list render ─────────────────────────────────────────────
//
// Each job card carries a stable `data-job-id` we can use as a key.
// `renderJobList` diffs the desired DOM against the current one:
//   * cards for jobs that still exist are patched in-place (status class,
//     body contents) so we don't tear down their audio element or
//     re-attach button listeners on every state transition
//   * cards for new jobs are appended
//   * cards for removed jobs are detached
// Without this, every job state change rewrites the entire list, which
// is O(n²) for n jobs and resets <audio> elements (losing playback
// position whenever a sibling job updates).

interface JobCardDom {
  card: HTMLElement;
  body: HTMLElement;
  statusSpan: HTMLElement;
}

function getCardDom(jobId: string): JobCardDom | null {
  const card = document.querySelector<HTMLElement>(`.job-card[data-job-id="${CSS.escape(jobId)}"]`);
  if (!card) return null;
  const statusSpan = card.querySelector<HTMLElement>('.job-card__status')!;
  const body = card.querySelector<HTMLElement>('.job-card__body')!;
  return { card, body, statusSpan };
}

function patchCardStatus(statusSpan: HTMLElement, card: HTMLElement, status: GenerationJob['status']) {
  card.classList.remove('job-card--pending', 'job-card--generating', 'job-card--done', 'job-card--error', 'job-card--cancelled');
  card.classList.add(`job-card--${status}`);
  statusSpan.innerHTML = statusIconHtml(status);
}

function wireCardButtons(state: AppState, card: HTMLElement, list: HTMLElement) {
  // Click listeners are wired once per card. Using a flag prevents us
  // from re-attaching the same listener on every render.
  if (card.dataset.wired === 'true') return;
  card.dataset.wired = 'true';

  const cancelBtn = card.querySelector<HTMLButtonElement>('[data-action="cancel"]');
  cancelBtn?.addEventListener('click', () => {
    const id = card.dataset.jobId!;
    state.engine!.cancel(id);
  });

  const downloadBtn = card.querySelector<HTMLButtonElement>('[data-action="download"]');
  downloadBtn?.addEventListener('click', () => {
    const id = card.dataset.jobId!;
    const job = state.currentJobs.find(j => j.id === id);
    if (!job?.url) return;
    const a = document.createElement('a');
    a.href = job.url;
    a.download = `yapper-${id}-${Date.now()}.wav`;
    a.click();
  });

  const audio = card.querySelector<HTMLAudioElement>('audio[data-job-id]');
  if (audio) {
    audio.addEventListener('play', () => {
      // Pause sibling audios when one starts.
      list.querySelectorAll<HTMLAudioElement>('audio[data-job-id]').forEach(other => {
        if (other !== audio && !other.paused) other.pause();
      });
    });
  }
}

export function renderJobList(state: AppState): void {
  const list = document.getElementById('job-list')!;
  const label = document.getElementById('queue-label')!;
  const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
  const queueCount = document.getElementById('queue-count') as HTMLElement;
  const currentJobs = state.currentJobs;

  if (currentJobs.length === 0) {
    list.innerHTML = '';
    label.style.display = 'none';
    clearBtn.disabled = true;
    if (queueCount) { queueCount.hidden = true; queueCount.textContent = ''; }
    return;
  }

  label.style.display = '';
  const finished = currentJobs.filter(j => j.status === 'done' || j.status === 'error' || j.status === 'cancelled');
  const active = currentJobs.filter(j => j.status === 'pending' || j.status === 'generating');
  clearBtn.disabled = finished.length === 0;

  // Show queue depth next to the generate button so users know how many
  // jobs are stacked up. Only show when there's at least one queued or
  // running job (finished jobs alone don't need a count).
  if (queueCount) {
    if (active.length > 0) {
      queueCount.hidden = false;
      const running = currentJobs.filter(j => j.status === 'generating').length;
      queueCount.textContent = running > 0
        ? `${running} running · ${active.length} in queue`
        : `${active.length} in queue`;
    } else {
      queueCount.hidden = true;
      queueCount.textContent = '';
    }
  }

  // Diff against existing DOM.
  const seen = new Set<string>();
  for (const job of currentJobs) {
    seen.add(job.id);
    const existing = getCardDom(job.id);
    if (existing) {
      // In-place patch: update status class + body if changed.
      const newStatusClass = `job-card--${job.status}`;
      if (!existing.card.classList.contains(newStatusClass)) {
        patchCardStatus(existing.statusSpan, existing.card, job.status);
      }
      const desiredBody = renderJobCardBody(job);
      if (existing.body.innerHTML !== desiredBody) {
        existing.body.innerHTML = desiredBody;
        // Re-wire any buttons/audio that appeared in the new body.
        wireCardButtons(state, existing.card, list);
      }
    } else {
      // New card: build and insert.
      const tmp = document.createElement('div');
      tmp.innerHTML = renderJobCard(job);
      const card = tmp.firstElementChild as HTMLElement;
      list.appendChild(card);
      wireCardButtons(state, card, list);
    }
  }
  // Remove cards whose jobs are gone.
  list.querySelectorAll<HTMLElement>('.job-card').forEach(card => {
    const id = card.dataset.jobId;
    if (id && !seen.has(id)) card.remove();
  });
}

function renderJobCardHeader(job: GenerationJob): string {
  const statusIcon = statusIconHtml(job.status);
  const voiceLabel = job.voiceName ? ` · ${escapeHtml(job.voiceName)}` : '';
  const speedLabel = job.speed !== 1.0 ? ` · ${job.speed.toFixed(2)}x` : '';
  const textPreview = job.text.length > 100 ? job.text.slice(0, 100) + '…' : job.text;
  const cancellable = job.status === 'pending' || job.status === 'generating';
  return `
    <div class="job-card__header">
      <span class="job-card__status">${statusIcon}</span>
      <span class="job-card__meta-line">${escapeHtml(job.modelName)}${voiceLabel}${speedLabel}</span>
      ${cancellable ? `<button class="job-card__cancel" data-action="cancel" data-job-id="${job.id}" title="Cancel">×</button>` : ''}
    </div>
    <div class="job-card__text">"${escapeHtml(textPreview)}"</div>`;
}

function renderJobCardBody(job: GenerationJob): string {
  switch (job.status) {
    case 'pending':
      return `<div class="job-card__hint">Waiting in queue…</div>`;
    case 'generating': {
      const elapsed = job.startedAt ? Math.round((Date.now() - job.startedAt) / 100) / 10 : 0;
      return `<div class="job-card__hint">Generating… ${elapsed}s</div>`;
    }
    case 'done':
      return `
        <audio controls preload="metadata" data-job-id="${job.id}" src="${job.url}"></audio>
        <div class="job-card__actions">
          <button class="job-card__btn" data-action="download" data-job-id="${job.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download WAV
          </button>
          <span class="job-card__meta">${((job.durationMs ?? 0) / 1000).toFixed(1)}s · ${job.audio && job.sampleRate ? Math.floor(job.audio.length / job.sampleRate) : 0}s audio</span>
        </div>`;
    case 'error':
      return `<div class="job-card__error">${escapeHtml(job.error ?? 'Unknown error')}</div>`;
    case 'cancelled':
      return `<div class="job-card__hint">Cancelled</div>`;
  }
}

function renderJobCard(job: GenerationJob): string {
  return `
    <div class="job-card job-card--${job.status}" data-job-id="${job.id}">
      ${renderJobCardHeader(job)}
      <div class="job-card__body">${renderJobCardBody(job)}</div>
    </div>`;
}

function statusIconHtml(status: GenerationJob['status']): string {
  switch (status) {
    case 'pending':    return '<span class="status-dot status-dot--pending" title="Pending"></span>';
    case 'generating': return '<span class="status-dot status-dot--generating" title="Generating"></span>';
    case 'done':       return '<span class="status-dot status-dot--done" title="Done">✓</span>';
    case 'error':      return '<span class="status-dot status-dot--error" title="Error">✕</span>';
    case 'cancelled':  return '<span class="status-dot status-dot--cancelled" title="Cancelled">⊘</span>';
  }
}

/** Bind generate / clear / speed / text-input events for the queue UI. */
export function bindJobQueueEvents(state: AppState): void {
  // Text input
  const textInput = document.getElementById('text-input') as HTMLTextAreaElement;
  const charCount = document.getElementById('char-count')!;
  textInput.addEventListener('input', () => {
    const len = textInput.value.length;
    charCount.textContent = `${len} / 2000`;
    charCount.classList.toggle('char-count--warn', len > 1800);
  });
  textInput.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+Enter enqueues a job from the textarea. Avoid stealing the
    // keystroke if a modifier other than Ctrl/Cmd is also held (Alt+Enter
    // for newline, Shift+Enter for newline, etc.).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('generate-btn')?.click();
    }
  });
  charCount.textContent = `${textInput.value.length} / 2000`;

  // Generate — creates a job, does NOT block
  document.getElementById('generate-btn')!.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (!text) return;

    // For SpeechT5, ensure we have a valid speaker embedding
    const voiceId = state.selectedVoiceId;
    const isCustom = state.selectedModel.id === 'speecht5' && voiceId === 'custom';
    if (isCustom && !state.customEmbeddingUrl) {
      showStatus('error', 'Custom voice: paste a speaker embedding URL first.');
      return;
    }

    state.engine!.enqueue(text, {
      modelId: state.selectedModel.id,
      voiceId,
      customSpeakerEmbeddings: isCustom ? state.customEmbeddingUrl : undefined,
      speed: state.currentSpeed,
    });
  });

  // Clear finished
  document.getElementById('clear-btn')!.addEventListener('click', () => {
    state.engine!.clearFinished();
  });

  // Speed slider
  const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;
  const speedValue = document.getElementById('speed-value')!;
  speedSlider.addEventListener('input', () => {
    state.currentSpeed = parseFloat(speedSlider.value);
    speedValue.textContent = `${state.currentSpeed.toFixed(2)}x`;
  });
}
