/**
 * Tests for `c17 enroll`.
 *
 * Like the setup tests, we drive `runEnrollCommand` directly with a
 * tmp config and collect stdout. The interactive TOTP verify loop
 * isn't exercised here — that's covered by the wizard's own test
 * suite (`apps/server/test/wizard.test.ts`) which shares the same
 * `verifyCode` + `enrollSlotTotp` primitives. Here we focus on the
 * CLI wrapper's error paths and dispatch:
 *
 *   - missing --slot argument
 *   - no config file at the resolved path
 *   - config exists but doesn't contain the named slot
 *   - invalid / corrupt existing config
 *   - non-TTY stdin (the interactive flow needs a real terminal)
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEnrollCommand, UsageError } from '../src/commands/enroll.js';

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c17-enroll-test-'));
  dirsToClean.push(dir);
  return join(dir, 'control17.json');
}

const VALID_CONFIG_JSON = JSON.stringify({
  squadron: {
    name: 'alpha-squadron',
    mission: 'ship',
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

describe('runEnrollCommand', () => {
  it('errors when --slot is missing', async () => {
    await expect(runEnrollCommand({}, () => {})).rejects.toThrow(UsageError);
    try {
      await runEnrollCommand({}, () => {});
    } catch (err) {
      expect((err as Error).message).toContain('--slot');
    }
  });

  it('errors when the config file does not exist', async () => {
    const configPath = tmpPath();
    // Don't write the file — tmpPath only mkdtemps the dir.
    await expect(runEnrollCommand({ slot: 'ACTUAL', configPath }, () => {})).rejects.toThrow(
      UsageError,
    );
    try {
      await runEnrollCommand({ slot: 'ACTUAL', configPath }, () => {});
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('no config file');
      expect(msg).toContain('pnpm wizard');
    }
  });

  it('errors with the list of known callsigns when the slot is unknown', async () => {
    const configPath = tmpPath();
    writeFileSync(configPath, VALID_CONFIG_JSON);
    try {
      await runEnrollCommand({ slot: 'ghost', configPath }, () => {});
      throw new Error('expected UsageError');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const msg = (err as Error).message;
      expect(msg).toContain("'ghost'");
      expect(msg).toContain('ACTUAL');
      expect(msg).toContain('ALPHA-1');
    }
  });

  it('errors when the existing config is invalid', async () => {
    const configPath = tmpPath();
    writeFileSync(configPath, '{ "nope": true }');
    await expect(runEnrollCommand({ slot: 'ACTUAL', configPath }, () => {})).rejects.toThrow(
      UsageError,
    );
  });

  it('bails with a friendly UsageError when stdin is not a TTY', async () => {
    // Vitest typically runs with stdin detached, so the non-TTY path
    // is the default here. This confirms enroll reaches the interactive
    // phase cleanly (past slot lookup, past the "already enrolled"
    // warning) before tripping the TTY guard.
    const configPath = tmpPath();
    writeFileSync(configPath, VALID_CONFIG_JSON);
    const output: string[] = [];
    await expect(
      runEnrollCommand({ slot: 'ACTUAL', configPath }, (line) => output.push(line)),
    ).rejects.toThrow(/not a TTY/);
  });
});
