import { MODELS, type TTSModel, type EngineState } from '../engine';
import type { AppState } from '../app-state';
import { escapeHtml, showStatus } from '../dom-utils';
import {
  PREVIEW_TEXT,
  VoicePreviewPlayer,
  createAudioSink,
  groupVoices,
  previewButtonLabel,
  supportsVoicePreview,
} from '../voice-preview';
import {
  modelIdForPreset,
  presetDef,
  presetForModel,
  type QualityPreset,
} from '../quality-presets';

const SAMPLE_TEXT =
  'The quick brown fox jumps over the lazy dog. Yapper runs entirely in your browser, with no data sent to any server.';

/**
 * One audition player for the whole page. A single <audio> element is
 * deliberate: clicking a third voice must interrupt the second, not stack a
 * second decoder on top of it. Created lazily so importing this module in a
 * test does not reach for the DOM.
 */
let previewPlayer: VoicePreviewPlayer | null = null;
/** Elapsed-time ticker for the audition button; see renderPreviewButtons. */
let previewTicker: ReturnType<typeof setInterval> | null = null;
let previewStartedAt = 0;

function getPreviewPlayer(): VoicePreviewPlayer {
  if (!previewPlayer) previewPlayer = new VoicePreviewPlayer(createAudioSink());
  return previewPlayer;
}

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

function renderVoiceCard(
  voiceId: string,
  name: string,
  detail: string,
  traits: string,
  selectedId: string | undefined,
  previewable: boolean,
  previewReady: boolean,
): string {
  const selected = voiceId === selectedId;
  // Traits belong in the accessible name even when the group heading already
  // shows them: a screen reader lands on one card, not on the whole group.
  const spoken = traits ? `${name}, ${traits}` : name;
  return `
    <div class="voice-card ${selected ? 'voice-card--selected' : ''}" data-voice-id="${voiceId}" role="radio"
         tabindex="${selected ? 0 : -1}" aria-checked="${selected}" aria-label="${escapeHtml(spoken)}">
      <button class="voice-card__pick" type="button" tabindex="-1" aria-label="Select ${escapeHtml(spoken)}">
        <span class="voice-card__name">${escapeHtml(name)}</span>
        ${detail ? `<span class="voice-card__desc">${escapeHtml(detail)}</span>` : ''}
      </button>
      ${previewable
        ? `<button class="voice-card__play" type="button" data-action="preview" data-label="Hear ${escapeHtml(name)}"
             aria-label="Hear ${escapeHtml(name)}"
             ${previewReady ? '' : 'data-blocked="1" title="Load the model first to hear these voices"'}
             >${previewButtonLabel(false)}</button>`
        : ''}
    </div>
  `;
}

/**
 * Build the voice picker for the selected model.
 *
 * Two things this fixes. A flat grid of 28 identical buttons is a wall;
 * grouping by accent and gender turns the same 28 into four scannable rows,
 * which is the question people are actually answering ("the British one",
 * "male or female"). And every card gets a "Hear it" button, because a name
 * like "Nova" tells you nothing until you have heard it.
 *
 * The DOM is rebuilt only when the model changes. Selecting a voice goes
 * through syncVoiceSelection() so a clip mid-playback is not torn out from
 * under its own button.
 */
export function renderVoiceSection(state: AppState): void {
  const section = document.getElementById('voice-section')!;
  const grid = document.getElementById('voice-grid')!;
  const customInput = document.getElementById('custom-voice-input')!;

  // An audition belongs to the model that produced it. Switching models
  // mid-clip would leave a button claiming a voice the new model lacks.
  getPreviewPlayer().stop();

  if (!state.selectedModel.voices || state.selectedModel.voices.length === 0) {
    section.style.display = 'none';
    state.selectedVoiceId = undefined;
    return;
  }

  section.style.display = '';
  const previewable = supportsVoicePreview(state.selectedModel);
  const previewReady = previewable && state.engine?.getEngineState() === 'ready';

  const groups = groupVoices(state.selectedModel.voices);
  grid.innerHTML = groups.map((group, gi) => `
    <div class="voice-group"${group.label ? ` role="group" aria-labelledby="voice-group-label-${gi}"` : ''}>
      ${group.label ? `<div class="voice-group__label" id="voice-group-label-${gi}">${escapeHtml(group.label)}</div>` : ''}
      ${group.items.map(item => renderVoiceCard(
        item.voice.id,
        item.name,
        // The group heading already says "American Female" — repeating it on
        // every card in the group is noise. Only fall back to the traits when
        // there is no heading to carry them.
        item.voice.description ?? (group.label ? '' : [item.accent, item.gender].filter(Boolean).join(' · ')),
        [item.accent, item.gender].filter(Boolean).join(', '),
        state.selectedVoiceId,
        previewable,
        previewReady,
      )).join('')}
    </div>
  `).join('');

  // Show custom URL input if "Custom" is selected
  const customVoice = state.selectedModel.voices.find(v => v.id === 'custom');
  if (customVoice) {
    customInput.style.display = state.selectedVoiceId === 'custom' ? '' : 'none';
  } else {
    customInput.style.display = 'none';
  }

  bindVoiceCardEvents(state, grid);
  renderPreviewButtons();
}

