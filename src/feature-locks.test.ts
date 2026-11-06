import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { documentProgressKey } from './persistence';
import {
  LOCK_ACTIONS,
  LOCK_ACTION_LABELS,
  activeLockBlocks,
  activeLockMessage,
  blockedActionMessage,
  clearActiveLockState,
  clearFeatureLock,
  constantTimeEqual,
  createFeatureLock,
  describeLock,
  disabledActions,
  featureLockKey,
  getActiveLockState,
  hashFeatureLockPassword,
  isActionAllowed,
  loadFeatureLock,
  normaliseProfile,
  parseFeatureLock,
  saveFeatureLock,
  setActiveLockState,
  verifyFeatureLockPassword,
  type LockAction,
  type StoredFeatureLock,
} from './feature-locks';

// jsdom ships no WebCrypto, and the module deliberately refuses to hash
// without it — so the tests bring real PBKDF2 rather than a stub, which is
// what makes the salt and digest assertions mean anything. The specifier goes
// through Vitest rather than a static import so the project does not need
// @types/node for one test-only dependency.
beforeAll(async () => {
  const nodeCrypto = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', nodeCrypto.webcrypto);
});

// In-memory store with a switch for the "storage denied" path. Same approach
// as persistence.test.ts: a real Storage is not guaranteed, and this one can
// be made to fail on demand.
const store = new Map<string, string>();
let storageBroken = false;
vi.stubGlobal('localStorage', {
  getItem: (key: string) => {
    if (storageBroken) throw new Error('storage denied');
    return store.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    if (storageBroken) throw new Error('storage denied');
    store.set(key, String(value));
  },
  removeItem: (key: string) => {
    if (storageBroken) throw new Error('storage denied');
    store.delete(key);
  },
  clear: () => store.clear(),
});

const file = { name: 'paper two.pdf', size: 2048, lastModified: 1_700_000_000_000 };
const key = featureLockKey(file);

/** Low work factor: correctness of the digest, not its cost, is under test. */
const FAST = { iterations: 1_000, now: 1_700_000_000_000 };

async function makeLock(disabled: readonly LockAction[] = [...LOCK_ACTIONS]): Promise<StoredFeatureLock> {
  return createFeatureLock('open sesame', disabled, FAST);
}

beforeEach(() => {
  store.clear();
  storageBroken = false;
  clearActiveLockState();
});

describe('featureLockKey', () => {
  it('shares the document-progress identity, in its own namespace', () => {
    const progress = documentProgressKey(file);
    expect(progress).toBe('yapper.document-progress.v1:paper%20two.pdf:2048:1700000000000');
    expect(key).toBe('yapper.feature-lock.v1:paper%20two.pdf:2048:1700000000000');
    expect(key.endsWith(progress.replace('yapper.document-progress.v1:', ''))).toBe(true);
  });

  it('separates two files that differ only in size or modified time', () => {
    const other = featureLockKey({ ...file, size: file.size + 1 });
    const renamed = featureLockKey({ ...file, name: 'paper three.pdf' });
    expect(other).not.toBe(key);
    expect(renamed).not.toBe(key);
  });
});

describe('normaliseProfile', () => {
  it('keeps the canonical order no matter how the caller lists actions', () => {
    expect(normaliseProfile(['browse-documents', 'edit-text']).disabled)
      .toEqual(['edit-text', 'browse-documents']);
  });

  it('drops duplicates', () => {
    expect(normaliseProfile(['copy-text', 'copy-text']).disabled).toEqual(['copy-text']);
  });

  it('accepts an empty profile', () => {
    expect(normaliseProfile([]).disabled).toEqual([]);
  });
});

