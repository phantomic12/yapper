import './style.css';
import { env } from '@huggingface/transformers';
import { TTSEngine, MODELS, detectWebGPU, float32ToWav, type TTSModel, type Voice, type GenerationJob, type EngineState, registerCustomEngine } from './engine';
import { KokoroCustomEngine } from './engines/kokoro';
import { KittenCustomEngine } from './engines/kitten';

// ─── Run transformers.js inference in a Web Worker ──────────────
// Without this, an MMS-TTS or SpeechT5 generation freezes the page
// (the WASM runs on the main thread). With proxy = true, the heavy
// work happens off-thread; the main thread stays responsive for typing,
// model switching, queueing more jobs, etc.
(env.backends.onnx as { wasm: { proxy?: boolean; numThreads?: number } }).wasm = {
  proxy: true,
  numThreads: 1,
};

// ─── Register custom engines (one-time, before render) ──────────
// Both Kokoro and Kitten are integrated as CustomEngine instances. We
// instantiate them up front (cheap — no network) and register with the
// engine registry so the engine's loadModel() can find them when the user
// picks those models.
//
// KittenCustomEngine and KokoroCustomEngine do no I/O in their constructor;
// they only fetch model files in their .load() method, which is called
// later when the user clicks "Download & Load Model".
for (const [modelId, ctor] of [
  ['onnx-community/Kokoro-82M-v1.0-ONNX', KokoroCustomEngine],
  ['KittenML/kitten-tts-nano-0.8-int8', KittenCustomEngine],
] as const) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerCustomEngine(modelId, new (ctor as any)());
}

// ─── DOM refs ────────────────────────────────────────────────────
const app = document.getElementById('app')!;
const root = app as HTMLDivElement;

// ─── State ───────────────────────────────────────────────────────
let engine: TTSEngine;
let selectedModel: TTSModel = MODELS[0];
let selectedVoiceId: string | undefined = MODELS[0].defaultVoiceId ?? MODELS[0].voices?.[0]?.id;
let customEmbeddingUrl: string = '';
let webgpuAvailable = false;
let currentJobs: GenerationJob[] = [];

