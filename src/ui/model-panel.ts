import { MODELS, type TTSModel, type EngineState } from '../engine';
import type { AppState } from '../app-state';
import { escapeHtml, showStatus } from '../dom-utils';

const SAMPLE_TEXT =
  'The quick brown fox jumps over the lazy dog. Yapper runs entirely in your browser, with no data sent to any server.';

export function renderLanguageFilter(state: AppState): void {
  const select = document.getElementById('language-filter') as HTMLSelectElement;
  if (select) select.value = state.currentLanguageFilter;
  // Show/hide model cards based on filter
  document.querySelectorAll<HTMLElement>('.model-card').forEach(card => {
    const cardLang = card.dataset.language ?? 'en';
    const visible = state.currentLanguageFilter === 'all' || cardLang === state.currentLanguageFilter;
    card.style.display = visible ? '' : 'none';
    card.setAttribute('aria-hidden', String(!visible));
  });
}

/**
 * Update the "Selected" / "Loaded" / "Select to load" label on every model
 * card. Called from the engine state handler so the UI stays in sync with
 * what is actually in memory.
 */
export function renderModelCardStatuses(state: AppState): void {
  const engine = state.engine;
  const loadedId = engine?.getCurrentModel()?.id ?? null;
  const isReady = engine?.getEngineState() === 'ready';
  document.querySelectorAll<HTMLElement>('.model-card').forEach(card => {
    const id = card.dataset.modelId;
    const isSelected = id === state.selectedModel.id;
    const isLoaded = isReady && id === loadedId;

    card.classList.toggle('model-card--loaded', isLoaded);
    const status = card.querySelector<HTMLElement>('[data-role="model-status"]');
    if (status) {
      status.textContent = isLoaded ? 'Loaded' : isSelected ? 'Selected' : 'Click to select';
    }
    // Show the "Try sample" button only on the loaded model's card, and
    // only when the engine is ready. A click on a child <button> must not
    // also trigger the parent card's radio-click, so we stop propagation.
    const sampleBtn = card.querySelector<HTMLButtonElement>('[data-action="sample"]');
    if (sampleBtn) {
      sampleBtn.hidden = !isLoaded;
      if (isLoaded) {
        sampleBtn.onclick = (e) => {
          e.stopPropagation();
          runModelSample(state);
        };
      }
    }
  });
}

export function runModelSample(state: AppState): void {
  if (!state.engine || state.engine.getEngineState() !== 'ready') return;
  state.engine.enqueue(SAMPLE_TEXT, {
    modelId: state.selectedModel.id,
    voiceId: state.selectedVoiceId,
    speed: state.currentSpeed,
  });
}