/** Move the selection without rebuilding the grid (see renderVoiceSection). */
export function syncVoiceSelection(state: AppState): void {
  document.querySelectorAll<HTMLElement>('.voice-card').forEach(card => {
    const selected = card.dataset.voiceId === state.selectedVoiceId;
    card.classList.toggle('voice-card--selected', selected);
    card.setAttribute('aria-checked', String(selected));
    card.tabIndex = selected ? 0 : -1;
  });
  const customVoice = state.selectedModel.voices?.find(v => v.id === 'custom');
  if (customVoice) {
    const customInput = document.getElementById('custom-voice-input')!;
    customInput.style.display = state.selectedVoiceId === 'custom' ? '' : 'none';
  }
}

/**
 * Enable or disable the audition buttons. An audition needs a loaded model:
 * pressing "Hear it" on a 88MB download that has not started would either do
 * nothing or kick off a silent 88MB fetch the user did not ask for.
 */
export function updateVoicePreviewAvailability(state: AppState): void {
  const ready = state.engine?.getEngineState() === 'ready';
  document.querySelectorAll<HTMLButtonElement>('.voice-card__play').forEach(btn => {
    // Two independent reasons a button can be dead, tracked separately so a
    // busy player does not overwrite the "load the model first" explanation.
    if (ready) {
      btn.removeAttribute('data-blocked');
      btn.removeAttribute('title');
    } else {
      btn.setAttribute('data-blocked', '1');
      btn.title = 'Load the model first to hear these voices';
    }
  });
  renderPreviewButtons();
}

/**
 * Repaint every "Hear it" button from the player's state. The playing
 * voice's button becomes "Stop"; while a clip is synthesising the rest are
 * disabled, because a second press could only be refused with a busy error
 * and a dead-looking button beats a rejection.
 */
function renderPreviewButtons(): void {
  const player = getPreviewPlayer();
  // An audition can take seconds, and on a struggling worker it can take
  // minutes. A button that says "…" for all of that looks exactly like a
  // dropped click, so count up instead — same reasoning as the queue's
  // generation feedback (see startGenerationFeedback).
  if (player.busy && !previewTicker) {
    previewStartedAt = Date.now();
    previewTicker = setInterval(renderPreviewButtons, 500);
  } else if (!player.busy && previewTicker) {
    clearInterval(previewTicker);
    previewTicker = null;
  }
  const elapsed = previewTicker ? Math.round((Date.now() - previewStartedAt) / 1000) : 0;
  document.querySelectorAll<HTMLElement>('.voice-card').forEach(card => {
    const btn = card.querySelector<HTMLButtonElement>('.voice-card__play');
    if (!btn) return;
    const active = player.isActive(card.dataset.voiceId!);
    const baseLabel = btn.dataset.label ?? 'Hear it';
    btn.textContent = active
      ? player.busy ? `… ${elapsed}s` : previewButtonLabel(true)
      : previewButtonLabel(false);
    btn.classList.toggle('voice-card__play--active', active);
    btn.setAttribute('aria-label', active ? baseLabel.replace(/^Hear/, 'Stop') : baseLabel);
    btn.disabled = btn.hasAttribute('data-blocked') || (player.busy && !active);
  });
}

