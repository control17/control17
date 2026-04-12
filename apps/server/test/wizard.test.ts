import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPrincipalsFromFile, PrincipalLoadError } from '../src/principals.js';
import { runFirstRunWizard, type WizardIO } from '../src/wizard.js';

interface MockIO extends WizardIO {
  output: string[];
  remaining(): number;
}

function mockIO(scripted: string[], isInteractive = true): MockIO {
  const queue = scripted.slice();
  const output: string[] = [];
  return {
    output,
    isInteractive,
    prompt: async (question) => {
      output.push(`? ${question}`);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`mock IO exhausted (prompt: ${question})`);
      }
      return next;
    },
    println: (line) => {
      output.push(line);
    },
    redactLines: () => {},
    remaining: () => queue.length,
  };
}

describe('runFirstRunWizard', () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpConfigPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'c17-wizard-test-'));
    dirsToClean.push(dir);
    return join(dir, 'control17.json');
  }

  it('creates a single identity, writes the file, and returns a working store', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      '', // name: accept default 'alice'
      '', // kind: accept default human
      '', // press enter after banner
      'n', // add another? no
    ]);

    const store = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `c17_test_token_${++tokenCounter}`,
    });

    expect(store.size()).toBe(1);
    expect(store.resolve('c17_test_token_1')?.name).toBe('operator');

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      tokens: Array<{ name: string; kind: string; tokenHash: string }>;
    };
    expect(onDisk.tokens).toHaveLength(1);
    expect(onDisk.tokens[0]?.name).toBe('operator');
    expect(onDisk.tokens[0]?.kind).toBe('operator');
    expect(onDisk.tokens[0]?.tokenHash).toMatch(/^sha256:/);

    // File can be re-loaded round-trip.
    const reloaded = loadPrincipalsFromFile(configPath);
    expect(reloaded.resolve('c17_test_token_1')?.name).toBe('operator');
  });

  it('collects multiple identities when the operator says yes', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'alice', // name 1
      'operator', // kind 1
      '', // press enter
      'y', // more?
      'build-bot', // name 2
      'agent', // kind 2
      '', // press enter
      'no', // more?
    ]);

    const store = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `c17_test_token_${++tokenCounter}`,
    });

    expect(store.size()).toBe(2);
    expect(store.resolve('c17_test_token_1')?.name).toBe('alice');
    expect(store.resolve('c17_test_token_2')?.name).toBe('build-bot');
    expect(store.resolve('c17_test_token_2')?.kind).toBe('agent');
  });

  it('re-prompts on invalid name and accepts freeform kind', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([
      'has spaces', // invalid name
      'also invalid!', // still invalid
      'valid-name', // accepted
      'custom-role', // freeform kind — accepted
      '', // press enter
      'n', // no more
    ]);

    const store = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => 'c17_mocked_token',
    });

    expect(store.size()).toBe(1);
    expect(store.resolve('c17_mocked_token')?.name).toBe('valid-name');
    expect(store.resolve('c17_mocked_token')?.kind).toBe('custom-role');
    expect(io.output.some((l) => l.includes('alphanumeric'))).toBe(true);
  });

  it('rejects a duplicate name within the same session', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'alice', // name 1
      'human',
      '',
      'y', // add another
      'alice', // duplicate, re-prompted
      'bob', // accepted
      'human',
      '',
      'n',
    ]);
    const store = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `c17_t_${++tokenCounter}`,
    });
    expect(store.names().sort()).toEqual(['alice', 'bob']);
    expect(io.output.some((l) => l.includes("'alice' already added"))).toBe(true);
  });

  it('throws PrincipalLoadError when the IO is not interactive', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([], false);
    await expect(runFirstRunWizard({ configPath, io, tokenFactory: () => 'tok' })).rejects.toThrow(
      PrincipalLoadError,
    );
  });
});
