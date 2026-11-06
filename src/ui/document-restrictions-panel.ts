// ─── Document restriction panel ─────────────────────────────────────────────
// The UI half of src/document-restrictions.ts: one bar above the open document that
// says, unmistakably, whether the document is locked and what that stops; a
// password form to turn a lock on or off; and the guards that make the
// restriction real.
//
// Why the guards live here rather than in each control's own module: a lock
// has to hold for every entry point — the export buttons, the voice picker,
// the job list, the drop zone, Ctrl+C — and those live in several modules
// that other work in this change also edits. Capture-phase listeners on the
// document see the event first, so the app's own handler never runs: the
// action is blocked, not just greyed out. The few places where the handler is
// the only honest gate (an export function called from more than one button)
// also call guardDocumentRestriction() directly.
//
// The styles are injected from here for the same reason: this feature's CSS
// travels with the feature instead of growing the shared stylesheet.

import {
  LOCK_ACTIONS,
  LOCK_ACTION_LABELS,
  blockedActionMessage,
  clearDocumentRestriction,
  createDocumentRestriction,
  disabledActions,
  documentRestrictionKey,
  getActiveLockState,
  isActionAllowed,
  loadDocumentRestriction,
  saveDocumentRestriction,
  setActiveLockState,
  verifyDocumentRestrictionPassword,
  type LockAction,
  type LockState,
} from '../document-restrictions';

// ─── Module state ──────────────────────────────────────────────────
// What the reader page is currently showing. `stored` is the lock as it was
// read from localStorage; `sessionUnlocked` is the one thing that does not
// survive a reload — unlocking for the sitting leaves the record alone, so
// closing and reopening the document restores the restriction.

let currentFile: File | null = null;
let currentKey: string | null = null;
let stored: LockState = { kind: 'unlocked' };
let sessionUnlocked = false;

let guardsInstalled = false;
let boundRoot: HTMLElement | null = null;

const STATUS_ID = 'document-restriction-status';
const BAR_ID = 'document-restriction';

// ─── Small DOM helpers ────────────────────────────────────────────

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setStatus(message: string, tone: 'info' | 'error' | 'blocked' = 'info'): void {
  const node = byId<HTMLElement>(STATUS_ID);
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
}

/**
 * Say why a control did nothing. Written in two places on purpose: the lock
 * bar carries the state at the top of the document, and the reader's own
 * alert line sits directly under the top bar where the click happened — a
 * message in only one of them is easy to miss when the page is scrolled.
 */
function reportBlocked(action: LockAction): void {
  const message = `🔒 ${blockedActionMessage(getActiveLockState(), action)}`;
  setStatus(message, 'blocked');
  const alert = byId<HTMLElement>('reader-error');
  if (alert) {
    alert.textContent = message;
    alert.hidden = false;
  }
  const bar = byId<HTMLElement>(BAR_ID);
  // jsdom has no scrollIntoView; the optional call keeps the guard usable in
  // tests without a shim.
  if (typeof bar?.scrollIntoView === 'function') bar.scrollIntoView({ block: 'nearest' });
}

// ─── Styles ───────────────────────────────────────────────────────

