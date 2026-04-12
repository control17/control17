import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigNotFoundError,
  createPrincipalStore,
  defaultConfigPath,
  hashToken,
  loadPrincipalsFromFile,
  loadPrincipalsFromFileVerbose,
  PrincipalLoadError,
  TOKEN_HASH_PREFIX,
  writeHashedConfig,
} from '../src/principals.js';

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

describe('createPrincipalStore', () => {
  it('builds a store from in-memory entries', () => {
    const store = createPrincipalStore([
      { name: 'alice', kind: 'human', token: 'alice-token' },
      { name: 'bot', kind: 'agent', token: 'bot-token' },
    ]);
    expect(store.size()).toBe(2);
    expect(store.names().sort()).toEqual(['alice', 'bot']);
    expect(store.resolve('alice-token')).toEqual({ name: 'alice', kind: 'human' });
    expect(store.resolve('bot-token')).toEqual({ name: 'bot', kind: 'agent' });
    expect(store.resolve('unknown')).toBeNull();
  });

  it('rejects empty entry lists', () => {
    expect(() => createPrincipalStore([])).toThrow(PrincipalLoadError);
  });

  it('rejects duplicate names', () => {
    expect(() =>
      createPrincipalStore([
        { name: 'alice', kind: 'human', token: 'a-secret' },
        { name: 'alice', kind: 'agent', token: 'b-secret' },
      ]),
    ).toThrow(/duplicate principal name 'alice'/);
  });

  it('rejects duplicate tokens even across different names', () => {
    expect(() =>
      createPrincipalStore([
        { name: 'alice', kind: 'human', token: 'shared-secret' },
        { name: 'bob', kind: 'human', token: 'shared-secret' },
      ]),
    ).toThrow(/duplicate token/);
  });
});

describe('loadPrincipalsFromFile', () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeConfig(content: string, name = 'server.json'): string {
    const dir = mkdtempSync(join(tmpdir(), 'c17-principals-test-'));
    dirsToClean.push(dir);
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it('loads a well-formed hashed config without rewriting the file', () => {
    const aliceHash = hashToken('c17_alice_secret');
    const botHash = hashToken('c17_bot_secret');
    const originalJson = JSON.stringify(
      {
        tokens: [
          { name: 'alice', kind: 'human', tokenHash: aliceHash },
          { name: 'bot', kind: 'agent', tokenHash: botHash },
        ],
      },
      null,
      2,
    );
    const path = writeConfig(originalJson);

    const { store, migrated } = loadPrincipalsFromFileVerbose(path);
    expect(store.size()).toBe(2);
    expect(store.resolve('c17_alice_secret')?.name).toBe('alice');
    expect(store.resolve('c17_bot_secret')?.kind).toBe('agent');
    expect(migrated).toBe(0);
    // File untouched.
    expect(readFileSync(path, 'utf8')).toBe(originalJson);
  });

  it('auto-migrates plaintext tokens to hashes and rewrites the file', () => {
    const path = writeConfig(
      JSON.stringify({
        _comment: 'my custom comment',
        tokens: [
          { name: 'alice', kind: 'human', token: 'c17_alice_secret' },
          { name: 'bot', kind: 'agent', token: 'c17_bot_secret' },
        ],
      }),
    );

    const { store, migrated } = loadPrincipalsFromFileVerbose(path);
    expect(store.resolve('c17_alice_secret')?.name).toBe('alice');
    expect(migrated).toBe(2);

    const rewritten = JSON.parse(readFileSync(path, 'utf8')) as {
      _comment: string;
      tokens: Array<{ name: string; kind: string; tokenHash?: string; token?: string }>;
    };
    expect(rewritten._comment).toBe('my custom comment');
    expect(rewritten.tokens).toHaveLength(2);
    for (const entry of rewritten.tokens) {
      expect(entry.token).toBeUndefined();
      expect(entry.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    // Re-loading the rewritten file must still resolve the original plaintext.
    const reload = loadPrincipalsFromFileVerbose(path);
    expect(reload.migrated).toBe(0);
    expect(reload.store.resolve('c17_alice_secret')?.name).toBe('alice');
  });

  it('throws ConfigNotFoundError when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c17-principals-test-'));
    dirsToClean.push(dir);
    const path = join(dir, 'does-not-exist.json');
    expect(() => loadPrincipalsFromFile(path)).toThrow(ConfigNotFoundError);
    try {
      loadPrincipalsFromFile(path);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigNotFoundError);
      expect((err as ConfigNotFoundError).path).toBe(path);
    }
  });

  it('rejects malformed JSON', () => {
    const path = writeConfig('{not valid json');
    expect(() => loadPrincipalsFromFile(path)).toThrow(/not valid JSON/);
  });

  it('rejects empty token lists', () => {
    const path = writeConfig(JSON.stringify({ tokens: [] }));
    expect(() => loadPrincipalsFromFile(path)).toThrow(/at least one entry/);
  });

  it('accepts any freeform kind string', () => {
    const path = writeConfig(
      JSON.stringify({
        tokens: [{ name: 'alice', kind: 'custom-role', token: 'c17_alice_secret' }],
      }),
    );
    const store = loadPrincipalsFromFile(path);
    expect(store.resolve('c17_alice_secret')?.kind).toBe('custom-role');
  });

  it('rejects empty kind', () => {
    const path = writeConfig(
      JSON.stringify({
        tokens: [{ name: 'alice', kind: '', token: 'c17_alice_secret' }],
      }),
    );
    expect(() => loadPrincipalsFromFile(path)).toThrow();
  });

  it('rejects names with invalid characters', () => {
    const path = writeConfig(
      JSON.stringify({
        tokens: [{ name: 'has spaces', kind: 'human', token: 'c17_secret_value' }],
      }),
    );
    expect(() => loadPrincipalsFromFile(path)).toThrow();
  });

  it('rejects an entry with neither token nor tokenHash', () => {
    const path = writeConfig(
      JSON.stringify({
        tokens: [{ name: 'alice', kind: 'human' }],
      }),
    );
    expect(() => loadPrincipalsFromFile(path)).toThrow();
  });

  it('rejects an entry with both token and tokenHash', () => {
    const path = writeConfig(
      JSON.stringify({
        tokens: [
          {
            name: 'alice',
            kind: 'human',
            token: 'c17_plain_secret',
            tokenHash: hashToken('c17_plain_secret'),
          },
        ],
      }),
    );
    expect(() => loadPrincipalsFromFile(path)).toThrow();
  });
});

describe('writeHashedConfig', () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a config that loads cleanly and resolves the original plaintext', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c17-principals-test-'));
    dirsToClean.push(dir);
    const path = join(dir, 'control17.json');

    writeHashedConfig(path, [
      { name: 'alice', kind: 'human', token: 'c17_plain_alice' },
      { name: 'bot', kind: 'agent', token: 'c17_plain_bot' },
    ]);

    const body = JSON.parse(readFileSync(path, 'utf8')) as {
      tokens: Array<{ token?: string; tokenHash?: string }>;
    };
    for (const entry of body.tokens) {
      expect(entry.token).toBeUndefined();
      expect(entry.tokenHash).toMatch(/^sha256:/);
    }

    const { store, migrated } = loadPrincipalsFromFileVerbose(path);
    expect(migrated).toBe(0);
    expect(store.resolve('c17_plain_alice')?.name).toBe('alice');
    expect(store.resolve('c17_plain_bot')?.kind).toBe('agent');
  });
});
