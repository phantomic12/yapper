// ─── Feature locks ─────────────────────────────────────────────────
// A document can be opened in a context where the reader must not change it:
// an assessment sitting, a shared machine in a classroom, a supervised
// reading. The lock is a per-document profile listing what the reader is not
// allowed to do while that document is open: edit the recognised text, copy
// it out, export audio, change the reading voice, or open a different
// document. Reading itself is never restricted — the point of the lock is
// that the document can still be read, only not altered or carried away.
//
// What this is: a guard against casual circumvention. The password is kept
// only as a salted PBKDF2-SHA-256 digest, so reading localStorage does not
// hand someone the password, and two documents that happen to share a
// password do not share a digest.
//
// What this is not: a security boundary. The reader controls the browser.
// They can open devtools, edit or delete the record, call the app's own
// functions, or load the app from source without any of this code. A lock
// that must resist that is a server-side or OS-level problem. This one keeps
// an honest reader honest and makes the restriction visible; it does not
// pretend to stop a determined one.
//
// Storage is localStorage, keyed by the same file identity document progress
// uses (see documentProgressKey), so a lock belongs to the file rather than
// to its contents. A record that cannot be parsed fails CLOSED: the document
// stays restricted rather than becoming editable because a byte was
// corrupted. See loadFeatureLock for the one case where a store that cannot
// be read at all is treated as unlocked, and why.

import { documentProgressKey } from './persistence';

// ─── The actions a lock can forbid ───────────────────────────────

export const LOCK_ACTIONS = [
  'edit-text',
  'copy-text',
  'export-audio',
  'change-voice',
  'browse-documents',
] as const;

export type LockAction = (typeof LOCK_ACTIONS)[number];

/** Reader-facing names, shared by the panel, the banner and the guards. */
export const LOCK_ACTION_LABELS: Record<LockAction, string> = {
  'edit-text': 'Edit the recognised text',
  'copy-text': 'Copy text out',
  'export-audio': 'Export audio',
  'change-voice': 'Change the reading voice',
  'browse-documents': 'Open another document',
};

export function isLockAction(value: string): value is LockAction {
  return (LOCK_ACTIONS as readonly string[]).includes(value);
}

/** What the reader may not do. The only part of a lock a user edits. */
export interface FeatureLockProfile {
  disabled: LockAction[];
}

/**
 * A stored lock: the profile plus the material needed to check a password.
 * There is deliberately no plaintext field — the password cannot be read
 * back, only verified.
 */
export interface StoredFeatureLock extends FeatureLockProfile {
  /** Record shape. An unknown version is treated as corrupt (fail closed). */
  version: 1;
  /** Hex-encoded 16 random bytes, one per lock. */
  salt: string;
  /** Hex-encoded PBKDF2-SHA-256 digest of the password. */
  hash: string;
  /** Work factor, stored so a record set yesterday still verifies. */
  iterations: number;
  createdAt: number;
}

/** What the app knows about a document's lock right now. */
export type LockState =
  | { kind: 'unlocked' }
  | { kind: 'locked'; lock: StoredFeatureLock }
  /** A record exists but cannot be trusted. Treated as "everything locked". */
  | { kind: 'corrupt'; reason: string };

export const UNLOCKED: LockState = { kind: 'unlocked' };

// ─── Storage key ──────────────────────────────────────────────────
// The identity half is borrowed from documentProgressKey by slicing its
// prefix, so the two stores can never drift apart: if the identity scheme
// changes (say a content hash replaces lastModified), the lock follows for
// free. The test suite pins that relationship.

const LOCK_PREFIX = 'yapper.feature-lock.v1:';
const PROGRESS_PREFIX = 'yapper.document-progress.v1:';

export function featureLockKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  const progressKey = documentProgressKey(file);
  const identity = progressKey.startsWith(PROGRESS_PREFIX)
    ? progressKey.slice(PROGRESS_PREFIX.length)
    : progressKey;
  return `${LOCK_PREFIX}${identity}`;
}