describe('parseFeatureLock', () => {
  it('accepts a record this module wrote', async () => {
    const lock = await makeLock(['copy-text']);
    expect(parseFeatureLock(JSON.parse(JSON.stringify(lock)))).toEqual(lock);
  });

  it('rejects values that are not a record', () => {
    for (const value of [null, undefined, 0, 'lock', [], true]) {
      expect(parseFeatureLock(value)).toBeNull();
    }
  });

  it('rejects an unknown record version rather than guessing', async () => {
    const lock = await makeLock();
    expect(parseFeatureLock({ ...lock, version: 2 })).toBeNull();
    expect(parseFeatureLock({ ...lock, version: undefined })).toBeNull();
  });

  it('rejects a salt that is not 16 hex bytes', async () => {
    const lock = await makeLock();
    expect(parseFeatureLock({ ...lock, salt: '' })).toBeNull();
    expect(parseFeatureLock({ ...lock, salt: lock.salt.slice(0, 30) })).toBeNull();
    expect(parseFeatureLock({ ...lock, salt: 'z'.repeat(32) })).toBeNull();
    expect(parseFeatureLock({ ...lock, salt: 42 })).toBeNull();
  });

  it('rejects a digest that is not 32 hex bytes', async () => {
    const lock = await makeLock();
    expect(parseFeatureLock({ ...lock, hash: 'abc' })).toBeNull();
    expect(parseFeatureLock({ ...lock, hash: null })).toBeNull();
  });

  it('rejects a work factor that is not a sane integer', async () => {
    const lock = await makeLock();
    for (const iterations of [0, -1, 1.5, 1_000_001, '1000', NaN]) {
      expect(parseFeatureLock({ ...lock, iterations })).toBeNull();
    }
  });

  it('rejects a missing creation time', async () => {
    const lock = await makeLock();
    expect(parseFeatureLock({ ...lock, createdAt: 'yesterday' })).toBeNull();
  });

  it('rejects an unknown action instead of silently relaxing the lock', async () => {
    const lock = await makeLock(['copy-text']);
    // A newer build might add an action this one cannot enforce. Dropping it
    // would leave the reader able to do more than the lock says.
    expect(parseFeatureLock({ ...lock, disabled: ['copy-text', 'print-document'] })).toBeNull();
  });

  it('rejects a profile that is not an array of strings', async () => {
    const lock = await makeLock();
    expect(parseFeatureLock({ ...lock, disabled: 'copy-text' })).toBeNull();
    expect(parseFeatureLock({ ...lock, disabled: [1] })).toBeNull();
    expect(parseFeatureLock({ ...lock, disabled: undefined })).toBeNull();
  });

  it('canonicalises order and removes duplicates on the way in', async () => {
    const lock = await makeLock();
    const parsed = parseFeatureLock({ ...lock, disabled: ['browse-documents', 'edit-text', 'edit-text'] });
    expect(parsed?.disabled).toEqual(['edit-text', 'browse-documents']);
  });

  it('lower-cases hex so a hand-edited record still verifies', async () => {
    const lock = await makeLock();
    const parsed = parseFeatureLock({ ...lock, salt: lock.salt.toUpperCase(), hash: lock.hash.toUpperCase() });
    expect(parsed?.salt).toBe(lock.salt);
    expect(parsed?.hash).toBe(lock.hash);
  });
});