function ensureStyles(): void {
  if (document.getElementById('document-restriction-styles')) return;
  const style = document.createElement('style');
  style.id = 'document-restriction-styles';
  style.textContent = `
    .document-restriction { margin: 0 0 10px; }
    .document-restriction__bar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
      padding: 10px 14px; border-radius: var(--radius, 10px);
      border: 1px solid var(--border); background: var(--bg-elevated);
      font-size: 0.85rem;
    }
    .document-restriction[data-lock-state='locked'] .document-restriction__bar,
    .document-restriction[data-lock-state='corrupt'] .document-restriction__bar {
      border-color: var(--danger); background: var(--danger-bg);
    }
    .document-restriction[data-lock-state='session-unlocked'] .document-restriction__bar {
      border-color: var(--warning); background: var(--warning-bg);
    }
    .document-restriction__badge { font-size: 1.1rem; line-height: 1; }
    .document-restriction__state { font-weight: 600; }
    .document-restriction__detail { flex: 1 1 240px; color: var(--text-muted); }
    .document-restriction__form {
      display: grid; gap: 10px; margin-top: 10px; padding: 12px 14px;
      border: 1px dashed var(--border); border-radius: var(--radius, 10px);
      background: var(--bg-surface);
    }
    .document-restriction__hint { margin: 0; font-size: 0.8rem; color: var(--text-muted); }
    .document-restriction__choices { display: grid; gap: 6px; }
    .document-restriction__choice { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; }
    .document-restriction__field {
      display: grid; gap: 4px; max-width: 320px;
      font-size: 0.8rem; color: var(--text-muted);
    }
    .document-restriction__field input {
      padding: 7px 9px; border-radius: var(--radius-sm, 6px);
      border: 1px solid var(--border); background: var(--bg); color: var(--text);
      font: inherit;
    }
    .document-restriction__actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .document-restriction__status { margin: 8px 0 0; min-height: 1em; font-size: 0.8rem; color: var(--text-muted); }
    .document-restriction__status[data-tone='error'],
    .document-restriction__status[data-tone='blocked'] { color: var(--danger); }
    /* A locked control looks unavailable, but stays clickable: a disabled
       button fires no click, and then the reader never learns why. */
    [data-document-restricted='true'] { opacity: 0.55; cursor: not-allowed; }
    body.document-locked .document-actions { border-bottom: 3px solid var(--danger); }
  `;
  document.head.appendChild(style);
}

// ─── Guards ───────────────────────────────────────────────────────
// One table, so "which controls does this lock cover" is a single readable
// list instead of knowledge spread across five modules.

type GuardEvent = 'click' | 'change' | 'keydown' | 'drop';

interface GuardRule {
  action: LockAction;
  selector: string;
  events: GuardEvent[];
  /** A control inside the guarded region that is not the guarded action. */
  unless?: string;
}

const GUARD_RULES: GuardRule[] = [
  // Browsing to another document: the drop zone, the file picker, the sample,
  // a web page, the recent-documents shelf, cross-document search results and
  // closing the document (which returns to the upload state).
  { action: 'browse-documents', selector: '#document-drop', events: ['click', 'drop'] },
  { action: 'browse-documents', selector: '#document-upload', events: ['click', 'change'] },
  { action: 'browse-documents', selector: '#document-sample-btn, #web-open-btn, #close-document-btn', events: ['click'] },
  { action: 'browse-documents', selector: '#web-url-input', events: ['keydown'] },
  { action: 'browse-documents', selector: '#docrecent-list button, #docsearch-results button', events: ['click'] },

  // Changing the reading voice: the voice picker, the model picker (a model
  // change is a voice change), the quality presets and the custom embedding
  // URL all route through here because the model panel is shared with other
  // work and its handlers cannot be edited for this.
  {
    action: 'change-voice',
    // The whole voice card, not just its pick region: the card's own handler
    // selects on any click outside the audition button. Hearing a voice is
    // not changing it, so the preview button is exempt.
    selector: '.voice-card, .model-card__pick, .quality-preset',
    events: ['click', 'keydown'],
    unless: '[data-action="preview"]',
  },
  { action: 'change-voice', selector: '#custom-voice-url', events: ['change'] },

  // Audio exports: the audiobook bundle, the DAISY book, "Download all", and
  // every per-job WAV / captions / karaoke download in the queue.
  {
    action: 'export-audio',
    selector: '#export-audiobook-btn, #export-daisy-btn, #download-all-btn, [data-action="download"], [data-action="download-captions"], [data-action="download-karaoke"]',
    events: ['click'],
  },

  // Text leaving the document as a file: the four document exports, the study
  // guide and the test sheet all contain the recognised text.
  {
    action: 'copy-text',
    selector: '#export-md-btn, #export-html-btn, #export-txt-btn, #export-notes-btn, #study-guide-btn, #test-sheet-btn',
    events: ['click'],
  },

  // Editing the recognised text. This build has no text editor for a
  // document, so the surfaces that can replace the recognised text are a
  // re-run of OCR (the toggle) and any contenteditable region inside the
  // document (guarded below). Both are covered rather than pretending the
  // action cannot exist.
  { action: 'edit-text', selector: '#ocr-toggle', events: ['change'] },
];