export function renderVoiceSection(state: AppState): void {
  const section = document.getElementById('voice-section')!;
  const grid = document.getElementById('voice-grid')!;
  const customInput = document.getElementById('custom-voice-input')!;

  if (!state.selectedModel.voices || state.selectedModel.voices.length === 0) {
    section.style.display = 'none';
    state.selectedVoiceId = undefined;
    return;
  }

  section.style.display = '';
  grid.innerHTML = state.selectedModel.voices.map(v => `
    <button class="voice-card ${v.id === state.selectedVoiceId ? 'voice-card--selected' : ''}" data-voice-id="${v.id}" role="radio" aria-checked="${v.id === state.selectedVoiceId}">
      <div class="voice-card__name">${escapeHtml(v.name)}</div>
      ${v.description ? `<div class="voice-card__desc">${escapeHtml(v.description)}</div>` : ''}
    </button>
  `).join('');

  // Show custom URL input if "Custom" is selected
  const customVoice = state.selectedModel.voices.find(v => v.id === 'custom');
  if (customVoice) {
    customInput.style.display = state.selectedVoiceId === 'custom' ? '' : 'none';
  } else {
    customInput.style.display = 'none';
  }

  // Bind voice card clicks
  grid.querySelectorAll<HTMLButtonElement>('.voice-card').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedVoiceId = card.dataset.voiceId;
      renderVoiceSection(state);
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

export function bindModelPanelEvents(
  state: AppState,
  opts: { onModelLoaded?: () => void } = {},
): void {
  // Bind model card clicks and keyboard nav. The card is a div with
  // role="radio" (you can't put a <button> inside a <button> — the
  // browser's HTML parser auto-closes the outer button and hoists the
  // inner one out as a sibling, breaking the layout). The inner
  // <button class="model-card__pick"> is what receives the actual
  // pointer click; the card div owns the keyboard arrow navigation.
  document.querySelectorAll<HTMLElement>('.model-card').forEach(card => {
    const pickBtn = card.querySelector<HTMLButtonElement>('[data-action="pick"]');
    pickBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const modelId = card.dataset.modelId!;
      const newModel = MODELS.find(m => m.id === modelId);
      if (!newModel) return;
      selectModel(state, newModel, card);
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

  // Custom voice URL input
  const customUrlInput = document.getElementById('custom-voice-url') as HTMLInputElement;
  customUrlInput.addEventListener('input', () => {
    state.customEmbeddingUrl = customUrlInput.value.trim();
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
      await state.engine!.loadModel(state.selectedModel);
      opts.onModelLoaded?.();
    } catch (err) {
      // Retry affordance: a failed HF download must not be a dead end —
      // the button re-runs loadModel for the same model (acceptance #1).
      showStatus(
        'error',
        `Load failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        { label: 'Retry', onClick: () => retryLoadSelectedModel(state) },
      );
    } finally {
      loadBtn.disabled = false;
    }
  });

  // Language filter
  const langSelect = document.getElementById('language-filter') as HTMLSelectElement;
  langSelect.addEventListener('change', () => {
    state.currentLanguageFilter = langSelect.value;
    renderLanguageFilter(state);
  });
}

function selectModel(state: AppState, newModel: TTSModel, card: HTMLElement): void {
  state.selectedModel = newModel;
  // Reset voice selection to this model's default
  state.selectedVoiceId = newModel.defaultVoiceId ?? newModel.voices?.[0]?.id;
  state.customEmbeddingUrl = '';
  document.querySelectorAll<HTMLElement>('.model-card').forEach(c => {
    c.classList.remove('model-card--selected');
    c.setAttribute('aria-checked', 'false');
  });
  card.classList.add('model-card--selected');
  card.setAttribute('aria-checked', 'true');
  renderVoiceSection(state);
  renderModelCardStatuses(state);
  updateMainThreadWarning(state);
}

/**
 * Show the prominent in-app warning while a main-thread model (SpeechT5,
 * MMS) is selected — generation with those models freezes the page, which
 * contradicts the non-blocking promise that holds for worker-backed models
 * unless we say so up front (acceptance criterion 2).
 */
export function updateMainThreadWarning(state: AppState): void {
  const warning = document.getElementById('main-thread-warning');
  if (!warning) return;
  if (state.selectedModel.runsOnMainThread) {
    warning.style.display = '';
    const span = warning.querySelector('span');
    if (span) {
      span.textContent =
        `${state.selectedModel.name} runs on the main thread — generation may `
        + 'briefly freeze the page while it synthesizes audio. Kokoro and Kitten '
        + 'stay responsive in a background worker.';
    }
  } else {
    warning.style.display = 'none';
  }
}

function focusVisibleModelCard(current: HTMLElement, direction: 1 | -1): void {
  const visible = Array.from(document.querySelectorAll<HTMLElement>('.model-card'))
    .filter(c => c.style.display !== 'none');
  const idx = visible.indexOf(current);
  const next = visible[idx + direction];
  next?.focus();
}

/**
 * Re-run the load for the currently selected model (Retry button target).
 * Reuses the load button's handler path so all the same disabled/label
 * bookkeeping applies; returns silently when no engine is wired yet.
 */
async function retryLoadSelectedModel(state: AppState): Promise<void> {
  if (!state.engine) return;
  const loadBtn = document.getElementById('load-btn') as HTMLButtonElement | null;
  if (loadBtn && !loadBtn.disabled) loadBtn.click();
}

export function handleEngineStateChange(
  state: AppState,
  engineState: EngineState,
  opts: { onReadyChange?: () => void } = {},
): void {
  const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
  const generateBtn = document.getElementById('generate-btn') as HTMLButtonElement;
  const textInput = document.getElementById('text-input') as HTMLTextAreaElement;
  const loadBtnLabel = document.getElementById('load-btn-label')!;
  const progressBar = document.getElementById('progress-bar')!;
  const progressText = document.getElementById('progress-text')!;
  const engine = state.engine!;

  switch (engineState) {
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
      textInput.disabled = true;
      progressBar.classList.remove('progress-bar--visible');
      progressText.classList.remove('progress-text--visible');
      break;
  }
  // Document section visibility is derived purely from engine state, so
  // we update it once per state change instead of duplicating the call
  // in every branch above.
  opts.onReadyChange?.();
  renderModelCardStatuses(state);
}

export function handleLoadProgress(loaded: number, total: number, modelName: string): void {
  const fill = document.getElementById('progress-fill')!;
  const text = document.getElementById('progress-text')!;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  const sizeMB = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';

  fill.style.width = `${pct}%`;
  // Before the first byte arrives there is no percentage to show — say what
  // we're doing instead of leaving a bare bar (no silent state >5s).
  if (loaded <= 0) {
    text.textContent = `Contacting huggingface.co for ${modelName}…`;
  } else {
    text.textContent = `Downloading ${modelName}… ${pct}% (${sizeMB} MB)`;
  }
}

export function handleEngineError(msg: string): void {
  // Assertive + Retry affordance: download failures (flaky network,
  // blocked huggingface.co) must be recoverable in one click.
  showStatus('error', msg, true, { label: 'Retry', onClick: () => {
    const loadBtn = document.getElementById('load-btn') as HTMLButtonElement | null;
    loadBtn?.click();
  } });
}