describe('loadFeatureLock / saveFeatureLock', () => {
  it('reads a missing key as unlocked', () => {
    expect(loadFeatureLock(key)).toEqual({ kind: 'unlocked' });
  });

  it('round-trips a saved lock', async () => {
    const lock = await makeLock(['copy-text']);
    expect(saveFeatureLock(key, lock)).toBe(true);
    expect(loadFeatureLock(key)).toEqual({ kind: 'locked', lock });
  });

  it('fails CLOSED when the stored bytes are not JSON', () => {
    store.set(key, '{not json');
    const state = loadFeatureLock(key);
    expect(state.kind).toBe('corrupt');
    // And every action is therefore refused — this is the whole point.
    for (const action of LOCK_ACTIONS) expect(isActionAllowed(state, action)).toBe(false);
  });

  it('fails CLOSED when the stored record has a valid-JSON but invalid shape', () => {
    store.set(key, JSON.stringify({ version: 1, salt: 'x', hash: 'y', iterations: 1, disabled: [] }));
    expect(loadFeatureLock(key).kind).toBe('corrupt');
  });

  it('fails CLOSED when an unknown action was written by something else', () => {
    store.set(key, JSON.stringify({
      version: 1,
      salt: 'a'.repeat(32),
      hash: 'b'.repeat(64),
      iterations: 1000,
      createdAt: 1,
      disabled: ['copy-text', 'record-audio'],
    }));
    expect(loadFeatureLock(key).kind).toBe('corrupt');
  });

  it('reports a refused write instead of pretending the lock exists', async () => {
    storageBroken = true;
    expect(saveFeatureLock(key, await makeLock())).toBe(false);
  });

  it('treats an unreadable store as unlocked, because no lock could be read or set', () => {
    // Documented exception in loadFeatureLock: we cannot distinguish "no
    // lock" from "a lock I may not see", and locking every document in that
    // state leaves no way to set or lift anything.
    storageBroken = true;
    expect(loadFeatureLock(key)).toEqual({ kind: 'unlocked' });
  });

  it('removes a lock', async () => {
    saveFeatureLock(key, await makeLock());
    expect(clearFeatureLock(key)).toBe(true);
    expect(loadFeatureLock(key)).toEqual({ kind: 'unlocked' });
  });

  it('leaves other documents’ locks alone when one is removed', async () => {
    const otherKey = featureLockKey({ ...file, name: 'paper three.pdf' });
    saveFeatureLock(key, await makeLock(['copy-text']));
    saveFeatureLock(otherKey, await makeLock(['export-audio']));
    clearFeatureLock(key);
    expect(loadFeatureLock(key).kind).toBe('unlocked');
    expect(loadFeatureLock(otherKey).kind).toBe('locked');
  });
});

