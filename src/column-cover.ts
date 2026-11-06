/**
 * Three-column-note self-test: the state machine behind covering a column of notes.
 *
 * The rail already holds the reader's notes and the document text they hang
 * off. Covering one of those two columns turns the rail into a quiz card:
 * the cue stays, the note is hidden behind an opaque cover, and only a
 * deliberate Reveal shows it. Keeping the transitions here rather than in the
 * rail means the rule that matters — *nothing is revealed by accident* — can
 * be tested without a DOM, and the renderer only has to ask `isCovered`.
 *
 * Reveals are per note, never global on a hover or a scroll: a self-test that
 * leaks an answer on an accidental pointer move is worse than no self-test.
 */

export type CoverField = 'note' | 'cue';

export interface CoverState {
  readonly active: boolean;
  /** Which column of the card is hidden. */
  readonly field: CoverField;
  /** Ids the reader has deliberately uncovered, in reveal order. */
  readonly revealed: readonly string[];
}

export type CoverAction =
  /** Enter self-test mode. Re-covers everything: a fresh quiz starts blank. */
  | { type: 'start'; field?: CoverField }
  | { type: 'stop' }
  /** Change which column is covered. Also re-covers: a reveal in one
   *  direction says nothing about the other. */
  | { type: 'set-field'; field: CoverField }
  | { type: 'reveal'; id: string }
  /** Uncover everything at once — an explicit "show me all" action. */
  | { type: 'reveal-all'; ids: readonly string[] };

export const INITIAL_COVER_STATE: CoverState = {
  active: false,
  field: 'note',
  revealed: [],
};

export function reduceCover(state: CoverState, action: CoverAction): CoverState {
  switch (action.type) {
    case 'start': {
      // Re-covering on every start is the point: the reader asked for a quiz,
      // not to resume a half-finished one, so nothing from the last round
      // stays visible.
      return { active: true, field: action.field ?? state.field, revealed: [] };
    }
    case 'stop':
      // Nothing is hidden once the mode is off, so the reveal list has no
      // meaning to keep — and clearing it here means a later start cannot
      // inherit a reveal from a quiz the reader already left.
      return { ...state, active: false, revealed: [] };
    case 'set-field':
      if (state.field === action.field) return state;
      return { ...state, field: action.field, revealed: [] };
    case 'reveal': {
      if (!state.active || state.revealed.includes(action.id)) return state;
      return { ...state, revealed: [...state.revealed, action.id] };
    }
    case 'reveal-all':
      if (!state.active) return state;
      return { ...state, revealed: [...action.ids] };
    default:
      return state;
  }
}

/** True when this card must be rendered with its chosen column behind a cover. */
export function isCovered(state: CoverState, id: string): boolean {
  return state.active && !state.revealed.includes(id);
}

export function revealedCount(state: CoverState): number {
  return state.revealed.length;
}

/**
 * What the live region says. Never contains the hidden text itself.
 *
 * Takes the ids currently on screen rather than a total: a note that was
 * deleted mid-quiz must not keep counting as revealed, or the announced
 * figure drifts from what the rail actually shows.
 */
export function coverStatusText(state: CoverState, ids: readonly string[]): string {
  if (!state.active) return '';
  if (ids.length === 0) {
    return 'Self-test is on, but there are no three-column notes to cover yet.';
  }
  const revealed = ids.filter(id => state.revealed.includes(id)).length;
  const covered = ids.length - revealed;
  const column = state.field === 'note' ? 'notes' : 'cues';
  return `Self-test on — ${covered} of ${ids.length} ${column} covered, ${revealed} revealed.`;
}

/**
 * The accessible name of a cover. Deliberately says what is hidden and how to
 * show it, and never quotes the hidden text: a name is read out by a screen
 * reader while the whole point is that the reader has not seen it yet.
 */
export function coverActionLabel(field: CoverField): string {
  return field === 'note' ? 'Reveal note' : 'Reveal text cue';
}
