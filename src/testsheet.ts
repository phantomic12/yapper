/**
 * The filled-in test sheet: answers anchored to question spots in the
 * document, exported as a numbered Markdown sheet. Each item keeps the
 * question's context so the sheet reads standalone — what was asked,
 * then what was answered.
 */

import type { DocumentTestAnswer } from './persistence';
import { sentenceAround } from './vocabulary';

/** Markdown export: numbered answers, each with its question context. */
export function buildTestSheet(docName: string, docText: string, answers: DocumentTestAnswer[]): string {
  const lines = [
    `# Test sheet — ${docName}`,
    '',
    `${answers.length} answer${answers.length === 1 ? '' : 's'}`,
    '',
  ];
  answers.forEach((entry, index) => {
    const question = sentenceAround(docText, entry.offset);
    lines.push(`${index + 1.}. **Answer:** ${entry.answer}`);
    if (question) lines.push(`   *Question:* “${question}”`);
    lines.push('');
  });
  return lines.join('\n');
}
