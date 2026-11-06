/**
 * The DAISY export button, exercised through the real markup and the real
 * bindings.
 *
 * `daisy.test.ts` proves the book itself; this file proves the feature is
 * reachable at all: a control in the open-document bar rather than inside a
 * collapsed section, the same restriction guard the audiobook has, and an
 * honest message — never an empty archive — when nothing has been read aloud.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { createAppState } from '../app-state';
import type { GenerationJob } from '../engine';
import {
  clearActiveLockState,
  setActiveLockState,
  type StoredDocumentRestriction,
} from '../document-restrictions';
import { buildAppMarkup } from './layout';
import { bindDocumentEvents } from './document-panel';
import { bindDocumentRestrictions } from './document-restrictions-panel';

/** Downloads the code under test actually started, in order. */
let downloads: { name: string; blob: Blob }[] = [];
let created: Blob[] = [];

function mountReader() {
  document.body.innerHTML = buildAppMarkup({
    capability: 'none',
    selectedModelId: 'kitten-nano',
  });
  const state = createAppState();
  // Both binders the app installs: the reader controls and the restriction
  // guards (which run in the capture phase, before any control's handler).
  bindDocumentRestrictions();
  bindDocumentEvents(state);
  // The sample goes through exactly the same render path as an upload.
  (document.getElementById('document-sample-btn') as HTMLButtonElement).click();
  return state;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const notice = (): string => byId('reader-error').textContent ?? '';

/** A stored restriction that forbids one action. The digest is never checked here. */
function restriction(disabled: StoredDocumentRestriction['disabled']): StoredDocumentRestriction {
  return {
    version: 1,
    salt: 'a'.repeat(32),
    hash: 'b'.repeat(64),
    iterations: 1,
    createdAt: 0,
    disabled,
  };
}

/** A finished synthesis job belonging to the open reading session. */
function doneJob(readerSessionId: string, text: string): GenerationJob {
  const sampleRate = 24_000;
  return {
    id: `job-${readerSessionId}`,
    text,
    modelId: 'kitten-nano',
    modelName: 'Kitten',
    speed: 1,
    status: 'done',
    audio: new Float32Array(sampleRate),
    sampleRate,
    createdAt: 0,
    readerSessionId,
    readerIndex: 0,
  };
}

beforeEach(() => {
  localStorage.clear();
  downloads = [];
  created = [];
  // jsdom has neither object URLs nor real navigation, so the two platform
  // calls the download helper makes are the seam to observe.
  const url = URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  url.createObjectURL = (blob: Blob) => {
    created.push(blob);
    return `blob:daisy-${created.length}`;
  };
  url.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: created[created.length - 1]! });
  });
});

afterEach(() => {
  byId<HTMLButtonElement>('stop-document-btn')?.click();
  clearActiveLockState();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('DAISY export — reachable from the open document', () => {
  it('sits beside the audiobook export in the open-document bar', () => {
    mountReader();

    const daisy = document.getElementById('export-daisy-btn');
    expect(daisy).not.toBeNull();
    // A control inside a closed <details> cannot be clicked at all, so the
    // export must live in the bar, next to the one that already works.
    expect(daisy!.closest('details')).toBeNull();
    expect(daisy!.closest('.document-actions')).not.toBeNull();
    expect(daisy!.previousElementSibling?.id).toBe('export-audiobook-btn');
  });

  it('reports instead of downloading when nothing has been read aloud', () => {
    mountReader();

    byId<HTMLButtonElement>('export-daisy-btn').click();

    expect(downloads).toHaveLength(0);
    expect(notice()).toContain('Read the document aloud first');
  });

  it('is blocked by an audio-export restriction, exactly like the audiobook', () => {
    mountReader();
    setActiveLockState({ kind: 'locked', lock: restriction(['export-audio']) });
    let reached = false;
    const daisy = byId<HTMLButtonElement>('export-daisy-btn');
    daisy.addEventListener('click', () => { reached = true; });

    daisy.click();

    // The capture guard stopped the click before the control's own handler,
    // which is the same table entry the audiobook export is blocked by.
    expect(reached).toBe(false);
    expect(downloads).toHaveLength(0);
    expect(notice()).toContain('unavailable');
  });

  it('downloads a DAISY 3 zip built from the session’s finished clips', async () => {
    const state = mountReader();
    byId<HTMLButtonElement>('silent-read-btn').click();
    const sessionId = state.readerSession!.getSessionId();
    state.currentJobs.push(doneJob(sessionId, 'The first sentence of the book.'));

    byId<HTMLButtonElement>('export-daisy-btn').click();
    await vi.waitFor(() => expect(downloads).toHaveLength(1));

    expect(downloads[0].name).toMatch(/-daisy\.zip$/);
    const zip = await JSZip.loadAsync(downloads[0].blob);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['package.opf', 'audio/ch-001.wav', 'smil/ch-001.smil']),
    );
  });
});
