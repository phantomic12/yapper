import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { buildAppMarkup } from './layout';
import { featureLockKey } from '../feature-locks';
import {
  bindFeatureLocks,
  guardFeatureLock,
  notifyFeatureLockClosed,
  notifyFeatureLockOpened,
} from './feature-locks-panel';

// The panel hashes with real PBKDF2, so the tests supply Node's WebCrypto —
// jsdom has getRandomValues but no subtle. Going through vi.importActual keeps
// @types/node out of the project for one test-only dependency.
beforeAll(async () => {
  const nodeCrypto = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', nodeCrypto.webcrypto);
});

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, String(value)); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => store.clear(),
});

const file = new File(['a document'], 'paper two.pdf', { lastModified: 1_700_000_000_000 });
const key = featureLockKey(file);

function renderApp(): void {
  document.body.innerHTML = buildAppMarkup({ capability: 'none', selectedModelId: 'kitten-nano' });
  bindFeatureLocks();
}

function bar(): HTMLElement {
  return document.getElementById('feature-lock') as HTMLElement;
}

function status(): string {
  return document.getElementById('feature-lock-status')?.textContent ?? '';
}

function click(id: string): void {
  (document.getElementById(id) as HTMLElement).click();
}

function submit(id: string): void {
  const form = document.getElementById(id) as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

async function createLock(password = 'open sesame', actions?: string[]): Promise<void> {
  click('feature-lock-manage-btn');
  for (const input of document.querySelectorAll<HTMLInputElement>('#feature-lock-choices input')) {
    input.checked = actions ? actions.includes(input.value) : true;
  }
  (document.getElementById('feature-lock-password') as HTMLInputElement).value = password;
  (document.getElementById('feature-lock-confirm') as HTMLInputElement).value = password;
  submit('feature-lock-form');
  await vi.waitFor(() => {
    expect(bar().getAttribute('data-lock-state')).toBe('locked');
  });
}

beforeEach(() => {
  store.clear();
  document.body.className = '';
  renderApp();
  notifyFeatureLockClosed();
});

afterEach(() => {
  notifyFeatureLockClosed();
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('the lock bar', () => {
  it('stays hidden until a document with a file identity is open', () => {
    expect(bar().hidden).toBe(true);
    notifyFeatureLockOpened(null); // the built-in sample / a web page
    expect(bar().hidden).toBe(true);
  });

  it('says a document is not locked and offers to lock it', () => {
    notifyFeatureLockOpened(file);
    expect(bar().hidden).toBe(false);
    expect(bar().getAttribute('data-lock-state')).toBe('unlocked');
    expect(document.getElementById('feature-lock-state')?.textContent).toBe('Not locked');
    expect(document.getElementById('feature-lock-manage-btn')?.textContent).toContain('Lock document');
  });

  it('shows a locked document unmistakably, with every restriction named', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    expect(bar().getAttribute('data-lock-state')).toBe('locked');
    expect(document.getElementById('feature-lock-state')?.textContent).toBe('Locked document');
    expect(document.getElementById('feature-lock-badge')?.textContent).toBe('🔒');
    const detail = document.getElementById('feature-lock-detail')?.textContent ?? '';
    expect(detail).toContain('edit the recognised text');
    expect(detail).toContain('copy text out');
    expect(detail).toContain('export audio');
    expect(detail).toContain('change the reading voice');
    expect(detail).toContain('open another document');
    expect(document.body.classList.contains('document-locked')).toBe(true);
  });

  it('names only the restrictions the profile actually lists', async () => {
    notifyFeatureLockOpened(file);
    await createLock('pw', ['copy-text']);
    const detail = document.getElementById('feature-lock-detail')?.textContent ?? '';
    expect(detail).toContain('copy text out');
    expect(detail).not.toContain('export audio');
  });

  it('clears the locked styling when the document closes', async () => {
    notifyFeatureLockOpened(file);
    await createLock();
    notifyFeatureLockClosed();
    expect(bar().hidden).toBe(true);
    expect(document.body.classList.contains('document-locked')).toBe(false);
  });
});

describe('turning a lock on', () => {
  it('stores a salted digest, never the password', async () => {
    notifyFeatureLockOpened(file);
    await createLock('open sesame');

    const raw = store.get(key);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('open sesame');
    const record = JSON.parse(raw!) as Record<string, unknown>;
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.disabled).toEqual([
      'edit-text', 'copy-text', 'export-audio', 'change-voice', 'browse-documents',
    ]);
  });

  it('refuses a password that is not repeated correctly', async () => {
    notifyFeatureLockOpened(file);
    click('feature-lock-manage-btn');
    (document.getElementById('feature-lock-password') as HTMLInputElement).value = 'one';
    (document.getElementById('feature-lock-confirm') as HTMLInputElement).value = 'two';
    submit('feature-lock-form');
    await vi.waitFor(() => expect(status()).toContain('do not match'));
    expect(store.get(key)).toBeUndefined();
    expect(bar().getAttribute('data-lock-state')).toBe('unlocked');
  });

  it('refuses an empty password', async () => {
    notifyFeatureLockOpened(file);
    click('feature-lock-manage-btn');
    submit('feature-lock-form');
    await vi.waitFor(() => expect(status()).toContain('Enter a password'));
    expect(store.get(key)).toBeUndefined();
  });

  it('refuses to lock with no action selected', async () => {
    notifyFeatureLockOpened(file);
    click('feature-lock-manage-btn');
    for (const input of document.querySelectorAll<HTMLInputElement>('#feature-lock-choices input')) {
      input.checked = false;
    }
    (document.getElementById('feature-lock-password') as HTMLInputElement).value = 'pw';
    (document.getElementById('feature-lock-confirm') as HTMLInputElement).value = 'pw';
    submit('feature-lock-form');
    await vi.waitFor(() => expect(status()).toContain('at least one'));
    expect(store.get(key)).toBeUndefined();
  });
});

describe('the guards actually block actions', () => {
  it('stops an audio export before the app’s own handler runs', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    const handler = vi.fn();
    document.getElementById('export-audiobook-btn')!.addEventListener('click', handler);
    click('export-audiobook-btn');

    expect(handler).not.toHaveBeenCalled();
    expect(status()).toContain('export audio');
    expect(status()).toContain('locked');
  });

  it('stops a text export', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    const handler = vi.fn();
    document.getElementById('export-md-btn')!.addEventListener('click', handler);
    click('export-md-btn');

    expect(handler).not.toHaveBeenCalled();
    expect(status()).toContain('copy text out');
  });

  it('stops a voice change, including keyboard activation', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    const grid = document.getElementById('voice-grid')!;
    const card = document.createElement('div');
    card.className = 'voice-card';
    card.dataset.voiceId = 'voice-1';
    const pick = document.createElement('div');
    pick.className = 'voice-card__pick';
    pick.setAttribute('role', 'radio');
    card.appendChild(pick);
    grid.appendChild(card);
    // The real picker listens on the card, not the pick region.
    const handler = vi.fn();
    card.addEventListener('click', handler);

    pick.click();
    expect(handler).not.toHaveBeenCalled();
    expect(status()).toContain('change the reading voice');

    pick.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets the reader audition a voice without selecting it', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    const grid = document.getElementById('voice-grid')!;
    const card = document.createElement('div');
    card.className = 'voice-card';
    const play = document.createElement('button');
    play.dataset.action = 'preview';
    card.appendChild(play);
    grid.appendChild(card);
    const handler = vi.fn();
    play.addEventListener('click', handler);

    play.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not stop the reader copying their own password out of the lock form', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    click('feature-lock-manage-btn');
    const event = new Event('copy', { bubbles: true, cancelable: true });
    document.getElementById('feature-lock-unlock-password')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops opening another document from the drop zone', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    const handler = vi.fn();
    document.getElementById('document-drop')!.addEventListener('click', handler);
    click('document-drop');

    expect(handler).not.toHaveBeenCalled();
    expect(status()).toContain('open another document');
  });

  it('stops closing the document', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    const handler = vi.fn();
    document.getElementById('close-document-btn')!.addEventListener('click', handler);
    click('close-document-btn');

    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves controls the profile allows working', async () => {
    notifyFeatureLockOpened(file);
    await createLock('pw', ['copy-text']);

    const handler = vi.fn();
    document.getElementById('export-audiobook-btn')!.addEventListener('click', handler);
    click('export-audiobook-btn');
    expect(handler).toHaveBeenCalledTimes(1);
    // No block message was written over the creation notice.
    expect(status()).not.toContain('unavailable');
  });

  it('leaves reading aloud alone — that is the point of the lock', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    const handler = vi.fn();
    document.getElementById('read-document-btn')!.addEventListener('click', handler);
    click('read-document-btn');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('prevents copying from the document but not from the rest of the app', async () => {
    notifyFeatureLockOpened(file);
    await createLock();

    const inside = new Event('copy', { bubbles: true, cancelable: true });
    document.getElementById('document-reader-view')!.dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(true);

    const outside = new Event('copy', { bubbles: true, cancelable: true });
    document.getElementById('text-input')!.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);
  });

  it('guards in-handler callers too, not just clicks', async () => {
    notifyFeatureLockOpened(file);
    await createLock();
    expect(guardFeatureLock('export-audio')).toBe(true);
    expect(status()).toContain('export audio');
    expect(guardFeatureLock('edit-text')).toBe(true);
  });

  it('reports nothing when the action is allowed', async () => {
    notifyFeatureLockOpened(file);
    expect(guardFeatureLock('export-audio')).toBe(false);
    expect(status()).toBe('');
  });
});

