// ─── Reading-quality panel ───────────────────────────────────────
// One editor for the two extraction-time cleanups: the OCR correction list
// and repeating header/footer suppression. They share a panel because they
// share a lifecycle — both are properties of how this reader ingests a
// document, not of the document itself, and both take effect on the next
// file opened. (Re-extracting the open file would mean re-uploading it;
// the panel says so rather than pretending otherwise.)
//
// The list is plain text, one `find = replace` rule per line, so it can be
// exported, edited in any editor, and imported again. Import replaces the
// editor contents rather than merging: a reader importing a list wants that
// list, and a silent union makes a stale rule impossible to get rid of.

import {
  formatCorrectionList,
  loadCorrections,
  parseCorrectionList,
  sanitizeCorrections,
  saveCorrections,
} from '../corrections';
import {
  loadHeaderFooterSuppression,
  saveHeaderFooterSuppression,
} from '../header-footer';

function setStatus(message: string): void {
  const node = document.getElementById('corrections-status');
  if (node) node.textContent = message;
}

/** Read the current editor text as rules. */
function readRules(list: HTMLTextAreaElement): ReturnType<typeof sanitizeCorrections> {
  return sanitizeCorrections(parseCorrectionList(list.value));
}

/** Persist a rule set and show the canonical form, so typos are visible. */
function saveRules(list: HTMLTextAreaElement): number {
  const rules = readRules(list);
  saveCorrections(rules);
  list.value = formatCorrectionList(rules);
  return rules.length;
}

/**
 * Wire the panel. Safe to call on a page that lacks the markup, matching
 * every other binder in this app: tests build partial DOMs.
 */
export function bindReadingQualityPanel(): void {
  const list = document.getElementById('corrections-list') as HTMLTextAreaElement | null;
  const saveBtn = document.getElementById('corrections-save-btn');
  if (!list || !saveBtn) return;

  const clearBtn = document.getElementById('corrections-clear-btn');
  const exportBtn = document.getElementById('corrections-export-btn') as HTMLButtonElement | null;
  const importInput = document.getElementById('corrections-import-input') as HTMLInputElement | null;
  const marginToggle = document.getElementById('strip-margins-toggle') as HTMLInputElement | null;

  const stored = loadCorrections();
  list.value = formatCorrectionList(stored);
  if (stored.length) {
    setStatus(`${stored.length} correction${stored.length === 1 ? '' : 's'} active`);
  }

  if (marginToggle) {
    marginToggle.checked = loadHeaderFooterSuppression();
    marginToggle.addEventListener('change', () => {
      saveHeaderFooterSuppression(marginToggle.checked);
      setStatus(marginToggle.checked
        ? 'Repeating headers and footers will be dropped'
        : 'Page headers and footers will be kept');
    });
  }

  saveBtn.addEventListener('click', () => {
    const count = saveRules(list);
    setStatus(count
      ? `${count} correction${count === 1 ? '' : 's'} saved`
      : 'No corrections — text is used as extracted');
  });

  clearBtn?.addEventListener('click', () => {
    list.value = '';
    saveCorrections([]);
    setStatus('Corrections cleared');
  });

  exportBtn?.addEventListener('click', () => {
    // Export what is in the editor, not what was last saved: a reader who
    // edited and then exported expects their edits in the file.
    const text = formatCorrectionList(readRules(list));
    if (!text) {
      setStatus('Nothing to export');
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'yapper-ocr-corrections.txt';
      link.click();
      // Revoke on the next task: revoking synchronously can cancel a
      // download that has not been picked up by the browser yet.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus('Correction list exported');
    } catch {
      // Blob URLs are unavailable in some locked-down contexts. The editor
      // still holds the text, which is the part the reader needs.
      setStatus('Could not export — copy the text instead');
    }
  });

  importInput?.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (!file) return;
    file.text()
      .then((text) => {
        list.value = text;
        const count = saveRules(list);
        setStatus(count
          ? `Imported ${count} correction${count === 1 ? '' : 's'}`
          : 'Imported list had no usable rules');
      })
      .catch(() => setStatus('Could not read that file'))
      // Allow re-importing the same file after an edit.
      .finally(() => { importInput.value = ''; });
  });
}
