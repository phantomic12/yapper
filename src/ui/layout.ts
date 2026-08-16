import { MODELS, LANGUAGE_NAMES, getSupportedLanguages } from '../engine';

export interface LayoutOptions {
  webgpuAvailable: boolean;
  selectedModelId: string;
}

/** Build the full app markup (shell + panels). Behavior-preserving extract from main. */
export function buildAppMarkup(opts: LayoutOptions): string {
  const { webgpuAvailable, selectedModelId } = opts;

  return `
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

      <!-- Language filter (populated from MODELS registry; see getSupportedLanguages) -->
      <div class="select-wrapper language-select-wrapper">
        <select id="language-filter" class="lang-select" aria-label="Filter models by language">
          <option value="all" selected>All languages</option>
          ${getSupportedLanguages().map(code =>
            `<option value="${code}">${LANGUAGE_NAMES[code] ?? code.toUpperCase()}</option>`
          ).join('')}
        </select>
      </div>

      <div class="model-grid" id="model-grid" role="radiogroup" aria-label="Choose a TTS model">
        ${MODELS.map(m => `
          <div class="model-card ${m.id === selectedModelId ? 'model-card--selected' : ''}" data-model-id="${m.id}" data-language="${m.language ?? 'en'}" role="radio" tabindex="0" aria-checked="${m.id === selectedModelId}">
            <button class="model-card__pick" type="button" data-action="pick" aria-label="Select ${m.name}">
              <div class="model-card__name">${m.name}</div>
              <div class="model-card__desc">${m.description}</div>
              <div class="model-card__meta">
                ${m.sizeMB ? `<span class="model-card__size">~${m.sizeMB}MB</span>` : ''}
                ${m.language && m.language !== 'en' ? `<span class="model-card__lang">${m.language.toUpperCase()}</span>` : ''}
                <span class="model-card__tag model-card__tag--${m.category}">${m.category}</span>
              </div>
              <div class="model-card__status" data-role="model-status">Selected</div>
            </button>
            <button class="model-card__sample" data-action="sample" data-model-id="${m.id}" type="button" title="Generate a sample using the currently loaded model" hidden>Try sample</button>
          </div>
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
            accept=".pdf,.docx,.doc,.odt,.rtf,.epub,.xlsx,.pptx,.csv,.html,.htm,.txt,.md,.markdown"
            aria-describedby="document-formats"
          />
          <label for="document-upload" class="document-drop__label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Drop a document here or click to upload</span>
          </label>
          <p class="document-formats" id="document-formats">PDF, DOCX, DOC, ODT, RTF, EPUB, XLSX, PPTX, CSV, HTML, TXT, MD. Max 25 MB.</p>
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
          <div class="ocr-mode-selector" id="ocr-mode-selector" style="display:none">
            <span class="ocr-mode-label">OCR engine:</span>
            <label class="ocr-mode-option">
              <input type="radio" name="ocr-mode" value="tesseract" checked />
              <span>Tesseract (fast, ~4MB)</span>
            </label>
            <label class="ocr-mode-option">
              <input type="radio" name="ocr-mode" value="llm" />
              <span>Florence-2 LLM (smart, ~200MB download)${!webgpuAvailable ? ' — slow on CPU' : ''}</span>
            </label>
          </div>
          <div class="document-progress-row" id="document-progress-row" hidden>
            <div class="document-progress-bar"><div class="document-progress-bar__fill" id="document-progress-fill"></div></div>
            <div class="document-progress" id="document-progress" role="status" aria-live="polite"></div>
          </div>
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

      <div class="generate-row">
        <button class="generate-btn" id="generate-btn" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          <span id="generate-btn-label">Add to queue</span>
        </button>
        <span class="queue-count" id="queue-count" hidden></span>
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

    <!-- Full-screen reader overlay -->
    <div class="reader-overlay" id="reader-overlay" style="display:none" role="dialog" aria-modal="true" aria-labelledby="reader-overlay-title">
      <div class="reader-overlay__header">
        <h2 class="reader-overlay__title" id="reader-overlay-title">Reading document</h2>
        <div class="reader-overlay__header-controls">
          <button class="document-btn" id="reader-overlay-pause" type="button">Pause</button>
          <button class="document-btn" id="reader-overlay-stop" type="button">Stop</button>
          <button class="document-btn" id="reader-overlay-close" type="button" aria-label="Close reader">Close</button>
        </div>
      </div>
      <div class="reader-overlay__status" id="reader-overlay-status-wrapper">
        <span class="reader-status" id="reader-overlay-status" role="status" aria-live="polite"></span>
      </div>
      <div class="reader-overlay__content" id="reader-overlay-content" role="region" aria-label="Document text" tabindex="0"></div>
      <div class="reader-overlay__legend" aria-hidden="true">
        <span class="reader-legend reader-legend--past">Read</span>
        <span class="reader-legend reader-legend--active">Current</span>
        <span class="reader-legend reader-legend--future">Upcoming</span>
      </div>
    </div>
  `;
}