const GATED_CONTROLS: Array<[LockAction, string]> = [
  ['edit-text', '#ocr-toggle'],
  ['copy-text', '#export-md-btn, #export-html-btn, #export-txt-btn, #export-notes-btn, #study-guide-btn, #test-sheet-btn'],
  ['export-audio', '#export-audiobook-btn, #export-daisy-btn, #download-all-btn'],
  ['change-voice', '.voice-card__pick, .model-card__pick, .quality-preset, #custom-voice-url'],
  [
    'browse-documents',
    '#document-drop, #document-upload, #document-sample-btn, #web-open-btn, #close-document-btn, #docrecent-list button, #docsearch-results button',
  ],
];

function activeBlocks(action: LockAction): boolean {
  return !isActionAllowed(getActiveLockState(), action);
}

function installGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  for (const type of ['click', 'change', 'keydown', 'drop'] as const) {
    document.addEventListener(type, event => {
      // Enter/Space are the only keys that activate a picker; guarding every
      // keypress would also swallow typing in the search boxes.
      if (type === 'keydown') {
        const key = (event as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;

      const rule = GUARD_RULES.find(candidate =>
        candidate.events.includes(type) && target.closest(candidate.selector));
      if (!rule || (rule.unless && target.closest(rule.unless)) || !activeBlocks(rule.action)) return;

      event.preventDefault();
      // Capture phase runs before the control's own handler; stopping here is
      // what makes the lock a block rather than a decoration.
      event.stopImmediatePropagation();
      reportBlocked(rule.action);
    }, true);
  }

  // Copying: the copy event fires on the selection, not on the button, so it
  // needs the selection's own container rather than a selector. Cutting is
  // included because the same text path serves both.
  const onCopyOrCut = (event: Event): void => {
    if (!activeBlocks('copy-text')) return;
    // Only the document's own text surfaces. Copying a note the reader wrote,
    // or their own password out of the lock form, is not copying the document.
    const hosts = ['document-reader-view', 'document-view', 'reader-overlay-content']
      .map(id => byId<HTMLElement>(id));
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('input, textarea, #document-restriction')) return;
    const selection = document.getSelection();
    const nodes: Array<Node | null> = [
      selection?.anchorNode ?? null,
      event.target instanceof Node ? event.target : null,
    ];
    const inside = nodes.some(node => node && hosts.some(host => host?.contains(node)));
    if (!inside) return;
    event.preventDefault();
    reportBlocked('copy-text');
  };
  document.addEventListener('copy', onCopyOrCut, true);
  document.addEventListener('cut', onCopyOrCut, true);

  // Any editable region that finds its way into the document view: block the
  // input itself, not just the toolbar. beforeinput covers typing and paste
  // in every browser that supports contenteditable; the explicit paste
  // listener catches the older path.
  const blockEditing = (event: Event): void => {
    if (!activeBlocks('edit-text')) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.isContentEditable) return;
    const preview = byId<HTMLElement>('document-preview');
    if (!preview?.contains(target)) return;
    event.preventDefault();
    reportBlocked('edit-text');
  };
  document.addEventListener('beforeinput', blockEditing, true);
  document.addEventListener('paste', blockEditing, true);
}

// ─── Rendering ────────────────────────────────────────────────────

type UiState = 'unlocked' | 'locked' | 'session-unlocked' | 'corrupt';

function uiState(): UiState {
  if (stored.kind === 'corrupt') return 'corrupt';
  if (stored.kind === 'locked') return sessionUnlocked ? 'session-unlocked' : 'locked';
  return 'unlocked';
}

/** The state the guards should enforce: a session unlock is a real unlock. */
function syncActiveState(): void {
  setActiveLockState(sessionUnlocked ? { kind: 'unlocked' } : stored);
}

