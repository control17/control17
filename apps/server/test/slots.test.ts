import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role, Squadron } from '@control17/sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigNotFoundError,
  createSlotStore,
  defaultConfigPath,
  hashToken,
  loadSquadronConfigFromFile,
  SlotLoadError,
  TOKEN_HASH_PREFIX,
  writeSquadronConfig,
} from '../src/slots.js';

// ── helpers ──────────────────────────────────────────────────────────

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c17-slots-test-'));
  dirsToClean.push(dir);
  return dir;
}

function writeConfig(content: string, name = 'control17.json'): string {
  const dir = tmpDir();
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const SAMPLE_SQUADRON: Squadron = {
  name: 'alpha-squadron',
  mission: 'Ship the payment service.',
  brief: 'We own the full lifecycle.',
};

const SAMPLE_ROLES: Record<string, Role> = {
  operator: {
    description: 'Directs the squadron.',
    instructions: 'Lead.',
  },
  implementer: {
    description: 'Writes code.',
    instructions: 'Ship work.',
  },
};

// ── hashToken ────────────────────────────────────────────────────────

describe('hashToken', () => {
  it('returns a sha256-prefixed hex digest', () => {
    const h = hashToken('c17_secret_value');
    expect(h.startsWith(TOKEN_HASH_PREFIX)).toBe(true);
    expect(h.slice(TOKEN_HASH_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input', () => {
    expect(hashToken('same')).toBe(hashToken('same'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

// ── defaultConfigPath ───────────────────────────────────────────────

describe('defaultConfigPath', () => {
  it('honors C17_CONFIG_PATH when set', () => {
    expect(defaultConfigPath({ C17_CONFIG_PATH: '/custom/path.json' }, '/irrelevant')).toBe(
      '/custom/path.json',
    );
  });

  it('falls back to cwd/control17.json when no env is set', () => {
    expect(defaultConfigPath({}, '/home/op/project')).toBe('/home/op/project/control17.json');
  });

  it('ignores an empty C17_CONFIG_PATH', () => {
    expect(defaultConfigPath({ C17_CONFIG_PATH: '' }, '/cwd')).toBe('/cwd/control17.json');
  });
});

// ── createSlotStore ─────────────────────────────────────────────────

describe('createSlotStore', () => {
  it('builds a store from in-memory entries', () => {
    const store = createSlotStore([
      { callsign: 'ACTUAL', role: 'operator', token: 'op-token' },
      { callsign: 'ALPHA-1', role: 'implementer', token: 'impl-token' },
    ]);
    expect(store.size()).toBe(2);
    expect(store.callsigns().sort()).toEqual(['ACTUAL', 'ALPHA-1']);
    expect(store.resolve('op-token')).toEqual({
      callsign: 'ACTUAL',
      role: 'operator',
      authority: 'operator',
      totpSecret: null,
      totpLastCounter: 0,
    });
    expect(store.resolve('impl-token')).toEqual({
      callsign: 'ALPHA-1',
      role: 'implementer',
      authority: 'operator',
      totpSecret: null,
      totpLastCounter: 0,
    });
    expect(store.resolve('unknown')).toBeNull();
  });

  it('rejects empty entry lists', () => {
    expect(() => createSlotStore([])).toThrow(SlotLoadError);
  });

  it('rejects duplicate callsigns', () => {
    expect(() =>
      createSlotStore([
        { callsign: 'ACTUAL', role: 'operator', token: 'a-secret' },
        { callsign: 'ACTUAL', role: 'implementer', token: 'b-secret' },
      ]),
    ).toThrow(/duplicate callsign 'ACTUAL'/);
  });

  it('rejects duplicate tokens', () => {
    expect(() =>
      createSlotStore([
        { callsign: 'ACTUAL', role: 'operator', token: 'shared-secret' },
        { callsign: 'BOB', role: 'operator', token: 'shared-secret' },
      ]),
    ).toThrow(/duplicate token/);
  });
});

// ── loadSquadronConfigFromFile ──────────────────────────────────────────

describe('loadSquadronConfigFromFile', () => {
  it('loads a well-formed hashed config without rewriting the file', () => {
    const aliceHash = hashToken('c17_op_secret');
    const implHash = hashToken('c17_impl_secret');
    const original = JSON.stringify(
      {
        squadron: SAMPLE_SQUADRON,
        roles: SAMPLE_ROLES,
        slots: [
          { callsign: 'ACTUAL', role: 'operator', authority: 'commander', tokenHash: aliceHash },
          { callsign: 'ALPHA-1', role: 'implementer', tokenHash: implHash },
        ],
      },
      null,
      2,
    );
    const path = writeConfig(original);
    const config = loadSquadronConfigFromFile(path);
    expect(config.store.size()).toBe(2);
    expect(config.store.resolve('c17_op_secret')?.callsign).toBe('ACTUAL');
    expect(config.store.resolve('c17_impl_secret')?.role).toBe('implementer');
    expect(config.migrated).toBe(0);
    expect(config.squadron).toEqual(SAMPLE_SQUADRON);
    expect(config.roles.operator?.description).toContain('squadron');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('auto-migrates plaintext tokens to hashes and rewrites the file', () => {
    const path = writeConfig(
      JSON.stringify({
        squadron: SAMPLE_SQUADRON,
        roles: SAMPLE_ROLES,
        slots: [
          { callsign: 'ACTUAL', role: 'operator', authority: 'commander', token: 'c17_op_secret' },
          { callsign: 'ALPHA-1', role: 'implementer', token: 'c17_impl_secret' },
        ],
      }),
    );
    const config = loadSquadronConfigFromFile(path);
    expect(config.store.resolve('c17_op_secret')?.callsign).toBe('ACTUAL');
    expect(config.migrated).toBe(2);

    const rewritten = JSON.parse(readFileSync(path, 'utf8')) as {
      slots: Array<{ callsign: string; role: string; tokenHash?: string; token?: string }>;
    };
    expect(rewritten.slots).toHaveLength(2);
    for (const slot of rewritten.slots) {
      expect(slot.token).toBeUndefined();
      expect(slot.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    // Re-loading the rewritten file must still resolve the original plaintext.
    const reload = loadSquadronConfigFromFile(path);
    expect(reload.migrated).toBe(0);
    expect(reload.store.resolve('c17_op_secret')?.callsign).toBe('ACTUAL');
  });

  it('throws ConfigNotFoundError when the file is missing', () => {
    const path = join(tmpDir(), 'does-not-exist.json');
    expect(() => loadSquadronConfigFromFile(path)).toThrow(ConfigNotFoundError);
    try {
      loadSquadronConfigFromFile(path);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigNotFoundError);
      expect((err as ConfigNotFoundError).path).toBe(path);
    }
  });

  it('rejects the legacy `tokens` schema with a helpful message', () => {
    const path = writeConfig(
      JSON.stringify({
        tokens: [{ name: 'alice', kind: 'human', token: 'c17_legacy' }],
      }),
    );
    expect(() => loadSquadronConfigFromFile(path)).toThrow(/legacy `tokens` schema/);
  });

  it('rejects malformed JSON', () => {
    const path = writeConfig('{not valid json');
    expect(() => loadSquadronConfigFromFile(path)).toThrow(/not valid JSON/);
  });

  it('rejects empty slots lists', () => {
    const path = writeConfig(
      JSON.stringify({ squadron: SAMPLE_SQUADRON, roles: SAMPLE_ROLES, slots: [] }),
    );
    expect(() => loadSquadronConfigFromFile(path)).toThrow(/at least one entry/);
  });

  it('rejects slots referencing an unknown role', () => {
    const path = writeConfig(
      JSON.stringify({
        squadron: SAMPLE_SQUADRON,
        roles: SAMPLE_ROLES,
        slots: [{ callsign: 'GHOST', role: 'phantom', token: 'c17_ghost_secret' }],
      }),
    );
    expect(() => loadSquadronConfigFromFile(path)).toThrow(/unknown role 'phantom'/);
  });

  it('rejects callsigns with invalid characters', () => {
    const path = writeConfig(
      JSON.stringify({
        squadron: SAMPLE_SQUADRON,
        roles: SAMPLE_ROLES,
        slots: [{ callsign: 'has spaces', role: 'operator', token: 'c17_bad_secret' }],
      }),
    );
    expect(() => loadSquadronConfigFromFile(path)).toThrow();
  });

  it('rejects a slot with neither token nor tokenHash', () => {
    const path = writeConfig(
      JSON.stringify({
        squadron: SAMPLE_SQUADRON,
        roles: SAMPLE_ROLES,
        slots: [{ callsign: 'ACTUAL', role: 'operator' }],
      }),
    );
    expect(() => loadSquadronConfigFromFile(path)).toThrow();
  });

  it('rejects a slot with both token and tokenHash', () => {
    const path = writeConfig(
      JSON.stringify({
        squadron: SAMPLE_SQUADRON,
        roles: SAMPLE_ROLES,
        slots: [
          {
            callsign: 'ACTUAL',
            role: 'operator',
            token: 'c17_plain_secret',
            tokenHash: hashToken('c17_plain_secret'),
          },
        ],
      }),
    );
    expect(() => loadSquadronConfigFromFile(path)).toThrow();
  });
});

// ── writeSquadronConfig ─────────────────────────────────────────────────

describe('writeSquadronConfig', () => {
  it('writes a config that loads cleanly and resolves the original plaintext', () => {
    const path = join(tmpDir(), 'control17.json');
    writeSquadronConfig(path, SAMPLE_SQUADRON, SAMPLE_ROLES, [
      { callsign: 'ACTUAL', role: 'operator', authority: 'commander', token: 'c17_plain_op' },
      { callsign: 'ALPHA-1', role: 'implementer', token: 'c17_plain_impl' },
    ]);

    const body = JSON.parse(readFileSync(path, 'utf8')) as {
      squadron: Squadron;
      roles: Record<string, Role>;
      slots: Array<{ token?: string; tokenHash?: string }>;
    };
    expect(body.squadron).toEqual(SAMPLE_SQUADRON);
    expect(body.roles.operator?.description).toContain('squadron');
    for (const slot of body.slots) {
      expect(slot.token).toBeUndefined();
      expect(slot.tokenHash).toMatch(/^sha256:/);
    }

    const config = loadSquadronConfigFromFile(path);
    expect(config.migrated).toBe(0);
    expect(config.store.resolve('c17_plain_op')?.callsign).toBe('ACTUAL');
    expect(config.store.resolve('c17_plain_impl')?.role).toBe('implementer');
  });
});
