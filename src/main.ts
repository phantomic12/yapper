import './style.css';
import { TTSEngine, MODELS, detectWebGPU, type TTSModel } from './engine';

// ─── DOM refs ────────────────────────────────────────────────────
const app = document.getElementById('app')!;
const root = app as HTMLDivElement;

// ─── State ───────────────────────────────────────────────────────
let engine: TTSEngine;
let selectedModel: TTSModel = MODELS[0];
let webgpuAvailable = false;
let audioContext: AudioContext | null = null;
let lastAudioBlob: Blob | null = null;

// ─── Render ──────────────────────────────────────────────────────
async function render() {
  webgpuAvailable = await detectWebGPU();

  engine = new TTSEngine({
    onStateChange: handleStateChange,
    onProgress: handleProgress,
    onError: handleError,
  }, webgpuAvailable);

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

      <!-- Load Button -->
      <button class="load-btn" id="load-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>Download & Load Model</span>
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

      <!-- Generate -->
      <button class="generate-btn" id="generate-btn" disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
        <span>Generate Speech</span>
      </button>

      <!-- Audio Player -->
      <div class="player" id="player">
        <div class="player__label">Output</div>
        <audio id="audio-element" controls></audio>
        <div class="player__actions">
          <button class="player__btn" id="download-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download WAV
          </button>
          <button class="player__btn" id="replay-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            Replay
          </button>
        </div>
      </div>

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

  bindEvents();
}

// ─── Event Binding ───────────────────────────────────────────────
function bindEvents() {
  // Model cards
  document.querySelectorAll<HTMLButtonElement>('.model-card').forEach(card => {
    card.addEventListener('click', () => {
      const modelId = card.dataset.modelId!;
      selectedModel = MODELS.find(m => m.id === modelId)!;
      document.querySelectorAll('.model-card').forEach(c => c.classList.remove('model-card--selected'));
      card.classList.add('model-card--selected');
    });
  });

  // Load model
  document.getElementById('load-btn')!.addEventListener('click', async () => {
    try {
      await engine.loadModel(selectedModel);
    } catch (err) {
      showStatus('error', `Load failed: ${err instanceof Error ? err.message : String(err)}`);
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

  // Generate
  document.getElementById('generate-btn')!.addEventListener('click', async () => {
    const text = textInput.value.trim();
    if (!text) return;

    const overlay = document.createElement('div');
    overlay.className = 'gen-overlay';
    overlay.innerHTML = `
      <div class="gen-overlay__card">
        <div class="gen-overlay__spinner"></div>
        <div class="gen-overlay__title">Generating speech…</div>
        <div class="gen-overlay__sub">Text-to-speech inference running locally</div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.offsetHeight;

    const generateBtn = document.getElementById('generate-btn') as HTMLButtonElement;
    generateBtn.disabled = true;

    const t0 = performance.now();
    try {
      const { audio, samplingRate } = await engine.generate(text, {
        speakerEmbeddings: selectedModel.speakerEmbeddings,
      });
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

      const elapsedMs = performance.now() - t0;
      const minVisible = 700;
      const holdMs = Math.max(0, minVisible - elapsedMs);
      const card = overlay.querySelector('.gen-overlay__card')!;
      card.innerHTML = `
        <div class="gen-overlay__check">✓</div>
        <div class="gen-overlay__title">Generated in ${elapsed}s</div>`;
      overlay.classList.add('gen-overlay--done');
      setTimeout(() => overlay.remove(), 200 + holdMs);

      lastAudioBlob = float32ToWav(audio, samplingRate);

      const audioUrl = URL.createObjectURL(lastAudioBlob);
      const audioEl = document.getElementById('audio-element') as HTMLAudioElement;
      audioEl.src = audioUrl;
      document.getElementById('player')!.classList.add('player--visible');
      audioEl.play();
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error('[yapper] generate failed:', err);
      const card = overlay.querySelector('.gen-overlay__card')!;
      card.innerHTML = `
        <div class="gen-overlay__check" style="background:#dc2626">✕</div>
        <div class="gen-overlay__title">Generation failed</div>
        <div class="gen-overlay__sub" style="font-family:ui-monospace,monospace;font-size:11px;max-width:520px;white-space:pre-wrap;word-break:break-word;text-align:left">${msg}</div>
        <div class="gen-overlay__sub" style="margin-top:8px">Open the browser console (F12) for the full stack.</div>`;
      overlay.classList.add('gen-overlay--done');
      setTimeout(() => overlay.remove(), 8000);
    } finally {
      generateBtn.disabled = false;
    }
  });

  // Download
  document.getElementById('download-btn')!.addEventListener('click', () => {
    if (!lastAudioBlob) return;
    const url = URL.createObjectURL(lastAudioBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yapper-${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Replay
  document.getElementById('replay-btn')!.addEventListener('click', () => {
    const audioEl = document.getElementById('audio-element') as HTMLAudioElement;
    audioEl.currentTime = 0;
    audioEl.play();
  });
}

// ─── UI Handlers ─────────────────────────────────────────────────
function handleStateChange(state: string) {
  const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
  const generateBtn = document.getElementById('generate-btn') as HTMLButtonElement;
  const textInput = document.getElementById('text-input') as HTMLTextAreaElement;
  const loadBtnLabel = loadBtn.querySelector('span')!;
  const progressBar = document.getElementById('progress-bar')!;
  const progressText = document.getElementById('progress-text')!;

  switch (state) {
    case 'idle':
      loadBtn.disabled = false;
      generateBtn.disabled = true;
      textInput.disabled = true;
      progressBar.classList.remove('progress-bar--visible');
      progressText.classList.remove('progress-text--visible');
      break;

    case 'loading':
      loadBtn.disabled = true;
      loadBtnLabel.textContent = 'Loading…';
      progressBar.classList.add('progress-bar--visible');
      progressText.classList.add('progress-text--visible');
      break;

    case 'ready':
      loadBtn.disabled = false;
      loadBtnLabel.textContent = `✓ ${selectedModel.name} loaded`;
      generateBtn.disabled = false;
      textInput.disabled = false;
      progressBar.classList.remove('progress-bar--visible');
      progressText.classList.remove('progress-text--visible');
      showStatus('success', `${selectedModel.name} is ready. Type something and hit Generate.`);
      break;

    case 'generating':
      generateBtn.disabled = true;
      break;

    case 'error':
      loadBtn.disabled = false;
      loadBtnLabel.textContent = 'Download & Load Model';
      generateBtn.disabled = true;
      progressBar.classList.remove('progress-bar--visible');
      progressText.classList.remove('progress-text--visible');
      break;
  }
}

function handleProgress(loaded: number, total: number, modelName: string) {
  const fill = document.getElementById('progress-fill')!;
  const text = document.getElementById('progress-text')!;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  const sizeMB = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';

  fill.style.width = `${pct}%`;
  text.textContent = `Downloading ${modelName}… ${pct}% (${sizeMB} MB)`;
}

function handleError(msg: string) {
  showStatus('error', `Error: ${msg}`);
}

function showStatus(type: 'success' | 'error', message: string) {
  const container = document.getElementById('status-container')!;
  const icon = type === 'success'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

  container.innerHTML = `<div class="status-banner status-banner--${type}">${icon}<span>${message}</span></div>`;
}

// ─── WAV Encoding ────────────────────────────────────────────────
function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = samples.length * bytesPerSample;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  const offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ─── Boot ────────────────────────────────────────────────────────
render();