/**
 * Mark the controls the lock covers so a hover says why before the click, and
 * restore their original titles when the restriction lifts. Only static
 * controls are marked; job-card buttons are rebuilt by the queue and rely on
 * the capture guard plus the message.
 */
function markGatedControls(): void {
  const blocked = new Set(disabledActions(getActiveLockState()));
  for (const [action, selector] of GATED_CONTROLS) {
    for (const node of document.querySelectorAll<HTMLElement>(selector)) {
      if (blocked.has(action)) {
        node.dataset.documentRestricted = 'true';
        node.setAttribute('aria-disabled', 'true');
        if (node.dataset.lockTitle === undefined) {
          node.dataset.lockTitle = node.getAttribute('title') ?? '';
        }
        node.title = `Locked: ${LOCK_ACTION_LABELS[action].toLowerCase()} is disabled.`;
      } else {
        delete node.dataset.documentRestricted;
        node.removeAttribute('aria-disabled');
        if (node.dataset.lockTitle !== undefined) {
          const original = node.dataset.lockTitle;
          if (original) node.title = original;
          else node.removeAttribute('title');
          delete node.dataset.lockTitle;
        }
      }
    }
  }
}

function showForm(which: 'create' | 'unlock' | null): void {
  const createForm = byId<HTMLFormElement>('document-restriction-form');
  const unlockForm = byId<HTMLFormElement>('document-restriction-unlock-form');
  if (createForm) createForm.hidden = which !== 'create';
  if (unlockForm) unlockForm.hidden = which !== 'unlock';
  byId<HTMLButtonElement>('document-restriction-manage-btn')?.setAttribute('aria-expanded', String(which !== null));
  if (which === 'create') byId<HTMLInputElement>('document-restriction-password')?.focus();
  if (which === 'unlock') byId<HTMLInputElement>('document-restriction-unlock-password')?.focus();
}

function formIsOpen(which: 'create' | 'unlock'): boolean {
  const form = byId<HTMLFormElement>(which === 'create' ? 'document-restriction-form' : 'document-restriction-unlock-form');
  return !!form && !form.hidden;
}

function renderLockUi(): void {
  const bar = byId<HTMLElement>(BAR_ID);
  if (!bar) return;

  // A document with no file identity (the built-in sample, a fetched web
  // page) has nothing to key a lock to, so the bar stays out of the way.
  if (!currentKey) {
    bar.hidden = true;
    document.body.classList.remove('document-locked');
    return;
  }

  bar.hidden = false;
  const state = uiState();
  bar.dataset.lockState = state;

  const badge = byId<HTMLElement>('document-restriction-badge');
  const stateLabel = byId<HTMLElement>('document-restriction-state');
  const detail = byId<HTMLElement>('document-restriction-detail');
  const manage = byId<HTMLButtonElement>('document-restriction-manage-btn');

  switch (state) {
    case 'unlocked':
      if (badge) badge.textContent = '🔓';
      if (stateLabel) stateLabel.textContent = 'Not locked';
      if (detail) {
        detail.textContent = 'Reading is unrestricted. Lock this document to stop editing, copying, audio export, voice changes and opening other documents.';
      }
      if (manage) { manage.hidden = false; manage.textContent = 'Lock document…'; }
      document.body.classList.remove('document-locked');
      break;
    case 'locked':
      if (badge) badge.textContent = '🔒';
      if (stateLabel) stateLabel.textContent = 'Locked document';
      if (detail) detail.textContent = `${describeStoredLock()} Reading aloud still works.`;
      if (manage) { manage.hidden = false; manage.textContent = 'Unlock…'; }
      document.body.classList.add('document-locked');
      break;
    case 'session-unlocked':
      if (badge) badge.textContent = '🔓';
      if (stateLabel) stateLabel.textContent = 'Locked — unlocked until this document is closed';
      if (detail) {
        detail.textContent = 'The lock is still stored and returns the next time this document is opened.';
      }
      if (manage) { manage.hidden = false; manage.textContent = 'Lock again'; }
      document.body.classList.remove('document-locked');
      break;
    case 'corrupt':
      if (badge) badge.textContent = '🔒';
      if (stateLabel) stateLabel.textContent = 'Lock record damaged — everything restricted';
      if (detail) {
        detail.textContent = 'The stored lock cannot be read, so editing, copying, audio export, voice changes and opening other documents stay blocked.';
      }
      // No form: there is no digest to check a password against, and letting
      // one through would turn a damaged record into an open door.
      if (manage) manage.hidden = true;
      document.body.classList.add('document-locked');
      break;
  }

  markGatedControls();
}

