import { extractDocument, type ExtractedDocument, type LayoutBlock } from './document-reader';
import { DocumentReaderSession, prepareReaderData, type ReaderState, type HighlightInfo, type ReaderSentence } from './reader';
import './style.css';
import { TTSEngine, MODELS, detectWebGPU, float32ToWav, type TTSModel, type Voice, type GenerationJob, type EngineState, registerCustomEngine } from './engine';
import { KokoroCustomEngine } from './engines/kokoro';
import { KittenCustomEngine } from './engines/kitten';

// ─── Note on Web Worker proxy ────────────────────────────────────
// We previously enabled `env.backends.onnx.wasm.proxy = true` here AND
// in src/engines/kitten.ts to run inference in a Web Worker so the page
// stays responsive during generation. This caused "no available backend
// found" on Kitten because Vite emits the ORT WASM with a content hash
// in its filename, and the proxy worker can't resolve that path via
// `wasmPaths` alone (the worker fetches from the script's own directory).
//
// For now, inference runs on the main thread — generation will block
// the page, but the queue still accepts new jobs (each blocks behind
// the active one). The proper fix is a Vite `?worker` import that owns
// the ONNX runtime + WASM lifecycle, which we'll add as a follow-up.

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
let currentSpeed = 1.0;
let currentLanguageFilter = 'all';
let webgpuAvailable = false;
let currentJobs: GenerationJob[] = [];
let extractedDocument: ExtractedDocument | null = null;
let readerSession: DocumentReaderSession | null = null;

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
      <div class="gpu-status" role="status" aria-live="polite">
        <div class="gpu-status__dot ${webgpuAvailable ? 'gpu-status__dot--on' : 'gpu-status__dot--off'}"></div>
        <span class="gpu-status__label">${webgpuAvailable ? 'WebGPU detected — GPU-accelerated inference' : 'WebGPU unavailable — using CPU fallback (WASM)'}</span>
      </div>

      <!-- Model Selection -->
      <label class="section-label" for="language-filter">Filter models by language</label>

      <!-- Language filter -->
      <div class="select-wrapper language-select-wrapper">
        <select id="language-filter" class="lang-select" aria-label="Filter models by language">
          <option value="all" selected>All languages</option>
          <option value="en">English</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="it">Italian</option>
          <option value="pt">Portuguese</option>
          <option value="ru">Russian</option>
          <option value="ja">Japanese</option>
          <option value="zh">Chinese</option>
          <option value="ko">Korean</option>
          <option value="hi">Hindi</option>
          <option value="ar">Arabic</option>
        </select>
      </div>

      <div class="model-grid" id="model-grid" role="radiogroup" aria-label="Choose a TTS model">
        ${MODELS.map(m => `
          <button class="model-card ${m.id === selectedModel.id ? 'model-card--selected' : ''}" data-model-id="${m.id}" data-language="${m.language ?? 'en'}" role="radio" aria-checked="${m.id === selectedModel.id}">
            <div class="model-card__name">${m.name}</div>
            <div class="model-card__desc">${m.description}</div>
            <div class="model-card__meta">
              ${m.sizeMB ? `<span class="model-card__size">~${m.sizeMB}MB</span>` : ''}
              ${m.language && m.language !== 'en' ? `<span class="model-card__lang">${m.language.toUpperCase()}</span>` : ''}
              <span class="model-card__tag model-card__tag--${m.category}">${m.category}</span>
            </div>
          </button>
        `).join('')}
      </div>

      <!-- Voice Selection (hidden if model has no voices) -->
      <div class="voice-section" id="voice-section" style="display:none">
        <div class="section-label" id="voice-section-label">Voice</div>
        <div class="voice-grid" id="voice-grid" role="radiogroup" aria-labelledby="voice-section-label"></div>
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
      <label class="section-label" for="text-input">Text to speak</label>
      <div class="textarea-wrapper">
        <textarea
          class="textarea"
          id="text-input"
          placeholder="Type something to speak…"
          maxlength="2000"
          disabled
          aria-describedby="char-count"
        >The future of text-to-speech is private, fast, and runs entirely in your browser. No cloud, no tracking, no compromise.</textarea>
        <span class="char-count" id="char-count" aria-live="polite">0 / 2000</span>
      </div>

      <!-- Document upload -->
      <section class="document-section" id="document-section" aria-labelledby="document-heading">
        <h2 class="section-label" id="document-heading">Read a document</h2>
        <div class="document-drop" id="document-drop" tabindex="0" role="button" aria-label="Upload a document to read aloud">
          <input
            type="file"
            id="document-upload"
            class="visually-hidden"
            accept=".pdf,.docx,.odt,.epub,.txt,.md,.markdown"
            aria-describedby="document-formats"
          />
          <label for="document-upload" class="document-drop__label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Drop a document here or click to upload</span>
          </label>
          <p class="document-formats" id="document-formats">PDF, DOCX, ODT, EPUB, TXT, MD. Max 25 MB.</p>
        </div>

        <div class="document-need-model" id="document-need-model">
          <p>📄 Upload a document to preview the extracted text. Load a model above to have Yapper read it aloud.</p>
        </div>

        <div class="document-options" id="document-options" style="display:none">
          <label class="switch">
            <input type="checkbox" id="ocr-toggle" />
            <span class="switch__track"></span>
            <span class="switch__label">Use OCR for PDFs (experimental, slower)</span>
          </label>
          <div class="document-progress" id="document-progress" role="status" aria-live="polite"></div>
        </div>

        <div class="document-preview" id="document-preview" style="display:none">
          <div class="document-actions">
            <button class="document-btn document-btn--primary" id="read-document-btn" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
              <span>Read aloud</span>
            </button>
            <button class="document-btn" id="pause-document-btn" type="button" style="display:none">Pause</button>
            <button class="document-btn" id="stop-document-btn" type="button" style="display:none">Stop</button>
            <span class="reader-status" id="reader-status" role="status" aria-live="polite"></span>
          </div>
          <label class="section-label" for="document-reader-view">Extracted text</label>
          <div id="document-reader-view" class="reader-view" role="region" aria-label="Document text" aria-live="off" tabindex="0"></div>
          <p class="document-hint" id="document-text-hint">The active sentence is highlighted as it is read aloud.</p>
        </div>

        <details class="layout-details" id="layout-details" style="display:none">
          <summary>OCR layout blocks</summary>
          <pre class="layout-pre" id="layout-pre" tabindex="0"></pre>
        </details>
      </section>

      <!-- Generate (creates a job — does NOT block) -->
      <div class="generate-row">
        <button class="generate-btn" id="generate-btn" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          <span id="generate-btn-label">Add to queue</span>
        </button>
        <button class="clear-btn" id="clear-btn" disabled>Clear finished</button>
      </div>

      <!-- Speed slider -->
      <div class="speed-row">
        <label for="speed-slider" class="speed-label">Speed</label>
        <input type="range" id="speed-slider" min="0.5" max="2.0" step="0.05" value="1.0" />
        <span class="speed-value" id="speed-value">1.00x</span>
        <div class="speed-hint">0.5x – 2.0x. Kokoro/Kitten use native speed; SpeechT5/MMS resample.</div>
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
  renderLanguageFilter();
  bindEvents();
  updateDocumentSectionVisibility();
}