describe('unlocking and removing', () => {
  it('rejects the wrong password and stays locked', async () => {
    notifyFeatureLockOpened(file);
    await createLock('right');

    click('feature-lock-manage-btn');
    (document.getElementById('feature-lock-unlock-password') as HTMLInputElement).value = 'wrong';
    submit('feature-lock-unlock-form');

    await vi.waitFor(() => expect(status()).toContain('does not match'));
    expect(bar().getAttribute('data-lock-state')).toBe('locked');
    expect(guardFeatureLock('copy-text')).toBe(true);
  });

  it('unlocks for the session with the right password and says so', async () => {
    notifyFeatureLockOpened(file);
    await createLock('right');

    click('feature-lock-manage-btn');
    (document.getElementById('feature-lock-unlock-password') as HTMLInputElement).value = 'right';
    submit('feature-lock-unlock-form');

    await vi.waitFor(() => {
      expect(bar().getAttribute('data-lock-state')).toBe('session-unlocked');
    });
    expect(status()).toContain('until this document is closed');
    expect(document.body.classList.contains('document-locked')).toBe(false);
    expect(document.getElementById('export-md-btn')!.dataset.featureLocked).toBeUndefined();
    expect(document.getElementById('export-md-btn')!.getAttribute('aria-disabled')).toBeNull();

    const handler = vi.fn();
    document.getElementById('export-md-btn')!.addEventListener('click', handler);
    click('export-md-btn');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('re-locks when the document is reopened, because the record is untouched', async () => {
    notifyFeatureLockOpened(file);
    await createLock('right');
    click('feature-lock-manage-btn');
    (document.getElementById('feature-lock-unlock-password') as HTMLInputElement).value = 'right';
    submit('feature-lock-unlock-form');
    await vi.waitFor(() => expect(bar().getAttribute('data-lock-state')).toBe('session-unlocked'));

    notifyFeatureLockOpened(file);
    expect(bar().getAttribute('data-lock-state')).toBe('locked');
    expect(guardFeatureLock('copy-text')).toBe(true);
  });

  it('locks again from the bar without touching the record', async () => {
    notifyFeatureLockOpened(file);
    await createLock('right');
    click('feature-lock-manage-btn');
    (document.getElementById('feature-lock-unlock-password') as HTMLInputElement).value = 'right';
    submit('feature-lock-unlock-form');
    await vi.waitFor(() => expect(bar().getAttribute('data-lock-state')).toBe('session-unlocked'));

    click('feature-lock-manage-btn');
    expect(bar().getAttribute('data-lock-state')).toBe('locked');
    expect(store.get(key)).toBeTruthy();
  });

  it('removes the lock only with the password', async () => {
    notifyFeatureLockOpened(file);
    await createLock('right');

    click('feature-lock-manage-btn');
    (document.getElementById('feature-lock-unlock-password') as HTMLInputElement).value = 'wrong';
    click('feature-lock-remove-btn');
    await vi.waitFor(() => expect(status()).toContain('Enter the lock password'));
    expect(store.get(key)).toBeTruthy();

    (document.getElementById('feature-lock-unlock-password') as HTMLInputElement).value = 'right';
    click('feature-lock-remove-btn');
    await vi.waitFor(() => expect(bar().getAttribute('data-lock-state')).toBe('unlocked'));
    expect(store.get(key)).toBeUndefined();
    expect(guardFeatureLock('copy-text')).toBe(false);
  });
});

describe('a corrupt record fails closed', () => {
  it('blocks everything and offers no password form', () => {
    store.set(key, '{ this is not json');
    notifyFeatureLockOpened(file);

    expect(bar().getAttribute('data-lock-state')).toBe('corrupt');
    expect(document.getElementById('feature-lock-state')?.textContent).toContain('damaged');
    expect(document.getElementById('feature-lock-manage-btn')?.hidden).toBe(true);
    expect(document.body.classList.contains('document-locked')).toBe(true);

    for (const action of ['edit-text', 'copy-text', 'export-audio', 'change-voice', 'browse-documents'] as const) {
      expect(guardFeatureLock(action)).toBe(true);
    }
  });

  it('blocks clicks even though the record cannot be read', () => {
    store.set(key, JSON.stringify({ version: 1, disabled: ['copy-text'] })); // missing digest
    notifyFeatureLockOpened(file);

    const handler = vi.fn();
    document.getElementById('export-md-btn')!.addEventListener('click', handler);
    click('export-md-btn');
    expect(handler).not.toHaveBeenCalled();
    expect(status()).toContain('damaged');
  });
});
