import type { GenerationJob, JobProgress } from '../engine';
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
//
// Live progress (ticking timer): while a job generates, the engine emits
// `jobProgress` heartbeats ~every 500ms plus one per Kokoro sentence.
// Those bypass the full render entirely — only the card's hint node
// (`data-role="job-hint"`) and progress bar are touched, so there is no
// innerHTML diffing at 2Hz and no risk of tearing down buttons/audio.

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
  // Wire listeners onto any not-yet-wired action elements. Idempotent per
  // element (each element is marked when wired) rather than per card, so it
  // can safely be re-run after the card body is replaced — e.g. a job that
  // flips from `generating` to `done` gets its Download WAV button and audio
  // element wired at that point. Re-running must NOT re-attach to elements
  // that already have listeners, or a click would fire N times.
  const unwired = card.querySelectorAll<HTMLElement>(
    '[data-action="cancel"], [data-action="download"], audio[data-job-id]:not([data-wired])'
  );
  for (const el of unwired) {
    if (el.dataset.wired === 'true') continue;
    el.dataset.wired = 'true';
    const action = el.getAttribute('data-action');
    if (action === 'cancel') {
      el.addEventListener('click', () => {
        const id = card.dataset.jobId!;
        state.engine!.cancel(id);
      });
    } else if (action === 'download') {
      el.addEventListener('click', () => {
        const id = card.dataset.jobId!;
        const job = state.currentJobs.find(j => j.id === id);
        if (!job?.url) return;
        const a = document.createElement('a');
        a.href = job.url;
        a.download = `yapper-${id}-${Date.now()}.wav`;
        a.click();
      });
    } else if (el instanceof HTMLAudioElement) {
      el.addEventListener('play', () => {
        // Pause sibling audios when one starts.
        list.querySelectorAll<HTMLAudioElement>('audio[data-job-id]').forEach(other => {
          if (other !== el && !other.paused) other.pause();
        });
      });
    }
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
  // Queue positions for pending jobs: the engine dequeues newest-first
  // (jobs[0] is the next to run), so a pending job's position is its index
  // among pending jobs counting from the front of the array.
  const pendingQueuePositions = new Map<string, number>();
  let position = 0;
  for (const job of currentJobs) {
    if (job.status === 'pending') {
      position++;
      pendingQueuePositions.set(job.id, position);
    }
  }
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
      const desiredBody = renderJobCardBody(job, pendingQueuePositions.get(job.id));
      if (existing.body.innerHTML !== desiredBody) {
        existing.body.innerHTML = desiredBody;
        // Re-wire any buttons/audio that appeared in the new body.
        wireCardButtons(state, existing.card, list);
      }
    } else {
      // New card: build and insert.
      const tmp = document.createElement('div');
      tmp.innerHTML = renderJobCard(job, pendingQueuePositions.get(job.id));
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

// ─── Live progress rendering (hint-node only) ────────────────────

/**
 * Ordinal label for a pending job's queue position, 1-based.
 * 1 → "next", 2 → "2nd in queue", 3 → "3rd in queue", …
 */
export function formatQueuePosition(position: number): string {
  if (position <= 1) return 'Next up';
  const rem100 = position % 100;
  const rem10 = position % 10;
  let suffix: string;
  if (rem100 >= 11 && rem100 <= 13) {
    suffix = 'th';
  } else if (rem10 === 1) {
    suffix = 'st';
  } else if (rem10 === 2) {
    suffix = 'nd';
  } else if (rem10 === 3) {
    suffix = 'rd';
  } else {
    suffix = 'th';
  }
  return `${position}${suffix} in queue`;
}

/** Format elapsed milliseconds as a compact seconds counter ("7.0s"). */
function formatElapsed(elapsedMs: number): string {
  return `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`;
}

/**
 * The live hint text for a generating job. Pure function so tests can
 * cover every combination without DOM scaffolding.
 */
export function formatGeneratingHint(
  progress: Pick<JobProgress, 'phase' | 'segmentsDone' | 'segmentsTotal' | 'audioSecondsSoFar'>,
  elapsedMs: number,
): string {
  const phaseLabel = progress.phase === 'phonemizing' ? 'Writing phonemes…' : 'Generating…';
  const timer = ` ${formatElapsed(elapsedMs)}`;
  if (
    progress.segmentsDone !== undefined && progress.segmentsDone > 0
    && progress.segmentsTotal !== undefined
  ) {
    // Determinate: engine knows the total (e.g. pre-split sentences).
    return `${phaseLabel} sentence ${progress.segmentsDone}/${progress.segmentsTotal} ·${timer}`;
  }
  if (progress.segmentsDone !== undefined && progress.segmentsDone > 1) {
    // Indeterminate count but clearly multi-segment — show running count.
    return `${phaseLabel} ${progress.segmentsDone} sentences ·${timer}`;
  }
  return `${phaseLabel}${timer}`;
}

/**
 * Push live progress into an existing card WITHOUT re-rendering the body:
 * updates only the hint node's text and the progress-bar width. Called at
 * ~2Hz from the engine heartbeat plus once per Kokoro sentence.
 */
export function updateJobCardProgress(jobId: string, progress: JobProgress): void {
  const card = document.querySelector<HTMLElement>(`.job-card[data-job-id="${CSS.escape(jobId)}"]`);
  if (!card) return;
  const hint = card.querySelector<HTMLElement>('[data-role="job-hint"]');
  if (hint) {
    const next = formatGeneratingHint(progress, progress.elapsedMs);
    // Segment events can arrive between heartbeats with a STALE elapsedMs
    // (the worker→main hop adds latency); don't let the timer jump
    // backwards. Keep the larger of the two.
    if (!hint.dataset.elapsedMs || progress.elapsedMs >= Number(hint.dataset.elapsedMs)) {
      hint.textContent = next;
      hint.dataset.elapsedMs = String(progress.elapsedMs);
    } else {
      hint.textContent = formatGeneratingHint(progress, Number(hint.dataset.elapsedMs));
    }
  }
  const bar = card.querySelector<HTMLElement>('[data-role="job-progress"]');
  if (bar) {
    const fill = bar.firstElementChild as HTMLElement | null;
    if (fill) {
      if (progress.segmentsDone !== undefined && progress.segmentsTotal !== undefined && progress.segmentsTotal > 0) {
        bar.setAttribute('data-mode', 'determinate');
        fill.style.width = `${Math.min(100, Math.round((progress.segmentsDone / progress.segmentsTotal) * 100))}%`;
      } else {
        bar.setAttribute('data-mode', 'indeterminate');
      }
    }
  }
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

function renderJobCardBody(job: GenerationJob, queuePosition?: number): string {
  switch (job.status) {
    case 'pending': {
      const positionLabel = queuePosition !== undefined && queuePosition > 1
        ? formatQueuePosition(queuePosition)
        : 'Waiting in queue…';
      return `<div class="job-card__hint" data-role="job-hint">${positionLabel}</div>`;
    }
    case 'generating': {
      const elapsed = job.startedAt ? Math.round((Date.now() - job.startedAt) / 100) / 10 : 0;
      // The hint node and progress bar carry data-role hooks so the
      // engine's ~500ms heartbeats can update them in place (ticking
      // timer) via updateJobCardProgress() without re-rendering the body.
      return `
        <div class="job-progress" data-role="job-progress" data-mode="indeterminate"><div class="job-progress__fill"></div></div>
        <div class="job-card__hint" data-role="job-hint">Generating… ${elapsed}s</div>`;
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

function renderJobCard(job: GenerationJob, queuePosition?: number): string {
  return `
    <div class="job-card job-card--${job.status}" data-job-id="${job.id}">
      ${renderJobCardHeader(job)}
      <div class="job-card__body">${renderJobCardBody(job, queuePosition)}</div>
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
  // Live progress: engine heartbeats (~500ms) + Kokoro segment callbacks
  // update only the generating card's hint node / progress bar. No full
  // render, no innerHTML diffing at 2Hz.
  state.engine?.on('jobProgress', (progress) => {
    updateJobCardProgress(progress.jobId, progress);
  });

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
