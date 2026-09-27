import './style.css';
import { detectCapability } from './capability';
import { registerEngines, createAppEngine } from './app-bootstrap';
import { createAppState, type AppState } from './app-state';
import { MODELS } from './engine';
import {
  loadSettings,
  saveSettings,
  persistJobs,
  restoreJobsFromStore,
} from './persistence';
import { bindStreamPlayer } from './ui/stream-player';
import { bindPageNav } from './ui/page-nav';
import { buildAppMarkup } from './ui/layout';
import {
  bindModelPanelEvents,
  handleEngineStateChange,
  handleLoadProgress,
  handleEngineError,
  renderLanguageFilter,
  renderModelCardStatuses,
  renderVoiceSection,
} from './ui/model-panel';
import { bindJobQueueEvents, renderJobList } from './ui/job-queue';
import {
  bindDocumentEvents,
  updateDocumentSectionVisibility,
} from './ui/document-panel';
import { disposeAllOcrEngines } from './ocr';
import { disposeLlmOcrEngine } from './engines/llm-ocr';

// Custom engines (Kokoro + Kitten) behind WorkerBackedEngine — once, before render.
registerEngines();

const root = document.getElementById('app') as HTMLDivElement;
const state = createAppState();

/** Apply persisted settings to fresh state before the first render. */
function applySavedSettings(appState: AppState): string {
  const saved = loadSettings();
  if (!saved) return '';
  if (saved.modelId) {
    const model = MODELS.find(m => m.id === saved.modelId);
    if (model) {
      appState.selectedModel = model;
      appState.selectedVoiceId = saved.voiceId && model.voices?.some(v => v.id === saved.voiceId)
        ? saved.voiceId
        : model.defaultVoiceId ?? model.voices?.[0]?.id;
    }
  }
  if (typeof saved.speed === 'number' && Number.isFinite(saved.speed)) {
    appState.currentSpeed = saved.speed;
  }
  if (saved.languageFilter) {
    appState.currentLanguageFilter = saved.languageFilter;
  }
  return typeof saved.draftText === 'string' ? saved.draftText : '';
}

/**
 * Keep settings + draft text in localStorage and the job history in
 * IndexedDB. Best-effort: failures never interrupt generation.
 */
function installPersistence(appState: AppState): void {
  const textInput = document.getElementById('text-input') as HTMLTextAreaElement | null;
  const saveSettingsNow = (): void => {
    saveSettings({
      modelId: appState.selectedModel.id,
      voiceId: appState.selectedVoiceId,
      speed: appState.currentSpeed,
      draftText: textInput?.value ?? '',
      languageFilter: appState.currentLanguageFilter,
    });
  };
  let settingsTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSettingsSave = (): void => {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(saveSettingsNow, 400);
  };
  // Covers typing, the speed slider, the language filter, and the
  // model/voice card clicks (which update appState in their handlers).
  document.addEventListener('input', scheduleSettingsSave);
  document.addEventListener('change', scheduleSettingsSave);
  document.addEventListener('click', scheduleSettingsSave);

  let jobsTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleJobsSave = (): void => {
    clearTimeout(jobsTimer);
    jobsTimer = setTimeout(() => {
      void persistJobs(appState.currentJobs).catch(() => undefined);
    }, 500);
  };
  appState.engine?.on('jobsChange', scheduleJobsSave);
  // Flush the job store when the page goes away.
  window.addEventListener('pagehide', () => {
    void persistJobs(appState.currentJobs).catch(() => undefined);
  });
}

async function render(): Promise<void> {
  // Three-class capability detection ('none' | 'partial' | 'full') drives
  // the honest banner wording — see src/capability.ts and
  // docs/capability-banner.md.
  state.capability = (await detectCapability()).capability;

  state.engine = createAppEngine({
    onJobsChange: (jobs) => {
      state.currentJobs = jobs;
      renderJobList(state);
    },
    onEngineStateChange: (engineState) => {
      handleEngineStateChange(state, engineState, {
        onReadyChange: () => updateDocumentSectionVisibility(state),
      });
    },
    onLoadProgress: handleLoadProgress,
    onEngineError: handleEngineError,
  });

  const draftText = applySavedSettings(state);

  root.innerHTML = buildAppMarkup({
    capability: state.capability,
    selectedModelId: state.selectedModel.id,
  });

  // Restore the draft + speed into the freshly-built controls before the
  // event binders snapshot their initial labels.
  const textInput = document.getElementById('text-input') as HTMLTextAreaElement;
  if (draftText) textInput.value = draftText;
  const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;
  const speedValue = document.getElementById('speed-value')!;
  speedSlider.value = String(state.currentSpeed);
  speedValue.textContent = `${state.currentSpeed.toFixed(2)}x`;

  renderLanguageFilter(state);
  renderModelCardStatuses(state);
  renderVoiceSection(state);
  renderJobList(state);
  updateDocumentSectionVisibility(state);

  bindModelPanelEvents(state, {
    onModelLoaded: () => updateDocumentSectionVisibility(state),
  });
  bindPageNav();
  bindJobQueueEvents(state);
  bindDocumentEvents(state);
  bindStreamPlayer(state);
  installPersistence(state);

  // Bring back the job history (including playable audio) from IndexedDB.
  void restoreJobsFromStore()
    .then(jobs => {
      if (jobs.length > 0) state.engine?.restoreJobs(jobs);
    })
    .catch(() => {
      // IndexedDB unavailable (private mode etc.) — start fresh.
    });
}

render().catch((err) => {
  console.error('[yapper] failed to boot:', err);
  root.innerHTML = `<p role="alert">Failed to start Yapper: ${
    err instanceof Error ? err.message : String(err)
  }</p>`;
});

// Catch unhandled promise rejections from anywhere in the app (worker errors,
// model download failures, etc.) so they don't silently disappear.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[yapper] Unhandled promise rejection:', event.reason);
  event.preventDefault();
});

// Clean up OCR engine workers when the page unloads to prevent memory leaks.
// Tesseract creates a Web Worker; Florence-2 holds a large WASM/model in memory.
window.addEventListener('beforeunload', () => {
  void disposeAllOcrEngines();
  disposeLlmOcrEngine();
});