async function auditionVoice(state: AppState, voiceId: string): Promise<void> {
  const engine = state.engine;
  if (!engine) return;
  const player = getPreviewPlayer();
  // audition() marks the voice active synchronously, before the multi-second
  // synthesis starts — so paint before awaiting, or the button sits there
  // looking exactly as it did before the click and the click reads as a no-op.
  const pending = player.audition(voiceId, id => engine.preview(PREVIEW_TEXT, id, state.currentSpeed));
  renderPreviewButtons();
  try {
    await pending;
  } catch (err) {
    // A preview that failed is not a job failure, so it must not wipe the
    // status banner the user is reading — say what happened and move on.
    showStatus('error', `Voice preview failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    renderPreviewButtons();
  }
}

function bindVoiceCardEvents(state: AppState, grid: HTMLElement): void {
  grid.querySelectorAll<HTMLElement>('.voice-card').forEach(card => {
    // One listener on the card covers both the pick button and the play
    // button inside it; the play button is identified and handled separately
    // so pressing it never also selects the voice.
    card.addEventListener('click', (e) => {
      const playBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="preview"]');
      if (playBtn) {
        e.stopPropagation();
        if (!playBtn.disabled) void auditionVoice(state, card.dataset.voiceId!);
        return;
      }
      state.selectedVoiceId = card.dataset.voiceId;
      syncVoiceSelection(state);
    });
    card.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      // Arrows roam the picker; the play button handles its own Enter/Space.
      if (target !== card) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const cards = Array.from(grid.querySelectorAll<HTMLElement>('.voice-card'));
        const idx = cards.indexOf(card);
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
        const next = cards[(idx + step + cards.length) % cards.length];
        if (next) {
          next.focus();
          next.tabIndex = 0;
          card.tabIndex = -1;
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        state.selectedVoiceId = card.dataset.voiceId;
        syncVoiceSelection(state);
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
      selectModel(state, newModel);
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

  // Quality presets: the default view's model chooser. Selecting a preset is
  // exactly the same as picking that model card, so it routes through
  // selectModel and keeps the voice grid, warnings and card states in step.
  document.querySelectorAll<HTMLButtonElement>('.quality-preset').forEach(btn => {
    const selectThis = (): void => {
      const preset = btn.dataset.quality as QualityPreset;
      const model = MODELS.find(m => m.id === modelIdForPreset(preset));
      if (model) selectModel(state, model);
    };
    btn.addEventListener('click', selectThis);
    // ARIA radio-group arrows: move focus *and* select, the way a real radio
    // group behaves (not just move focus like the model cards do).
    btn.addEventListener('keydown', (e) => {
      const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('.quality-preset'));
      const idx = btns.indexOf(btn);
      let target = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = (idx + 1) % btns.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = (idx - 1 + btns.length) % btns.length;
      if (target >= 0) {
        e.preventDefault();
        btns[target].focus();
        btns[target].click();
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

  // The f16 notice is device-level, not per-model, so it only needs the
  // adapter probe to have resolved before it can be shown.
  updatePrecisionWarning(state);
}

/**
 * Select a model and re-render everything that depends on it. Called from
 * both the model cards (advanced grid) and the quality presets (default
 * view), so it derives the card selection from the model id rather than
 * needing the clicked element passed in.
 */
function selectModel(state: AppState, newModel: TTSModel): void {
  state.selectedModel = newModel;
  // Reset voice selection to this model's default
  state.selectedVoiceId = newModel.defaultVoiceId ?? newModel.voices?.[0]?.id;
  state.customEmbeddingUrl = '';
  document.querySelectorAll<HTMLElement>('.model-card').forEach(c => {
    const isSel = c.dataset.modelId === newModel.id;
    c.classList.toggle('model-card--selected', isSel);
    c.setAttribute('aria-checked', String(isSel));
  });
  updateQualitySelection(state);
  renderVoiceSection(state);
  renderModelCardStatuses(state);
  updateMainThreadWarning(state);
  updatePrecisionWarning(state);
}

/**
 * Keep the quality-preset control and the bottom-bar readout in sync with
 * whatever model is actually selected.
 *
 * The presets are a *view* over model selection, not a second source of
 * truth: the active one is derived from `presetForModel(selectedModel.id)`.
 * Pick a model that is not on the ladder (an MMS language model in the
 * advanced grid) and no preset lights up while the bar reads "Custom" —
 * truthful rather than pretending one of Low/Med/High applies.
 */
export function updateQualitySelection(state: AppState): void {
  const activePreset = presetForModel(state.selectedModel.id);
  document.querySelectorAll<HTMLButtonElement>('.quality-preset').forEach(btn => {
    const on = btn.dataset.quality === activePreset;
    btn.classList.toggle('quality-preset--active', on);
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  const modelEl = document.getElementById('bottom-bar-model');
  if (modelEl) modelEl.textContent = state.selectedModel.name;
  const presetEl = document.getElementById('bottom-bar-preset');
  if (presetEl) presetEl.textContent = activePreset ? presetDef(activePreset)!.label : 'Custom';
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

/**
 * Tell the user when their GPU can run everything except half-precision
 * models.
 *
 * Only the `degradedGpu` case earns a warning. The obvious candidates — "your
 * CPU is slow, use a smaller model" — were measured and are false: on an
 * f16-less adapter, Kokoro's int8 graph (no f16 anywhere in it) rendered a
 * 44-character sentence in 4.8s on WASM and 5.4s on WebGPU, which is normal
 * for this model. So there is no slow-model warning to give, and inventing
 * one would be the exact dishonesty this app's banner docs exist to prevent.
 *
 * What IS worth saying: the fp16 Kokoro card promises a 156MB half-precision
 * download, and on this machine it silently becomes the 88MB int8 build
 * instead. A selection that quietly isn't what it claims needs a line of copy.
 */
export function updatePrecisionWarning(state: AppState): void {
  const warning = document.getElementById('f16-warning');
  if (!warning) return;
  if (!state.acceleration.degradedGpu) {
    warning.style.display = 'none';
    return;
  }
  const copy = warning.querySelector<HTMLElement>('[data-role="f16-copy"]');
  if (copy) {
    copy.textContent =
      'This GPU can\'t run half-precision models, so fp16 variants (like '
      + 'Kokoro-82M fp16) automatically use the int8 build instead — 88MB rather '
      + 'than 156MB, with a slight quality difference. Every other model here '
      + 'runs GPU-accelerated as normal.';
  }
  warning.style.display = '';
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
  // Auditioning needs a loaded model, so the voice buttons track engine state
  // exactly as the Speak button does.
  updateVoicePreviewAvailability(state);
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
      showStatus('success', `${current?.name} is ready. Type something and hit Add to queue (or press Ctrl/Cmd+Enter).`);
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
  updateQualitySelection(state);
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