// ─── Validation ───────────────────────────────────────────────────
// Everything read back from storage is unknown input: another version of the
// app, a hand edit, a half-written record. parseFeatureLock accepts exactly
// one shape and rejects everything else, including unknown action names —
// an action this build does not understand may be a restriction it cannot
// enforce, so silently dropping it would quietly relax the lock.

const SALT_PATTERN = /^[0-9a-f]{32}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const MIN_ITERATIONS = 1;
/** Far above anything this module writes; a bound stops a hostile record
 *  from freezing the tab with a billion-round derivation. */
const MAX_ITERATIONS = 1_000_000;

/** Canonical order, duplicates dropped — the banner reads the same way twice. */
export function normaliseProfile(disabled: readonly LockAction[]): FeatureLockProfile {
  return { disabled: LOCK_ACTIONS.filter(action => disabled.includes(action)) };
}

export function parseFeatureLock(value: unknown): StoredFeatureLock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.version !== 1) return null;
  if (typeof record.salt !== 'string' || !SALT_PATTERN.test(record.salt)) return null;
  if (typeof record.hash !== 'string' || !HASH_PATTERN.test(record.hash)) return null;
  if (!Number.isInteger(record.iterations)) return null;
  const iterations = record.iterations as number;
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
  if (!Number.isFinite(record.createdAt)) return null;
  if (!Array.isArray(record.disabled)) return null;

  const disabled: LockAction[] = [];
  for (const entry of record.disabled) {
    if (typeof entry !== 'string' || !isLockAction(entry)) return null;
    if (!disabled.includes(entry)) disabled.push(entry);
  }

  return {
    version: 1,
    salt: record.salt.toLowerCase(),
    hash: record.hash.toLowerCase(),
    iterations,
    createdAt: record.createdAt as number,
    disabled: LOCK_ACTIONS.filter(action => disabled.includes(action)),
  };
}

// ─── Persistence ──────────────────────────────────────────────────

/**
 * Read a document's lock.
 *
 * A present-but-unparseable record is `corrupt`, and every caller must treat
 * that as "all restricted actions stay blocked" — that is the fail-closed
 * rule the feature exists for.
 *
 * A store that throws on read (storage disabled, not just empty) is treated
 * as unlocked, deliberately. We cannot tell "no lock" from "a lock we are not
 * allowed to see", and locking every document in that state would leave the
 * app unusable with no way to set or lift anything: the panel could not
 * persist a lock either. Nothing is weakened for the normal case, where the
 * store is readable and a corrupt record is caught above.
 */
export function loadFeatureLock(key: string): LockState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return UNLOCKED;
  }
  if (raw === null) return UNLOCKED;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', reason: 'The stored lock is not readable JSON.' };
  }

  const lock = parseFeatureLock(parsedJson);
  if (!lock) return { kind: 'corrupt', reason: 'The stored lock does not have a valid shape.' };
  return { kind: 'locked', lock };
}

/** Persist a lock. Returns false when the browser refused to store it. */
export function saveFeatureLock(key: string, lock: StoredFeatureLock): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(lock));
    return true;
  } catch {
    // Quota / private mode: the caller must say so rather than pretend the
    // document is locked when the next reload will not know.
    return false;
  }
}

export function clearFeatureLock(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// ─── Password hashing ─────────────────────────────────────────────

/**
 * PBKDF2 rounds. Chosen so that setting a lock costs a fraction of a second
 * on a laptop while an offline dictionary attack on the stored digest costs
 * real time. It is a door latch, not a vault: see the module header.
 */
export const DEFAULT_ITERATIONS = 150_000;

const encoder = new TextEncoder();

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // WebCrypto (and therefore PBKDF2) is only exposed in a secure context.
    // Refusing is the honest answer: the alternative is storing a digest
    // that looks like protection without being any.
    throw new Error('Locking needs a secure (https) page — this browser will not hash a password here.');
  }
  return subtle;
}

