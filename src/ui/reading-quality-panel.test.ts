import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCorrections, saveCorrections } from '../corrections';
import {
  loadHeaderFooterSuppression,
  saveHeaderFooterSuppression,
} from '../header-footer';
import { bindReadingQualityPanel } from './reading-quality-panel';

const MARKUP = `
  <textarea id="corrections-list"></textarea>
  <button id="corrections-save-btn">Save</button>
  <button id="corrections-clear-btn">Clear</button>
  <button id="corrections-export-btn">Export</button>
  <input id="corrections-import-input" type="file" />
  <input id="strip-margins-toggle" type="checkbox" />
  <span id="corrections-status"></span>
`;

function textarea(): HTMLTextAreaElement {
  return document.getElementById('corrections-list') as HTMLTextAreaElement;
}

function toggle(): HTMLInputElement {
  return document.getElementById('strip-margins-toggle') as HTMLInputElement;
}

function status(): string {
  return document.getElementById('corrections-status')?.textContent ?? '';
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = MARKUP;
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('bindReadingQualityPanel', () => {
  it('does nothing when the markup is absent', () => {
    document.body.innerHTML = '';
    expect(() => bindReadingQualityPanel()).not.toThrow();
  });

  it('shows the saved rules and the suppression preference', () => {
    saveCorrections([{ find: 'rn', replace: 'm' }]);
    saveHeaderFooterSuppression(false);
    bindReadingQualityPanel();

    expect(textarea().value).toBe('rn = m');
    expect(toggle().checked).toBe(false);
    expect(status()).toContain('1 correction');
  });

  it('defaults suppression to on when nothing was saved', () => {
    bindReadingQualityPanel();
    expect(toggle().checked).toBe(true);
  });

  it('saves the editor contents and shows the canonical form', () => {
    bindReadingQualityPanel();
    textarea().value = '  rn = m \n\n# comment\nmodem => modern';
    document.getElementById('corrections-save-btn')!.click();

    expect(loadCorrections()).toEqual([
      { find: 'rn', replace: 'm', wholeWord: true },
      { find: 'modem', replace: 'modern', wholeWord: true },
    ]);
    expect(textarea().value).toBe('rn = m\nmodem = modern');
    expect(status()).toBe('2 corrections saved');
  });

  it('keeps a mid-word rule through a save round-trip', () => {
    bindReadingQualityPanel();
    textarea().value = '*rn = m';
    document.getElementById('corrections-save-btn')!.click();

    expect(loadCorrections()).toEqual([{ find: 'rn', replace: 'm', wholeWord: false }]);
    expect(textarea().value).toBe('*rn = m');
  });

  it('clears the list from the editor and from storage', () => {
    saveCorrections([{ find: 'rn', replace: 'm' }]);
    bindReadingQualityPanel();
    document.getElementById('corrections-clear-btn')!.click();

    expect(textarea().value).toBe('');
    expect(loadCorrections()).toEqual([]);
    expect(status()).toBe('Corrections cleared');
  });

  it('persists the header/footer toggle', () => {
    bindReadingQualityPanel();
    expect(loadHeaderFooterSuppression()).toBe(true);

    toggle().checked = false;
    toggle().dispatchEvent(new Event('change'));

    expect(loadHeaderFooterSuppression()).toBe(false);
    expect(status()).toContain('kept');
  });
});