// ─── Render ──────────────────────────────────────────────────────
async function render() {
  webgpuAvailable = await detectWebGPU();

  engine = new TTSEngine({
    onJobsChange: (jobs) => {
      currentJobs = jobs;
      renderJobList();
    },
    onEngineStateChange: handleEngineStateChange,
    onLoadProgress: handleLoadProgress,
    onEngineError: handleEngineError,
  });

  root.innerHTML = `
    <div class="app">
      <header class="header">
        <div class="header__logo">
          <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="logo-g" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#6366f1"/>
                <stop offset="100%" style="stop-color:#a855f7"/>
              </linearGradient>
            </defs>
            <rect width="100" height="100" rx="20" fill="url(#logo-g)"/>
            <g fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M50 25v50"/>
              <path d="M35 38c0-8.3 6.7-15 15-15s15 6.7 15 15"/>
              <path d="M35 62c0 8.3 6.7 15 15 15s15-6.7 15-15"/>
              <path d="M20 50h10"/>
              <path d="M70 50h10"/>
              <circle cx="50" cy="50" r="6" fill="white" stroke="none"/>
            </g>
          </svg>
          <h1 class="header__title">Yapper</h1>
        </div>
        <p class="header__subtitle">Text-to-speech that runs entirely in your browser</p>
        <div class="privacy-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          100% private — no data leaves your device
        </div>
      </header>

      <!-- GPU Status -->
      <div class="gpu-status">
        <div class="gpu-status__dot ${webgpuAvailable ? 'gpu-status__dot--on' : 'gpu-status__dot--off'}"></div>
        <span class="gpu-status__label">${webgpuAvailable ? 'WebGPU detected — GPU-accelerated inference' : 'WebGPU unavailable — using CPU fallback (WASM)'}</span>
      </div>

      <!-- Model Selection -->
      <div class="section-label">Choose a model</div>
      <div class="model-grid" id="model-grid">
        ${MODELS.map(m => `
          <button class="model-card ${m.id === selectedModel.id ? 'model-card--selected' : ''}" data-model-id="${m.id}">
            <div class="model-card__name">${m.name}</div>
            <div class="model-card__desc">${m.description}</div>
            <span class="model-card__tag model-card__tag--${m.category}">${m.category}</span>
          </button>
        `).join('')}
      </div>

      <!-- Voice Selection (hidden if model has no voices) -->
      <div class="voice-section" id="voice-section" style="display:none">
        <div class="section-label">Voice</div>
        <div class="voice-grid" id="voice-grid"></div>
        <div class="custom-voice-input" id="custom-voice-input" style="display:none">
          <input type="url" id="custom-voice-url" placeholder="https://example.com/your-speaker-embedding.bin" />
          <div class="custom-voice-hint">512-dim Float32 xvector. Generate one with the SpeechT5 reference script.</div>
        </div>
      </div>

      <!-- Load Button -->
      <button class="load-btn" id="load-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span id="load-btn-label">Download & Load Model</span>
      </button>

      <!-- Progress -->
      <div class="progress-bar" id="progress-bar"><div class="progress-bar__fill" id="progress-fill"></div></div>
      <div class="progress-text" id="progress-text"></div>

      <!-- Status -->
      <div id="status-container"></div>

      <!-- Text Input -->
      <div class="textarea-wrapper">
        <textarea
          class="textarea"
          id="text-input"
          placeholder="Type something to speak…"
          maxlength="2000"
          disabled
        >The future of text-to-speech is private, fast, and runs entirely in your browser. No cloud, no tracking, no compromise.</textarea>
        <span class="char-count" id="char-count">0 / 2000</span>
      </div>

      <!-- Generate (creates a job — does NOT block) -->
      <div class="generate-row">
        <button class="generate-btn" id="generate-btn" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          <span id="generate-btn-label">Add to queue</span>
        </button>
        <button class="clear-btn" id="clear-btn" disabled>Clear finished</button>
      </div>

      <!-- Job list -->
      <div class="section-label" id="queue-label" style="display:none">Queue</div>
      <div class="job-list" id="job-list"></div>

      <footer class="footer">
        <p class="footer__text">
          Models loaded from <a href="https://huggingface.co" target="_blank" rel="noopener">Hugging Face</a> •
          Powered by <a href="https://huggingface.co/docs/transformers.js" target="_blank" rel="noopener">Transformers.js</a> +
          <a href="https://onnxruntime.ai" target="_blank" rel="noopener">ONNX Runtime</a> •
          <a href="https://github.com/phantomic12/yapper" target="_blank" rel="noopener">Source</a>
        </p>
      </footer>
    </div>
  `;

  renderVoiceSection();
  bindEvents();
}

// ─── Voice section render ────────────────────────────────────────
function renderVoiceSection() {
  const section = document.getElementById('voice-section')!;
  const grid = document.getElementById('voice-grid')!;
  const customInput = document.getElementById('custom-voice-input')!;

  if (!selectedModel.voices || selectedModel.voices.length === 0) {
    section.style.display = 'none';
    selectedVoiceId = undefined;
    return;
  }

  section.style.display = '';
  grid.innerHTML = selectedModel.voices.map(v => `
    <button class="voice-card ${v.id === selectedVoiceId ? 'voice-card--selected' : ''}" data-voice-id="${v.id}">
      <div class="voice-card__name">${escapeHtml(v.name)}</div>
      ${v.description ? `<div class="voice-card__desc">${escapeHtml(v.description)}</div>` : ''}
    </button>
  `).join('');

  // Show custom URL input if "Custom" is selected
  const customVoice = selectedModel.voices.find(v => v.id === 'custom');
  if (customVoice) {
    customInput.style.display = selectedVoiceId === 'custom' ? '' : 'none';
  } else {
    customInput.style.display = 'none';
  }

  // Bind voice card clicks
  grid.querySelectorAll<HTMLButtonElement>('.voice-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedVoiceId = card.dataset.voiceId;
      renderVoiceSection();
    });
  });
}