// ─── Voice section render ────────────────────────────────────────
function renderLanguageFilter() {
  const select = document.getElementById('language-filter') as HTMLSelectElement;
  if (select) select.value = currentLanguageFilter;
  // Show/hide model cards based on filter
  document.querySelectorAll<HTMLButtonElement>('.model-card').forEach(card => {
    const cardLang = card.dataset.language ?? 'en';
    const visible = currentLanguageFilter === 'all' || cardLang === currentLanguageFilter;
    card.style.display = visible ? '' : 'none';
    card.setAttribute('aria-hidden', String(!visible));
  });
}

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
    <button class="voice-card ${v.id === selectedVoiceId ? 'voice-card--selected' : ''}" data-voice-id="${v.id}" role="radio" aria-checked="${v.id === selectedVoiceId}">
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
    card.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = card.nextElementSibling as HTMLButtonElement | null;
        next?.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = card.previousElementSibling as HTMLButtonElement | null;
        prev?.focus();
      }
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
  let statusIcon = statusIconHtml(job.status);
  const voiceLabel = job.voiceName ? ` · ${escapeHtml(job.voiceName)}` : '';
  const speedLabel = job.speed !== 1.0 ? ` · ${job.speed.toFixed(2)}x` : '';
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
        <span class="job-card__meta-line">${escapeHtml(job.modelName)}${voiceLabel}${speedLabel}</span>
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
  // Bind model card clicks and keyboard nav
  document.querySelectorAll<HTMLButtonElement>('.model-card').forEach(card => {
    card.addEventListener('click', () => {
      const modelId = card.dataset.modelId!;
      const newModel = MODELS.find(m => m.id === modelId);
      if (!newModel) return;
      selectModel(newModel, card);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        focusVisibleModelCard(card, 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusVisibleModelCard(card, -1);
      }
    });
  });

  function selectModel(newModel: TTSModel, card: HTMLElement) {
    selectedModel = newModel;
    // Reset voice selection to this model's default
    selectedVoiceId = newModel.defaultVoiceId ?? newModel.voices?.[0]?.id;
    customEmbeddingUrl = '';
    document.querySelectorAll<HTMLButtonElement>('.model-card').forEach(c => {
      c.classList.remove('model-card--selected');
      c.setAttribute('aria-checked', 'false');
    });
    card.classList.add('model-card--selected');
    card.setAttribute('aria-checked', 'true');
    renderVoiceSection();
  }

  function focusVisibleModelCard(current: HTMLElement, direction: 1 | -1) {
    const visible = Array.from(document.querySelectorAll<HTMLButtonElement>('.model-card'))
      .filter(c => c.style.display !== 'none');
    const idx = visible.indexOf(current as HTMLButtonElement);
    const next = visible[idx + direction];
    next?.focus();
  }

  // Custom voice URL input
  const customUrlInput = document.getElementById('custom-voice-url') as HTMLInputElement;
  customUrlInput.addEventListener('input', () => {
    customEmbeddingUrl = customUrlInput.value.trim();
  });

  // Load model
  document.getElementById('load-btn')!.addEventListener('click', async () => {
    const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
    const loadBtnLabel = document.getElementById('load-btn-label')!;
    // Bring focus back if keyboard activated
    loadBtn.focus();
    loadBtn.disabled = true;
    loadBtnLabel.textContent = 'Loading…';
    try {
      await engine.loadModel(selectedModel);
      updateDocumentSectionVisibility();
    } catch (err) {
      showStatus('error', `Load failed: ${err instanceof Error ? err.message : String(err)}`, true);
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
      speed: currentSpeed,
    });
  });

  // Clear finished
  document.getElementById('clear-btn')!.addEventListener('click', () => {
    engine.clearFinished();
  });

  // Speed slider
  const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;
  const speedValue = document.getElementById('speed-value')!;
  speedSlider.addEventListener('input', () => {
    currentSpeed = parseFloat(speedSlider.value);
    speedValue.textContent = `${currentSpeed.toFixed(2)}x`;
  });

  // Language filter
  const langSelect = document.getElementById('language-filter') as HTMLSelectElement;
  langSelect.addEventListener('change', () => {
    currentLanguageFilter = langSelect.value;
    renderLanguageFilter();
  });

  // Document upload
  bindDocumentEvents();
}

