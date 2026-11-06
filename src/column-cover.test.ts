/**
 * The self-test state machine.
 *
 * The whole value of covering a column is that the answer stays hidden until
 * the reader asks for it, so the assertions here are mostly about what does
 * *not* change: a stray reveal, a mode switch that keeps old reveals, or a
 * cover that survives a fresh quiz would each leak an answer the reader was
 * still working out.
 */

import { describe, expect, it } from 'vitest';
import {
  INITIAL_COVER_STATE,
  coverActionLabel,
  coverStatusText,
  isCovered,
  reduceCover,
  revealedCount,
  type CoverState,
} from './column-cover';

const start = (ids: string[], field: 'note' | 'cue' = 'note'): CoverState =>
  reduceCover(INITIAL_COVER_STATE, { type: 'start', field });

describe('column-cover — covering a column', () => {
  it('starts inactive, with nothing hidden', () => {
    expect(INITIAL_COVER_STATE.active).toBe(false);
    expect(isCovered(INITIAL_COVER_STATE, 'n1')).toBe(false);
  });

  it('covers every note when the self-test starts', () => {
    const state = start(['n1', 'n2']);
    expect(state.active).toBe(true);
    expect(isCovered(state, 'n1')).toBe(true);
    expect(isCovered(state, 'n2')).toBe(true);
  });

  it('starts a fresh quiz when re-entered, dropping earlier reveals', () => {
    const revealed = reduceCover(start(['n1', 'n2']), { type: 'reveal', id: 'n1' });
    expect(revealedCount(revealed)).toBe(1);
    const restarted = reduceCover(revealed, { type: 'start' });
    expect(isCovered(restarted, 'n1')).toBe(true);
    expect(revealedCount(restarted)).toBe(0);
  });
});

describe('column-cover — revealing is deliberate', () => {
  it('reveals exactly the note that was asked for', () => {
    const state = reduceCover(start(['n1', 'n2']), { type: 'reveal', id: 'n1' });
    expect(isCovered(state, 'n1')).toBe(false);
    expect(isCovered(state, 'n2')).toBe(true);
  });

  it('ignores a repeated reveal instead of growing the list', () => {
    const once = reduceCover(start(['n1']), { type: 'reveal', id: 'n1' });
    const twice = reduceCover(once, { type: 'reveal', id: 'n1' });
    expect(twice).toBe(once);
  });

  it('cannot reveal anything while the mode is off', () => {
    const state = start(['n1']);
    const stopped = reduceCover(state, { type: 'stop' });
    expect(reduceCover(stopped, { type: 'reveal', id: 'n1' })).toBe(stopped);
    expect(isCovered(stopped, 'n1')).toBe(false);
  });

  it('reveals all only when given the ids, and only while active', () => {
    const state = start(['n1', 'n2']);
    const all = reduceCover(state, { type: 'reveal-all', ids: ['n1', 'n2'] });
    expect(isCovered(all, 'n1')).toBe(false);
    expect(isCovered(all, 'n2')).toBe(false);
    expect(reduceCover(INITIAL_COVER_STATE, { type: 'reveal-all', ids: ['n1'] }))
      .toBe(INITIAL_COVER_STATE);
  });

  it('re-hides a revealed note when the quiz is restarted', () => {
    const revealed = reduceCover(start(['n1']), { type: 'reveal', id: 'n1' });
    expect(isCovered(revealed, 'n1')).toBe(false);
    expect(isCovered(reduceCover(revealed, { type: 'stop' }), 'n1')).toBe(false);
    expect(isCovered(reduceCover(revealed, { type: 'start' }), 'n1')).toBe(true);
  });
});

describe('column-cover — choosing the covered column', () => {
  it('switches which column is hidden and re-covers it', () => {
    const revealed = reduceCover(start(['n1']), { type: 'reveal', id: 'n1' });
    const cues = reduceCover(revealed, { type: 'set-field', field: 'cue' });
    expect(cues.field).toBe('cue');
    expect(revealedCount(cues)).toBe(0);
    expect(isCovered(cues, 'n1')).toBe(true);
  });

  it('does nothing when the field is unchanged', () => {
    const state = start(['n1']);
    expect(reduceCover(state, { type: 'set-field', field: 'note' })).toBe(state);
  });

  it('keeps the chosen field when the quiz restarts', () => {
    const cues = reduceCover(start(['n1'], 'cue'), { type: 'stop' });
    expect(reduceCover(cues, { type: 'start' }).field).toBe('cue');
  });
});

describe('column-cover — announcing state', () => {
  it('says nothing while the mode is off', () => {
    expect(coverStatusText(INITIAL_COVER_STATE, ['n1', 'n2'])).toBe('');
  });

  it('counts what is covered and what has been revealed', () => {
    const state = reduceCover(start(['n1', 'n2', 'n3']), { type: 'reveal', id: 'n2' });
    expect(coverStatusText(state, ['n1', 'n2', 'n3']))
      .toBe('Self-test on — 2 of 3 notes covered, 1 revealed.');
  });

  it('stops counting a note that no longer exists', () => {
    const state = reduceCover(start(['n1', 'n2']), { type: 'reveal', id: 'n1' });
    expect(coverStatusText(state, ['n2']))
      .toBe('Self-test on — 1 of 1 notes covered, 0 revealed.');
  });

  it('names the cue column when that is what is hidden', () => {
    expect(coverStatusText(start(['n1'], 'cue'), ['n1']))
      .toBe('Self-test on — 1 of 1 cues covered, 0 revealed.');
  });

  it('says so when there is nothing to cover', () => {
    expect(coverStatusText(start([]), []))
      .toBe('Self-test is on, but there are no three-column notes to cover yet.');
  });

  it('never quotes the hidden text, only the action', () => {
    expect(coverActionLabel('note')).toBe('Reveal note');
    expect(coverActionLabel('cue')).toBe('Reveal text cue');
  });
});