function describeStoredLock(): string {
  if (stored.kind === 'locked') {
    const labels = stored.lock.disabled.map(action => LOCK_ACTION_LABELS[action].toLowerCase());
    return labels.length ? `Blocked: ${labels.join(', ')}.` : 'The lock currently disables nothing.';
  }
  return '';
}

// ─── Forms ────────────────────────────────────────────────────────

function buildChoices(): void {
  const host = byId<HTMLElement>('document-restriction-choices');
  if (!host) return;
  host.replaceChildren();
  for (const action of LOCK_ACTIONS) {
    const label = document.createElement('label');
    label.className = 'document-restriction__choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = action;
    input.checked = true;
    input.dataset.lockAction = action;
    const text = document.createElement('span');
    text.textContent = LOCK_ACTION_LABELS[action];
    label.append(input, text);
    host.appendChild(label);
  }
}

function selectedActions(): LockAction[] {
  const chosen: LockAction[] = [];
  for (const input of document.querySelectorAll<HTMLInputElement>('#document-restriction-choices input:checked')) {
    const value = input.value;
    if (LOCK_ACTIONS.includes(value as LockAction)) chosen.push(value as LockAction);
  }
  return chosen;
}

function busy(form: HTMLFormElement, on: boolean): void {
  for (const button of form.querySelectorAll<HTMLButtonElement>('button')) button.disabled = on;
}

function wireForms(): void {
  byId<HTMLButtonElement>('document-restriction-manage-btn')?.addEventListener('click', () => {
    const state = uiState();
    if (state === 'unlocked') {
      showForm(formIsOpen('create') ? null : 'create');
      setStatus('');
    } else if (state === 'locked') {
      showForm(formIsOpen('unlock') ? null : 'unlock');
      setStatus('');
    } else if (state === 'session-unlocked') {
      sessionUnlocked = false;
      syncActiveState();
      showForm(null);
      renderLockUi();
      setStatus('Locked again.');
    } else {
      setStatus('The lock record is damaged and cannot be verified. Clearing this site’s data removes it, along with the app’s other saved state.', 'error');
    }
  });

  byId<HTMLButtonElement>('document-restriction-cancel-btn')?.addEventListener('click', () => {
    showForm(null);
    setStatus('');
  });
  byId<HTMLButtonElement>('document-restriction-cancel-unlock-btn')?.addEventListener('click', () => {
    showForm(null);
    setStatus('');
  });

  const createForm = byId<HTMLFormElement>('document-restriction-form');
  createForm?.addEventListener('submit', event => {
    event.preventDefault();
    void turnOnLock(createForm);
  });

  const unlockForm = byId<HTMLFormElement>('document-restriction-unlock-form');
  unlockForm?.addEventListener('submit', event => {
    event.preventDefault();
    void liftLock(unlockForm);
  });

  byId<HTMLButtonElement>('document-restriction-remove-btn')?.addEventListener('click', () => {
    const form = byId<HTMLFormElement>('document-restriction-unlock-form');
    if (form) void removeLock(form);
  });
}