// ─── Document upload + reader ──────────────────────────────────────
function bindDocumentEvents() {
  const drop = document.getElementById('document-drop') as HTMLElement;
  const input = document.getElementById('document-upload') as HTMLInputElement;
  const ocrToggle = document.getElementById('ocr-toggle') as HTMLInputElement;
  const documentProgress = document.getElementById('document-progress') as HTMLElement;
  const options = document.getElementById('document-options') as HTMLElement;
  const preview = document.getElementById('document-preview') as HTMLElement;
  const readerView = document.getElementById('document-reader-view') as HTMLElement;
  const readBtn = document.getElementById('read-document-btn') as HTMLButtonElement;
  const pauseBtn = document.getElementById('pause-document-btn') as HTMLButtonElement;
  const stopBtn = document.getElementById('stop-document-btn') as HTMLButtonElement;
  const readerStatus = document.getElementById('reader-status') as HTMLElement;
  const layoutDetails = document.getElementById('layout-details') as HTMLDetailsElement;
  const layoutPre = document.getElementById('layout-pre') as HTMLPreElement;

  function setProgress(msg: string) {
    documentProgress.textContent = msg;
  }

  function renderReaderView(text: string) {
    readerView.innerHTML = '';
    const { sentences } = prepareReaderData(text, 300);
    const sentenceByPara = new Map<number, ReaderSentence[]>();
    for (const s of sentences) {
      const list = sentenceByPara.get(s.paragraphIndex) ?? [];
      list.push(s);
      sentenceByPara.set(s.paragraphIndex, list);
    }
    const paragraphIndices = Array.from(sentenceByPara.keys()).sort((a, b) => a - b);
    for (const pIdx of paragraphIndices) {
      const p = document.createElement('p');
      p.className = 'reader-paragraph';
      for (const sentence of sentenceByPara.get(pIdx)!) {
        const sentenceSpan = document.createElement('span');
        sentenceSpan.className = 'reader-sentence';
        sentenceSpan.dataset.sentenceIndex = String(sentence.globalIndex);
        for (let w = 0; w < sentence.words.length; w++) {
          const wordSpan = document.createElement('span');
          wordSpan.className = 'reader-word';
          wordSpan.dataset.wordIndex = String(w);
          wordSpan.textContent = sentence.words[w];
          sentenceSpan.appendChild(wordSpan);
          if (w < sentence.words.length - 1) {
            sentenceSpan.appendChild(document.createTextNode(' '));
          }
        }
        p.appendChild(sentenceSpan);
        p.appendChild(document.createTextNode(' '));
      }
      readerView.appendChild(p);
    }
    return Array.from(readerView.querySelectorAll('.reader-sentence'));
  }

  function handleFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      showStatus('error', 'File is too large. Maximum size is 25 MB.');
      return;
    }
    setProgress('Extracting text…');
    const useOcr = ocrToggle.checked && file.name.toLowerCase().endsWith('.pdf');
    extractDocument(file, { useOcr, onProgress: setProgress })
      .then(doc => {
        extractedDocument = doc;
        renderReaderView(doc.text);
        preview.style.display = '';
        options.style.display = '';
        layoutDetails.style.display = doc.layoutBlocks && doc.layoutBlocks.length ? '' : 'none';
        if (doc.layoutBlocks && doc.layoutBlocks.length) {
          layoutPre.textContent = JSON.stringify(doc.layoutBlocks.slice(0, 50), null, 2)
            + (doc.layoutBlocks.length > 50 ? '\n…' : '');
        }
        setProgress(`Loaded ${doc.name} · ${doc.text.length.toLocaleString()} chars`);
        readerView.focus();
      })
      .catch(err => {
        setProgress('');
        showStatus('error', `Could not read document: ${err instanceof Error ? err.message : String(err)}`, true);
      });
  }

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('document-drop--active');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('document-drop--active'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('document-drop--active');
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  });

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) handleFile(file);
  });

  let lastHighlightedWord: { sentence: number; word: number } | null = null;

  function clearHighlight() {
    if (lastHighlightedWord) {
      const prevSentence = readerView.querySelector(`[data-sentence-index="${lastHighlightedWord.sentence}"]`);
      prevSentence?.classList.remove('reader-active-sentence');
      const prevWord = prevSentence?.querySelector(`[data-word-index="${lastHighlightedWord.word}"]`);
      prevWord?.classList.remove('reader-active-word');
    }
    lastHighlightedWord = null;
  }

  function applyHighlight(info: HighlightInfo) {
    if (
      lastHighlightedWord &&
      lastHighlightedWord.sentence === info.sentenceIndex &&
      lastHighlightedWord.word === info.wordIndex
    ) {
      return;
    }
    clearHighlight();
    const sentence = readerView.querySelector(`[data-sentence-index="${info.sentenceIndex}"]`);
    if (!sentence) return;
    sentence.classList.add('reader-active-sentence');
    const word = sentence.querySelector(`[data-word-index="${info.wordIndex}"]`);
    word?.classList.add('reader-active-word');
    lastHighlightedWord = { sentence: info.sentenceIndex, word: info.wordIndex };
    word?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderReaderState(state: ReaderState) {
    let statusText = `${state.currentIndex + 1}/${state.totalChunks}`;
    if (state.totalChunks > 1 && state.bufferedIndex >= 0) {
      statusText += ` · buffered ${state.bufferedIndex + 1}/${state.totalChunks}`;
    }
    readerStatus.textContent = statusText;
    if (state.status === 'playing') {
      readBtn.style.display = 'none';
      pauseBtn.style.display = '';
      stopBtn.style.display = '';
      pauseBtn.textContent = 'Pause';
    } else if (state.status === 'paused') {
      readBtn.style.display = 'none';
      pauseBtn.style.display = '';
      stopBtn.style.display = '';
      pauseBtn.textContent = 'Resume';
    } else if (state.status === 'finished') {
      readBtn.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      readerStatus.textContent = 'Finished';
      clearHighlight();
    } else {
      readBtn.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      readerStatus.textContent = '';
      clearHighlight();
    }
  }

  readBtn.addEventListener('click', () => {
    const text = extractedDocument?.text?.trim();
    if (!text) return;
    if (text.length > 20000) {
      showStatus('error', 'Text is too long to read in one session. Paste a shorter excerpt.', true);
      return;
    }
    readerSession?.stop();
    clearHighlight();
    readerSession = new DocumentReaderSession(engine, text, {
      chunkSize: 300,
      lookahead: 2,
      speed: currentSpeed,
      onStateChange: renderReaderState,
      onHighlight: applyHighlight,
    });
    readerSession.start();
  });

  pauseBtn.addEventListener('click', () => {
    if (!readerSession) return;
    if (readerSession.getState().status === 'playing') readerSession.pause();
    else readerSession.resume();
  });

  stopBtn.addEventListener('click', () => {
    readerSession?.stop();
    clearHighlight();
  });
}

