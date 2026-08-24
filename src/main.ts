import './style.css';
import { detectCapability } from './capability';
import { registerEngines, createAppEngine } from './app-bootstrap';
import { createAppState } from './app-state';
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

  root.innerHTML = buildAppMarkup({
    capability: state.capability,
    selectedModelId: state.selectedModel.id,
  });

  renderLanguageFilter(state);
  renderModelCardStatuses(state);
  renderVoiceSection(state);
  renderJobList(state);
  updateDocumentSectionVisibility(state);

  bindModelPanelEvents(state, {
    onModelLoaded: () => updateDocumentSectionVisibility(state),
  });
  bindJobQueueEvents(state);
  bindDocumentEvents(state);
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