export function randomSalt(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('Locking needs a browser with secure random numbers.');
  }
  cryptoApi.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function hashFeatureLockPassword(
  password: string,
  salt: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
  const subtle = subtleCrypto();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(salt),
      iterations,
      hash: 'SHA-256',
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

/**
 * Build a lock from a password and a profile.
 *
 * Throws rather than returning a half-lock when the password is empty or the
 * browser cannot hash: a caller that ignores the throw would otherwise store
 * a record with no usable digest. The password itself is never stored.
 */
export async function createFeatureLock(
  password: string,
  disabled: readonly LockAction[],
  options: { iterations?: number; now?: number } = {},
): Promise<StoredFeatureLock> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('A lock needs a password.');
  }
  for (const action of disabled) {
    if (!isLockAction(action)) throw new Error(`Unknown lock action: ${String(action)}`);
  }
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('Invalid lock work factor.');
  }
  const salt = randomSalt();
  return {
    version: 1,
    salt,
    hash: await hashFeatureLockPassword(password, salt, iterations),
    iterations,
    createdAt: options.now ?? Date.now(),
    ...normaliseProfile(disabled),
  };
}

/**
 * Check a password against a stored lock. Any failure — wrong password, a
 * record whose salt or hash was altered, a browser without WebCrypto —
 * answers false, which leaves the document locked.
 */
export async function verifyFeatureLockPassword(
  lock: StoredFeatureLock,
  password: string,
): Promise<boolean> {
  try {
    const candidate = await hashFeatureLockPassword(password, lock.salt, lock.iterations);
    return constantTimeEqual(candidate, lock.hash);
  } catch {
    return false;
  }
}

/** Compare two digests without an early exit on the first differing byte. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!SALT_PATTERN.test(hex) && !HASH_PATTERN.test(hex)) {
    throw new Error('Invalid hex value.');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─── Decisions ────────────────────────────────────────────────────
// Pure, so every guard point in the UI asks the same question and the tests
// can answer it without a DOM.

/** Every action this state forbids. A corrupt record forbids all of them. */
export function disabledActions(state: LockState): LockAction[] {
  switch (state.kind) {
    case 'unlocked': return [];
    case 'locked': return [...state.lock.disabled];
    case 'corrupt': return [...LOCK_ACTIONS];
  }
}

export function isActionAllowed(state: LockState, action: LockAction): boolean {
  return !disabledActions(state).includes(action);
}

/** One sentence for the banner: what this state permits. */
export function describeLock(state: LockState): string {
  switch (state.kind) {
    case 'unlocked':
      return 'This document is not locked.';
    case 'corrupt':
      return 'This document’s lock record is damaged, so every restricted action stays blocked.';
    case 'locked': {
      if (state.lock.disabled.length === 0) return 'This document is locked, with nothing currently disabled.';
      const labels = state.lock.disabled.map(action => LOCK_ACTION_LABELS[action].toLowerCase());
      return `Locked against: ${labels.join(', ')}.`;
    }
  }
}

/** Why a control did nothing, in words the reader can act on. */
export function blockedActionMessage(state: LockState, action: LockAction): string {
  const label = LOCK_ACTION_LABELS[action].toLowerCase();
  if (state.kind === 'corrupt') {
    return `“${label}” is unavailable — this document’s lock record is damaged, so it stays restricted.`;
  }
  return `“${label}” is unavailable — this document is locked.`;
}

// ─── The open document's lock ─────────────────────────────────────
// The reader page, the export buttons and the job list all need the same
// answer, and threading a lock through every module would mean touching
// files that other work in this change also edits. One module-level slot,
// written by the panel when a document opens or closes, read by the guards.
// Not persisted: this is a view of the current session, not a second copy of
// the lock.

let activeLock: LockState = UNLOCKED;

export function setActiveLockState(state: LockState): void {
  activeLock = state;
}

export function getActiveLockState(): LockState {
  return activeLock;
}

export function activeLockBlocks(action: LockAction): boolean {
  return !isActionAllowed(activeLock, action);
}

/** The reason to show, or null when the action is allowed. */
export function activeLockMessage(action: LockAction): string | null {
  return activeLockBlocks(action) ? blockedActionMessage(activeLock, action) : null;
}

/** Reset the session slot — tests and a defensive call on close. */
export function clearActiveLockState(): void {
  activeLock = UNLOCKED;
}