describe('password hashing', () => {
  it('gives the same digest for the same password and salt', async () => {
    const salt = 'f'.repeat(32);
    const a = await hashFeatureLockPassword('correct horse', salt, 1_000);
    const b = await hashFeatureLockPassword('correct horse', salt, 1_000);
    expect(a).toBe(b);
  });

  it('gives a different digest for the same password and a different salt', async () => {
    const a = await hashFeatureLockPassword('correct horse', 'a'.repeat(32), 1_000);
    const b = await hashFeatureLockPassword('correct horse', 'b'.repeat(32), 1_000);
    expect(a).not.toBe(b);
  });

  it('gives a different digest for a different password and the same salt', async () => {
    const salt = 'a'.repeat(32);
    expect(await hashFeatureLockPassword('correct horse', salt, 1_000))
      .not.toBe(await hashFeatureLockPassword('correct horsf', salt, 1_000));
  });

  it('produces 32 hex-encoded bytes and never the password itself', async () => {
    const digest = await hashFeatureLockPassword('correct horse', 'a'.repeat(32), 1_000);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('correct');
  });

  it('uses a fresh salt per lock', async () => {
    const a = await makeLock(['copy-text']);
    const b = await makeLock(['copy-text']);
    expect(a.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('stores no plaintext password anywhere in the record', async () => {
    const lock = await makeLock();
    const serialised = JSON.stringify(lock);
    expect(serialised).not.toContain('open sesame');
    expect(Object.keys(lock).sort()).toEqual(
      ['createdAt', 'disabled', 'hash', 'iterations', 'salt', 'version'].sort(),
    );
  });

  it('refuses to create a lock with an empty password', async () => {
    await expect(createFeatureLock('', ['copy-text'], FAST)).rejects.toThrow('needs a password');
  });

  it('refuses to create a lock with an unknown action', async () => {
    await expect(createFeatureLock('pw', ['print-document' as LockAction], FAST)).rejects.toThrow('Unknown lock action');
  });

  it('keeps the work factor it was asked for', async () => {
    const lock = await makeLock();
    expect(lock.iterations).toBe(1_000);
    expect(lock.createdAt).toBe(1_700_000_000_000);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const lock = await makeLock();
    expect(await verifyFeatureLockPassword(lock, 'open sesame')).toBe(true);
    expect(await verifyFeatureLockPassword(lock, 'open sesamf')).toBe(false);
    expect(await verifyFeatureLockPassword(lock, '')).toBe(false);
  });

  it('rejects a password against a tampered digest', async () => {
    const lock = await makeLock();
    const tampered = { ...lock, hash: lock.hash.replace(/^./, c => (c === 'a' ? 'b' : 'a')) };
    expect(await verifyFeatureLockPassword(tampered, 'open sesame')).toBe(false);
  });

  it('rejects a password against a tampered salt', async () => {
    const lock = await makeLock();
    const tampered = { ...lock, salt: lock.salt.replace(/^./, c => (c === 'a' ? 'b' : 'a')) };
    expect(await verifyFeatureLockPassword(tampered, 'open sesame')).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('compares equal and unequal strings of the same length', () => {
    expect(constantTimeEqual('abcd', 'abcd')).toBe(true);
    expect(constantTimeEqual('abcd', 'abce')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });
});

describe('allow / deny decisions', () => {
  it('allows everything when unlocked', () => {
    for (const action of LOCK_ACTIONS) {
      expect(isActionAllowed({ kind: 'unlocked' }, action)).toBe(true);
    }
  });

  it('denies exactly the actions in the profile and nothing else', async () => {
    const lock = await makeLock(['copy-text', 'export-audio']);
    const state = { kind: 'locked', lock } as const;
    expect(isActionAllowed(state, 'copy-text')).toBe(false);
    expect(isActionAllowed(state, 'export-audio')).toBe(false);
    expect(isActionAllowed(state, 'edit-text')).toBe(true);
    expect(isActionAllowed(state, 'change-voice')).toBe(true);
    expect(isActionAllowed(state, 'browse-documents')).toBe(true);
  });

  it('denies every action when the record is corrupt', () => {
    const state = { kind: 'corrupt', reason: 'bad bytes' } as const;
    for (const action of LOCK_ACTIONS) {
      expect(isActionAllowed(state, action)).toBe(false);
    }
    expect(disabledActions(state)).toEqual([...LOCK_ACTIONS]);
  });

  it('lists the disabled actions in canonical order', async () => {
    const lock = await makeLock(['browse-documents', 'edit-text']);
    expect(disabledActions({ kind: 'locked', lock })).toEqual(['edit-text', 'browse-documents']);
    expect(disabledActions({ kind: 'unlocked' })).toEqual([]);
  });

  it('describes each state in words a reader can act on', async () => {
    expect(describeLock({ kind: 'unlocked' })).toContain('not locked');
    const lock = await makeLock(['copy-text', 'change-voice']);
    expect(describeLock({ kind: 'locked', lock }))
      .toContain('copy text out');
    expect(describeLock({ kind: 'locked', lock }))
      .toContain('change the reading voice');
    expect(describeLock({ kind: 'corrupt', reason: 'x' })).toContain('damaged');
  });

  it('explains a blocked action with its human label', () => {
    const message = blockedActionMessage({ kind: 'corrupt', reason: 'x' }, 'export-audio');
    expect(message).toContain(LOCK_ACTION_LABELS['export-audio'].toLowerCase());
    expect(message).toContain('damaged');
    const lockedMessage = blockedActionMessage(
      { kind: 'locked', lock: { version: 1, salt: '', hash: '', iterations: 1, createdAt: 0, disabled: ['copy-text'] } },
      'copy-text',
    );
    expect(lockedMessage).toContain('locked');
  });
});

describe('the open document’s lock slot', () => {
  it('starts unlocked', () => {
    expect(getActiveLockState()).toEqual({ kind: 'unlocked' });
    expect(activeLockBlocks('copy-text')).toBe(false);
    expect(activeLockMessage('copy-text')).toBeNull();
  });

  it('follows the state it is given', async () => {
    const lock = await makeLock(['copy-text']);
    setActiveLockState({ kind: 'locked', lock });
    expect(activeLockBlocks('copy-text')).toBe(true);
    expect(activeLockBlocks('export-audio')).toBe(false);
    expect(activeLockMessage('copy-text')).toContain('locked');
  });

  it('resets', async () => {
    setActiveLockState({ kind: 'locked', lock: await makeLock() });
    clearActiveLockState();
    expect(activeLockBlocks('browse-documents')).toBe(false);
  });
});
