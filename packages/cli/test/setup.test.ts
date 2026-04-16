/**
 * Tests for `c17 setup`.
 *
 * Most of the wizard path is already covered by the server's wizard
 * tests — here we focus on the CLI wrapper:
 *   - correct UsageError on non-TTY stdin
 *   - refusing to overwrite an existing config with a readable summary
 *   - invalid existing config reports as a UsageError (not a raw stack)
 *   - ConfigNotFoundError is the happy path (drops into the wizard)
 *
 * We invoke `runSetupCommand` directly rather than spawning the CLI
 * binary — same pattern as `push`/`roster` tests.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSetupCommand, UsageError } from '../src/commands/setup.js';

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c17-setup-test-'));
  dirsToClean.push(dir);
  return join(dir, 'control17.json');
}

const VALID_CONFIG_JSON = JSON.stringify({
  squadron: {
    name: 'alpha-squadron',
    mission: 'ship the payment service',
    brief: '',
  },
  roles: {
    operator: { description: '', instructions: '' },
    implementer: { description: '', instructions: '' },
  },
  slots: [
    {
      callsign: 'ACTUAL',
      role: 'operator',
      authority: 'commander',
      tokenHash: `sha256:${'a'.repeat(64)}`,
    },
    { callsign: 'ALPHA-1', role: 'implementer', tokenHash: `sha256:${'b'.repeat(64)}` },
  ],
});

describe('runSetupCommand', () => {
  it('refuses to overwrite an existing config and reports the current squadron/slots', async () => {
    const configPath = tmpPath();
    writeFileSync(configPath, VALID_CONFIG_JSON);

    const output: string[] = [];
    await expect(runSetupCommand({ configPath }, (line) => output.push(line))).rejects.toThrow(
      UsageError,
    );
    try {
      await runSetupCommand({ configPath }, (line) => output.push(line));
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('alpha-squadron');
      expect(message).toContain('ACTUAL');
      expect(message).toContain('ALPHA-1');
      expect(message).toContain(`rm ${configPath}`);
    }
  });

  it('reports an invalid existing config as a UsageError', async () => {
    const configPath = tmpPath();
    writeFileSync(configPath, '{ "bogus": true }');

    await expect(runSetupCommand({ configPath }, () => {})).rejects.toThrow(UsageError);
  });

  it('throws a friendly UsageError when stdin is not a TTY', async () => {
    // In the vitest runner stdin is typically not a TTY, so this
    // exercises the real code path. The config path doesn't exist,
    // so we get past the "already exists" check and fall into the
    // wizard, which immediately bails because `createTtyWizardIO()`
    // reports isInteractive: false.
    const configPath = tmpPath();
    await expect(runSetupCommand({ configPath }, () => {})).rejects.toThrow(/not a TTY/);
  });
});