function updateDocumentSectionVisibility() {
  const needModel = document.getElementById('document-need-model') as HTMLElement;
  const readBtn = document.getElementById('read-document-btn') as HTMLButtonElement;
  const canRead = engine && engine.getEngineState() === 'ready';
  if (needModel) needModel.style.display = canRead ? 'none' : '';
  readBtn.disabled = !canRead;
  readBtn.title = canRead ? 'Read extracted text aloud' : 'Load a model above before reading';
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
      updateDocumentSectionVisibility();
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
      updateDocumentSectionVisibility();
      showStatus('success', `${current?.name} is ready. Type something and hit Generate (or queue several).`);
      break;
    }

    case 'error':
      loadBtn.disabled = false;
      loadBtnLabel.textContent = 'Download & Load Model';
      generateBtn.disabled = true;
      progressBar.classList.remove('progress-bar--visible');
      progressText.classList.remove('progress-text--visible');
      updateDocumentSectionVisibility();
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

function showStatus(type: 'success' | 'error', message: string, assertive = false) {
  const container = document.getElementById('status-container')!;
  const icon = type === 'success'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

  container.innerHTML = `<div class="status-banner status-banner--${type}" role="${assertive ? 'alert' : 'status'}" aria-live="${assertive ? 'assertive' : 'polite'}">${icon}<span>${message}</span></div>`;
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

// ─── Boot ───────────────────────────────────────────────────────
render();
