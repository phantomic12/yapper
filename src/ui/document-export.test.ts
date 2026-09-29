import { describe, expect, it } from 'vitest';
import {
  buildExport,
  buildNotesExport,
  exportFilename,
  type ExportSource,
} from './document-export';

const source: ExportSource = {
  name: 'report.docx',
  text: 'First paragraph.\n\nSecond paragraph.',
  html: '<p data-off="0:16">First paragraph.</p>',
};

describe('exportFilename', () => {
  it('replaces the extension and appends when missing', () => {
    expect(exportFilename('report.docx', 'text')).toBe('report.txt');
    expect(exportFilename('report.docx', 'markdown')).toBe('report.md');
    expect(exportFilename('notes', 'html')).toBe('notes.html');
  });
});

describe('buildExport', () => {
  it('exports plain text unchanged', () => {
    const file = buildExport(source, 'text');
    expect(file.filename).toBe('report.txt');
    expect(file.mime).toBe('text/plain');
    expect(file.content).toBe(source.text);
  });

  it('wraps markdown in a heading', () => {
    const file = buildExport(source, 'markdown');
    expect(file.content).toBe('# report.docx\n\nFirst paragraph.\n\nSecond paragraph.\n');
    expect(file.mime).toBe('text/markdown');
  });

  it('wraps html in a full document and escapes names', () => {
    const file = buildExport({ ...source, name: 'a<b>.docx' }, 'html');
    expect(file.content).toContain('<!DOCTYPE html>');
    expect(file.content).toContain('<title>a&lt;b&gt;.docx</title>');
    expect(file.content).toContain(source.html!);
  });

  it('falls back to escaped text when there is no markup', () => {
    const file = buildExport({ name: 'n.txt', text: '<script>' }, 'html');
    expect(file.content).toContain('&lt;script&gt;');
  });
});

describe('buildNotesExport', () => {
  it('renders bookmarks and highlights with quotes', () => {
    const file = buildNotesExport(
      source,
      [{ label: 'Key point', offset: 0, note: 'remember this' }],
      [{ start: 0, end: 5, color: 'yellow' }],
    );
    expect(file.filename).toBe('report-notes.md');
    expect(file.content).toContain('# Notes — report.docx');
    expect(file.content).toContain('- **Key point** (at 0)');
    expect(file.content).toContain('  - remember this');
    expect(file.content).toContain('(yellow) “First”');
  });

  it('says so when there is nothing to export', () => {
    const file = buildNotesExport(source, [], []);
    expect(file.content).toContain('_No bookmarks or highlights yet._');
  });
});