async function turnOnLock(form: HTMLFormElement): Promise<void> {
  if (!currentKey) return;
  const password = byId<HTMLInputElement>('document-restriction-password');
  const confirm = byId<HTMLInputElement>('document-restriction-confirm');
  const chosen = selectedActions();

  if (chosen.length === 0) {
    setStatus('Choose at least one thing the reader may not do.', 'error');
    return;
  }
  if (!password?.value) {
    setStatus('Enter a password for this lock.', 'error');
    password?.focus();
    return;
  }
  if (password.value !== confirm?.value) {
    setStatus('The two passwords do not match.', 'error');
    confirm?.focus();
    return;
  }

  busy(form, true);
  try {
    const lock = await createDocumentRestriction(password.value, chosen);
    if (!saveDocumentRestriction(currentKey, lock)) {
      // Saying "locked" here would be a lie the next reload exposes.
      setStatus('This browser refused to store the lock, so it was not turned on.', 'error');
      return;
    }
    stored = { kind: 'locked', lock };
    sessionUnlocked = false;
    syncActiveState();
    if (password) password.value = '';
    if (confirm) confirm.value = '';
    showForm(null);
    renderLockUi();
    setStatus('Lock on. The restrictions apply until this document is unlocked.');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    busy(form, false);
  }
}

async function liftLock(form: HTMLFormElement): Promise<void> {
  const state = getActiveLockState();
  const password = byId<HTMLInputElement>('document-restriction-unlock-password');
  if (state.kind !== 'locked' || !password) return;

  busy(form, true);
  try {
    const ok = await verifyDocumentRestrictionPassword(state.lock, password.value);
    if (!ok) {
      setStatus('That password does not match this document’s lock.', 'error');
      password.select();
      return;
    }
    sessionUnlocked = true;
    syncActiveState();
    password.value = '';
    showForm(null);
    renderLockUi();
    setStatus('Unlocked until this document is closed. The lock returns when it is reopened.');
  } finally {
    busy(form, false);
  }
}

async function removeLock(form: HTMLFormElement): Promise<void> {
  const state = getActiveLockState();
  const password = byId<HTMLInputElement>('document-restriction-unlock-password');
  if (!currentKey || state.kind !== 'locked' || !password) return;

  busy(form, true);
  try {
    const ok = await verifyDocumentRestrictionPassword(state.lock, password.value);
    if (!ok) {
      setStatus('Enter the lock password to remove the lock.', 'error');
      password.focus();
      return;
    }
    if (!clearDocumentRestriction(currentKey)) {
      setStatus('This browser refused to remove the stored lock.', 'error');
      return;
    }
    stored = { kind: 'unlocked' };
    sessionUnlocked = false;
    syncActiveState();
    password.value = '';
    showForm(null);
    renderLockUi();
    setStatus('Lock removed. This document is editable again.');
  } finally {
    busy(form, false);
  }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Wire the lock bar. Safe to call again after the app markup is rebuilt: the
 * document-level guards are installed once, while the form handlers are
 * re-attached only when the bar is a different element.
 */
export function bindDocumentRestrictions(): void {
  ensureStyles();
  installGuards();

  const root = byId<HTMLElement>(BAR_ID);
  if (!root || root === boundRoot) return;
  boundRoot = root;
  buildChoices();
  wireForms();
  renderLockUi();
}

/**
 * A document was opened. Loads its lock and makes the guards enforce it.
 * Called from the reader after the document (and its file) are in place.
 */
export function notifyDocumentRestrictionOpened(file: File | null): void {
  currentFile = file;
  currentKey = file ? documentRestrictionKey(file) : null;
  stored = currentKey ? loadDocumentRestriction(currentKey) : { kind: 'unlocked' };
  sessionUnlocked = false;
  syncActiveState();
  showForm(null);
  setStatus('');
  renderLockUi();
}

/** The document was closed: nothing is restricted until another opens. */
export function notifyDocumentRestrictionClosed(): void {
  currentFile = null;
  currentKey = null;
  stored = { kind: 'unlocked' };
  sessionUnlocked = false;
  syncActiveState();
  showForm(null);
  setStatus('');
  renderLockUi();
}

/**
 * In-handler guard: true means "blocked, and the reader has been told why".
 * Use it where a click is not the only way in (an exported function with
 * several callers) or where a capture guard would be too broad.
 */
export function guardDocumentRestriction(action: LockAction): boolean {
  if (!activeBlocks(action)) return false;
  reportBlocked(action);
  return true;
}

/** The file the bar is locking, for callers that need the identity back. */
export function lockedDocumentFile(): File | null {
  return currentFile;
}
