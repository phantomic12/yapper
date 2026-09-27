import { MODELS, visibleModels, LANGUAGE_NAMES, getSupportedLanguages } from '../engine';
import { CAPABILITY_INFO, type CapabilityClass } from '../capability';
import { QUALITY_PRESETS, presetForModel } from '../quality-presets';

export interface LayoutOptions {
  /** Three-class WebGPU capability of this browser ('none' | 'partial' | 'full'). */
  capability: CapabilityClass;
  selectedModelId: string;
}

/** Build the full app markup (shell + pages). Behavior-preserving extract from main. */
export function buildAppMarkup(opts: LayoutOptions): string {
  const { capability, selectedModelId } = opts;
  const capInfo = CAPABILITY_INFO[capability];
  // Hidden entries (SpeechT5) still resolve by id so a persisted selection
  // keeps working, but the grid only ever lists pickable models.
  const selectedModel = MODELS.find(m => m.id === selectedModelId);
  // Which quality preset (if any) matches the selected model. A model off the
  // ladder — an MMS language model picked in the advanced grid — lights up no
  // preset, and the bottom bar says "Custom". That is the truthful answer.
  const activePreset = presetForModel(selectedModelId);
  const activePresetDef = QUALITY_PRESETS.find(p => p.id === activePreset);
  // Main-thread models (SpeechT5, MMS) freeze the UI during synthesis —
  // warn up front so the choice is honest (see docs/capability-banner.md).
  const showMainThreadWarning = !!selectedModel?.runsOnMainThread;

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
        <nav class="page-nav" role="tablist" aria-label="Pages">
          <button class="page-nav__tab page-nav__tab--active" type="button" role="tab" data-page-target="studio" aria-selected="true" aria-controls="page-studio">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Studio
          </button>
          <button class="page-nav__tab" type="button" role="tab" data-page-target="reader" aria-selected="false" aria-controls="page-reader">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
            Document Reader
          </button>
        </nav>

      </header>

      <!-- GPU Status + theme control. Technical detail: advanced view only,
           but the theme toggle lives here so it needs a home in simple mode. -->
      <div class="gpu-status" data-advanced role="status" aria-live="polite" title="${capInfo.detail}">
        <div class="gpu-status__dot ${capability === 'full' ? 'gpu-status__dot--on' : capability === 'partial' ? 'gpu-status__dot--partial' : 'gpu-status__dot--off'}"></div>
        <span class="gpu-status__label">${capInfo.label}</span>
      </div>

      <!-- ══════════ Studio page ══════════ -->
      <div class="page" id="page-studio" role="tabpanel" aria-label="Studio">

      <!-- Main-thread warning: honest about UI freezes during synthesis (AC2).
           Hidden by default; re-shown/hidden when the selection changes. -->
      <div class="main-thread-warning" id="main-thread-warning" role="alert" style="${showMainThreadWarning ? '' : 'display:none'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>${selectedModel?.name ?? 'This model'} runs on the main thread — generation may briefly freeze the page while it synthesizes audio. Kokoro and Kitten stay responsive in a background worker.</span>
      </div>

      <!-- Half-precision notice: shown only when the adapter exists but lacks
           shader-f16, so fp16 model cards silently fall back to the int8 build.
           Hidden by default because the adapter probe is async;
           updatePrecisionWarning fills in the copy once it resolves.

           The warning is never behind the toggle — it is true regardless of
           which view you are in — but its *register* is. data-simple copy is
           the consequence ("High runs the standard build instead"), for the
           short path; the data-advanced copy is the mechanism, the model
           names and the exact byte counts. Exactly one is on screen at a
           time, so the banner is a single sentence in either view. -->
      <div class="gpu-f16-warning" id="f16-warning" role="status" style="display:none">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/></svg>
        <span data-role="f16-copy" data-simple></span>
        <span data-role="f16-copy-detail" data-advanced></span>
      </div>

      <!-- Model Selection -->
      <label class="section-label" data-advanced for="language-filter">Filter models by language</label>

      <!-- Language filter (populated from MODELS registry; see getSupportedLanguages) -->
      <div class="select-wrapper language-select-wrapper" data-advanced>
        <select id="language-filter" class="lang-select" aria-label="Filter models by language">
          <option value="all" selected>All languages</option>
          ${getSupportedLanguages().map(code =>
            `<option value="${code}">${LANGUAGE_NAMES[code] ?? code.toUpperCase()}</option>`
          ).join('')}
        </select>
      </div>

      <!-- Quality presets: the one model knob in the default view. Each maps
           to a real model (see src/quality-presets.ts) so it stays honest;
           the full model grid lives in the advanced panel behind the bottom
           bar's More toggle. The blurb sells the outcome; the download size
           sits in a data-advanced chip (and out of the tooltip, which is
           still the simple view) so a size figure never reaches the person
           who only wanted the sentence read back. -->
      <div class="quality-row">
        <div class="quality-label" id="quality-label">Quality</div>
        <div class="quality-presets" id="quality-presets" role="radiogroup" aria-labelledby="quality-label">
          ${QUALITY_PRESETS.map(p => {
            const active = p.id === activePreset;
            return `
            <button class="quality-preset ${active ? 'quality-preset--active' : ''}" type="button"
                    role="radio" data-quality="${p.id}" aria-checked="${active}" tabindex="${active ? 0 : -1}"
                    title="${p.label} quality — ${p.blurb}">
              <span class="quality-preset__label">${p.label}</span>
              <span class="quality-preset__blurb">${p.blurb}</span>
              <span class="quality-preset__size" data-advanced>~${p.sizeMB}MB</span>
            </button>`;
          }).join('')}
        </div>
      </div>

      <!-- The grid is advanced-only as a whole; the per-card size/variant
           chips carry data-advanced as well so the "no memory figures in
           the simple view" rule holds on the figure itself, not just on the
           region that happens to contain it today. -->
      <div class="model-grid" id="model-grid" data-advanced role="radiogroup" aria-label="Choose a TTS model">
        ${visibleModels().map(m => `
          <div class="model-card ${m.id === selectedModelId ? 'model-card--selected' : ''}" data-model-id="${m.id}" data-language="${m.language ?? 'en'}" role="radio" tabindex="0" aria-checked="${m.id === selectedModelId}">
            <button class="model-card__pick" type="button" data-action="pick" aria-label="Select ${m.name}">
              <div class="model-card__name">${m.name}</div>
              <div class="model-card__desc">${m.description}</div>
              <div class="model-card__meta">
                ${m.variant ? `<span class="model-card__variant" data-advanced>${m.variant}</span>` : ''}
                ${m.sizeMB ? `<span class="model-card__size" data-advanced>~${m.sizeMB}MB</span>` : ''}
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
        <div class="voice-hint">Press <strong>Hear it</strong> on any voice to hear a sample, then pick the one you like.</div>
        <div class="voice-grid" id="voice-grid" role="radiogroup" aria-labelledby="voice-section-label"></div>
        <div class="custom-voice-input" id="custom-voice-input" style="display:none">
          <input type="url" id="custom-voice-url" placeholder="https://example.com/your-speaker-embedding.bin" />
          <div class="custom-voice-hint">512-dim Float32 xvector. Generate one with the SpeechT5 reference script.</div>
        </div>
      </div>

      <!-- Load Button -->
      <button class="load-btn" id="load-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span id="load-btn-label">Download model</span>
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
          aria-describedby="char-count"
        >The future of text-to-speech is private, fast, and runs entirely in your browser. No cloud, no tracking, no compromise.</textarea>
        <span class="char-count" id="char-count" aria-live="polite">0 / 2000</span>
      </div>

      <div class="generate-row">
        <button class="generate-btn" id="generate-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          <span id="generate-btn-label">Add to queue</span>
        </button>
        <!-- Generation liveness (AC4): visible the whole time a job is
             generating, even when a main-thread model freezes timers. -->
        <div class="generation-feedback" id="generation-feedback" role="status" aria-live="polite">
          <span class="generation-feedback__dot" aria-hidden="true"></span>
          <span id="generation-feedback-text">Generating…</span>
        </div>
        <button class="stream-btn" id="stream-btn" title="Speak the text while it generates">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span id="stream-btn-label">Play</span>
        </button>
        <span class="queue-count" id="queue-count" hidden></span>
        <button class="clear-btn" data-advanced id="download-all-btn" disabled title="Download every finished clip as one WAV">Download all</button>
        <button class="clear-btn" data-advanced id="clear-btn" disabled>Clear finished</button>
        <span class="storage-usage" data-advanced id="storage-usage" title="Clips kept for you between visits. The oldest audio is dropped once the budget is reached."></span>
      </div>

      <!-- Streaming playback controller: visible while a Play session runs. -->
      <div class="stream-bar" id="stream-bar" hidden>
        <button class="document-btn" id="stream-pause-btn" type="button">Pause</button>
        <button class="document-btn" id="stream-stop-btn" type="button">Stop</button>
        <span class="stream-bar__status" id="stream-status-text" role="status" aria-live="polite"></span>
        <span class="stream-bar__speaking" id="stream-speaking"></span>
      </div>

      <!-- Speed slider -->
      <div class="speed-row" data-advanced>
        <label for="speed-slider" class="speed-label">Speed</label>
        <input type="range" id="speed-slider" min="0.5" max="2.0" step="0.05" value="1.0" />
        <span class="speed-value" id="speed-value">1.00x</span>
        <div class="speed-hint">0.5x – 2.0x. Kokoro/Kitten use native speed; SpeechT5/MMS resample.</div>
      </div>

      <!-- Job list -->
      <div class="section-label" id="queue-label" style="display:none">Queue</div>
      <div class="job-list" id="job-list"></div>

      </div>

      <!-- ══════════ Document Reader page ══════════ -->
      <div class="page" id="page-reader" role="tabpanel" aria-label="Document Reader">
        <section class="reader-page" aria-labelledby="reader-page-heading">
          <div class="reader-page__hero">
            <h2 class="reader-page__title" id="reader-page-heading">Document Reader</h2>
            <p class="reader-page__subtitle">
              Drop in a document — Yapper extracts the text, scans it with OCR when needed,
              classifies every block, and reads it aloud. Everything happens on your device.
            </p>
          </div>

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

          <p class="document-sample" id="document-sample">
            No document handy? <button type="button" class="link-btn" id="document-sample-btn">Read a sample</button>
            to see how the reader works.
          </p>

          <div class="document-need-model" id="document-need-model">
            <p>📄 Upload a document to see its structure and extracted text. To hear it read aloud, <button type="button" class="link-btn" data-page-jump="studio">load a model on the Studio page</button> first.</p>
          </div>

          <div class="document-options" id="document-options" data-advanced style="display:none">
            <label class="switch">
              <input type="checkbox" id="ocr-toggle" />
              <span class="switch__track"></span>
              <span class="switch__label">Use OCR for scanned PDFs (experimental, slower)</span>
            </label>
            <div class="ocr-mode-selector" id="ocr-mode-selector" style="display:none">
              <span class="ocr-mode-label">OCR engine:</span>
              <label class="ocr-mode-option">
                <input type="radio" name="ocr-mode" value="tesseract" checked />
                <span>Tesseract (fast, ~4MB)</span>
              </label>
              <label class="ocr-mode-option">
                <input type="radio" name="ocr-mode" value="llm" />
                <span>Florence-2 LLM (smart, ~200MB download)${capability !== 'full' ? ' — slow on CPU' : ''}</span>
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
            <div class="reader-error" id="reader-error" role="alert" hidden></div>

            <!-- Classified document structure -->
            <div class="classify-panel" id="classify-panel" hidden>
              <div class="section-label">Document structure</div>
              <div class="classify-chips" id="classify-chips"></div>
              <div class="classify-list" id="classify-list"></div>
            </div>

            <label class="section-label" for="document-reader-view">Extracted text</label>
            <div id="document-reader-view" class="reader-view" role="region" aria-label="Document text" aria-live="off" tabindex="0"></div>
            <p class="document-hint" id="document-text-hint">The active sentence is highlighted as it is read aloud.</p>
          </div>

          <details class="layout-details" id="layout-details" style="display:none">
            <summary>Raw OCR layout blocks</summary>
            <pre class="layout-pre" id="layout-pre" tabindex="0"></pre>
          </details>
        </section>
      </div>

      <footer class="footer">
        <p class="footer__text">
          Models loaded from <a href="https://huggingface.co" target="_blank" rel="noopener noreferrer">Hugging Face</a> •
          Powered by <a href="https://huggingface.co/docs/transformers.js" target="_blank" rel="noopener noreferrer">Transformers.js</a> +
          <a href="https://onnxruntime.ai" target="_blank" rel="noopener noreferrer">ONNX Runtime</a> •
          <a href="https://github.com/phantomic12/yapper" target="_blank" rel="noopener noreferrer">Source</a>
        </p>
      </footer>

      <!-- Bottom bar: the home for settings a newcomer does not need on
           screen. The More toggle reveals every data-advanced region inline
           (model grid, language filter, speed, downloads, storage, GPU
           readout). Theme lives here too so it stays reachable without
           entering dev mode. See src/advanced-mode.ts for the toggle. -->
      <div class="bottom-bar" id="bottom-bar">
        <div class="bottom-bar__status" title="Currently selected voice model">
          <span class="bottom-bar__model" id="bottom-bar-model">${selectedModel?.name ?? 'Voice model'}</span>
          <span class="bottom-bar__preset" id="bottom-bar-preset">${activePresetDef ? activePresetDef.label : 'Custom'}</span>
        </div>
        <div class="bottom-bar__tools">
          <button class="theme-toggle" id="theme-toggle" type="button" data-theme-choice="system">Auto</button>
          <button class="advanced-toggle" id="advanced-toggle" type="button" aria-pressed="false"
                  title="Show model choice, language filter, speed and download options">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span id="advanced-toggle-label">More</span>
          </button>
        </div>
      </div>
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
