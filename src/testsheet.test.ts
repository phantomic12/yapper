import { describe, expect, it } from 'vitest';
import { buildTestSheet } from './testsheet';
import type { DocumentTestAnswer } from './persistence';

const answers: DocumentTestAnswer[] = [
  { id: 'a', offset: 40, answer: 'Photosynthesis', createdAt: 0 },
  { id: 'b', offset: 0, answer: '42', createdAt: 0 },
];

const text = 'What is the answer? Explain it. What process feeds plants? Describe.';

describe('buildTestSheet', () => {
  it('numbers answers with their question context', () => {
    const sheet = buildTestSheet('quiz.txt', text, answers);
    expect(sheet).toContain('# Test sheet — quiz.txt');
    expect(sheet).toContain('1. **Answer:** Photosynthesis');
    expect(sheet).toContain('What process feeds plants?');
    expect(sheet).toContain('2. **Answer:** 42');
    expect(sheet).toContain('What is the answer?');
  });

  it('handles an empty sheet', () => {
    expect(buildTestSheet('quiz.txt', text, [])).toContain('0 answers');
  });
});