// ─── Job list render ─────────────────────────────────────────────
function renderJobList() {
  const list = document.getElementById('job-list')!;
  const label = document.getElementById('queue-label')!;
  const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;

  if (currentJobs.length === 0) {
    list.innerHTML = '';
    label.style.display = 'none';
    clearBtn.disabled = true;
    return;
  }

  label.style.display = '';
  const hasFinished = currentJobs.some(j => j.status === 'done' || j.status === 'error' || j.status === 'cancelled');
  clearBtn.disabled = !hasFinished;

  list.innerHTML = currentJobs.map(job => renderJobCard(job)).join('');

  // Wire up the buttons
  list.querySelectorAll<HTMLButtonElement>('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.jobId!;
      engine.cancel(id);
    });
  });
  list.querySelectorAll<HTMLButtonElement>('[data-action="download"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.jobId!;
      const job = currentJobs.find(j => j.id === id);
      if (!job?.url) return;
      const a = document.createElement('a');
      a.href = job.url;
      a.download = `yapper-${id}-${Date.now()}.wav`;
      a.click();
    });
  });
  list.querySelectorAll<HTMLAudioElement>('audio[data-job-id]').forEach(audio => {
    audio.addEventListener('play', () => {
      // Pause other audios when one starts
      list.querySelectorAll<HTMLAudioElement>('audio[data-job-id]').forEach(other => {
        if (other !== audio && !other.paused) other.pause();
      });
    });
  });
}

function renderJobCard(job: GenerationJob): string {
  const statusIcon = statusIconHtml(job.status);
  const voiceLabel = job.voiceName ? ` · ${escapeHtml(job.voiceName)}` : '';
  const textPreview = job.text.length > 100 ? job.text.slice(0, 100) + '…' : job.text;

  let body = '';
  switch (job.status) {
    case 'pending':
      body = `<div class="job-card__hint">Waiting in queue…</div>`;
      break;
    case 'generating':
      const elapsed = job.startedAt ? Math.round((Date.now() - job.startedAt) / 100) / 10 : 0;
      body = `<div class="job-card__hint">Generating… ${elapsed}s</div>`;
      break;
    case 'done':
      body = `
        <audio controls preload="metadata" data-job-id="${job.id}" src="${job.url}"></audio>
        <div class="job-card__actions">
          <button class="job-card__btn" data-action="download" data-job-id="${job.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download WAV
          </button>
          <span class="job-card__meta">${((job.durationMs ?? 0) / 1000).toFixed(1)}s · ${((job.audio?.length ?? 0) / (job.sampleRate ?? 1) | 0)}s audio</span>
        </div>`;
      break;
    case 'error':
      body = `<div class="job-card__error">${escapeHtml(job.error ?? 'Unknown error')}</div>`;
      break;
    case 'cancelled':
      body = `<div class="job-card__hint">Cancelled</div>`;
      break;
  }

  const cancellable = job.status === 'pending' || job.status === 'generating';
  return `
    <div class="job-card job-card--${job.status}">
      <div class="job-card__header">
        <span class="job-card__status">${statusIcon}</span>
        <span class="job-card__meta-line">${escapeHtml(job.modelName)}${voiceLabel}</span>
        ${cancellable ? `<button class="job-card__cancel" data-action="cancel" data-job-id="${job.id}" title="Cancel">×</button>` : ''}
      </div>
      <div class="job-card__text">"${escapeHtml(textPreview)}"</div>
      <div class="job-card__body">${body}</div>
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

// ─── Event Binding ───────────────────────────────────────────────
function bindEvents() {
  // Model cards
  document.querySelectorAll<HTMLButtonElement>('.model-card').forEach(card => {
    card.addEventListener('click', () => {
      const modelId = card.dataset.modelId!;
      const newModel = MODELS.find(m => m.id === modelId);
      if (!newModel) return;
      selectedModel = newModel;
      // Reset voice selection to this model's default
      selectedVoiceId = newModel.defaultVoiceId ?? newModel.voices?.[0]?.id;
      customEmbeddingUrl = '';
      document.querySelectorAll('.model-card').forEach(c => c.classList.remove('model-card--selected'));
      card.classList.add('model-card--selected');
      renderVoiceSection();
    });
  });

  // Custom voice URL input
  const customUrlInput = document.getElementById('custom-voice-url') as HTMLInputElement;
  customUrlInput.addEventListener('input', () => {
    customEmbeddingUrl = customUrlInput.value.trim();
  });

  // Load model
  document.getElementById('load-btn')!.addEventListener('click', async () => {
    const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
    const loadBtnLabel = document.getElementById('load-btn-label')!;
    loadBtn.disabled = true;
    loadBtnLabel.textContent = 'Loading…';
    try {
      await engine.loadModel(selectedModel);
    } catch (err) {
      showStatus('error', `Load failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      loadBtn.disabled = false;
    }
  });

  // Text input
  const textInput = document.getElementById('text-input') as HTMLTextAreaElement;
  const charCount = document.getElementById('char-count')!;
  textInput.addEventListener('input', () => {
    const len = textInput.value.length;
    charCount.textContent = `${len} / 2000`;
    charCount.classList.toggle('char-count--warn', len > 1800);
  });
  charCount.textContent = `${textInput.value.length} / 2000`;

  // Generate — creates a job, does NOT block
  document.getElementById('generate-btn')!.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (!text) return;

    // For SpeechT5, ensure we have a valid speaker embedding
    let voiceId = selectedVoiceId;
    const isCustom = selectedModel.id === 'speecht5' && voiceId === 'custom';
    if (isCustom && !customEmbeddingUrl) {
      showStatus('error', 'Custom voice: paste a speaker embedding URL first.');
      return;
    }

    engine.enqueue(text, {
      modelId: selectedModel.id,
      voiceId,
      customSpeakerEmbeddings: isCustom ? customEmbeddingUrl : undefined,
    });
  });

  // Clear finished
  document.getElementById('clear-btn')!.addEventListener('click', () => {
    engine.clearFinished();
  });
}

// ─── Engine state handlers ───────────────────────────────────────
function handleEngineStateChange(state: EngineState) {
  const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
  const generateBtn = document.getElementById('generate-btn') as HTMLButtonElement;
  const textInput = document.getElementById('text-input') as HTMLTextAreaElement;
  const loadBtnLabel = document.getElementById('load-btn-label')!;
  const progressBar = document.getElementById('progress-bar')!;
  const progressText = document.getElementById('progress-text')!;

  switch (state) {
    case 'idle':
      loadBtn.disabled = false;
      generateBtn.disabled = true;
      textInput.disabled = true;
      progressBar.classList.remove('progress-bar--visible');
      progressText.classList.remove('progress-text--visible');
      loadBtnLabel.textContent = 'Download & Load Model';
      break;

    case 'loading':
      loadBtn.disabled = true;
      loadBtnLabel.textContent = 'Loading…';
      progressBar.classList.add('progress-bar--visible');
      progressText.classList.add('progress-text--visible');
      break;

    case 'ready': {
      const current = engine.getCurrentModel();
      loadBtn.disabled = false;
      loadBtnLabel.textContent = `✓ ${current?.name ?? 'Model'} loaded`;
      generateBtn.disabled = false;
      textInput.disabled = false;
      progressBar.classList.remove('progress-bar--visible');
      progressText.classList.remove('progress-text--visible');
      showStatus('success', `${current?.name} is ready. Type something and hit Generate (or queue several).`);
      break;
    }

    case 'error':
      loadBtn.disabled = false;
      loadBtnLabel.textContent = 'Download & Load Model';
      generateBtn.disabled = true;
      progressBar.classList.remove('progress-bar--visible');
      progressText.classList.remove('progress-text--visible');
      break;
  }
}

function handleLoadProgress(loaded: number, total: number, modelName: string) {
  const fill = document.getElementById('progress-fill')!;
  const text = document.getElementById('progress-text')!;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  const sizeMB = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';

  fill.style.width = `${pct}%`;
  text.textContent = `Downloading ${modelName}… ${pct}% (${sizeMB} MB)`;
}

function handleEngineError(msg: string) {
  showStatus('error', msg);
}

function showStatus(type: 'success' | 'error', message: string) {
  const container = document.getElementById('status-container')!;
  const icon = type === 'success'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

  container.innerHTML = `<div class="status-banner status-banner--${type}">${icon}<span>${message}</span></div>`;
}

// ─── Utilities ───────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Boot ────────────────────────────────────────────────────────
render();
