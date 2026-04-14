import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeamConfigFromFile, SlotLoadError } from '../src/slots.js';
import { currentCode } from '../src/totp.js';
import {
  DEFAULT_ROLES,
  type RunWizardOptions,
  runFirstRunWizard,
  type WizardIO,
} from '../src/wizard.js';

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

  it('creates a team with a single slot using defaults', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      // team name (default squadron)
      '',
      // mission (required)
      'Ship the payment service',
      // brief (empty)
      '',
      // slot 1: callsign (default ACTUAL)
      '',
      // slot 1: role (default operator)
      '',
      // press enter after banner
      '',
      // enable web UI login? (skip for this test)
      'n',
      // add another slot? no
      'n',
    ]);

    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `c17_test_token_${++tokenCounter}`,
      qrRenderer: () => '',
    });

    expect(config.store.size()).toBe(1);
    expect(config.store.resolve('c17_test_token_1')?.callsign).toBe('ACTUAL');
    expect(config.store.resolve('c17_test_token_1')?.role).toBe('operator');
    expect(config.team.name).toBe('squadron');
    expect(config.team.mission).toBe('Ship the payment service');
    expect(config.team.brief).toBe('');

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      team: { name: string; mission: string; brief: string };
      roles: Record<string, { editor?: boolean }>;
      slots: Array<{ callsign: string; role: string; tokenHash: string }>;
    };
    expect(onDisk.team.name).toBe('squadron');
    expect(onDisk.team.mission).toBe('Ship the payment service');
    expect(onDisk.slots).toHaveLength(1);
    expect(onDisk.slots[0]?.callsign).toBe('ACTUAL');
    expect(onDisk.slots[0]?.role).toBe('operator');
    expect(onDisk.slots[0]?.tokenHash).toMatch(/^sha256:/);

    // All 4 default roles ship with every generated config.
    expect(Object.keys(onDisk.roles).sort()).toEqual([
      'implementer',
      'operator',
      'reviewer',
      'watcher',
    ]);
    expect(onDisk.roles.operator?.editor).toBe(true);
    expect(onDisk.roles.implementer?.editor).toBeUndefined();

    // File can be re-loaded round-trip.
    const reloaded = loadTeamConfigFromFile(configPath);
    expect(reloaded.store.resolve('c17_test_token_1')?.callsign).toBe('ACTUAL');
  });

  it('collects multiple slots when the operator says yes', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'alpha-squadron',
      'ship the payment service',
      'we own the full lifecycle',
      // slot 1 (operator — TOTP prompt fires, we skip)
      'ACTUAL',
      'operator',
      '',
      'n',
      'y',
      // slot 2 (implementer — no TOTP prompt)
      'ALPHA-1',
      'implementer',
      '',
      'no',
    ]);

    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `c17_test_token_${++tokenCounter}`,
      qrRenderer: () => '',
    });

    expect(config.store.size()).toBe(2);
    expect(config.store.resolve('c17_test_token_1')?.callsign).toBe('ACTUAL');
    expect(config.store.resolve('c17_test_token_2')?.callsign).toBe('ALPHA-1');
    expect(config.store.resolve('c17_test_token_2')?.role).toBe('implementer');
    expect(config.team.name).toBe('alpha-squadron');
    expect(config.team.brief).toBe('we own the full lifecycle');
  });

  it('re-prompts on invalid callsign and accepts custom roles with a note', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([
      'squadron',
      'hold the line',
      '',
      // invalid callsigns, then a valid one
      'has spaces',
      'also invalid!',
      'valid-callsign',
      // custom role — accepted with note, auto-added to config
      'custom-role',
      '',
      'n',
    ]);

    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => 'c17_mocked_token',
    });

    expect(config.store.size()).toBe(1);
    expect(config.store.resolve('c17_mocked_token')?.callsign).toBe('valid-callsign');
    expect(config.store.resolve('c17_mocked_token')?.role).toBe('custom-role');
    expect(config.roles['custom-role']).toBeDefined();
    expect(io.output.some((l) => l.includes('alphanumeric'))).toBe(true);
    expect(io.output.some((l) => l.includes('custom role'))).toBe(true);

    // Generated config must be loadable — custom role was auto-injected.
    const reloaded = loadTeamConfigFromFile(configPath);
    expect(reloaded.store.resolve('c17_mocked_token')?.role).toBe('custom-role');
    expect(reloaded.roles['custom-role']).toBeDefined();
  });

  it('rejects role keys with invalid characters', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([
      'squadron',
      'mission',
      '',
      'ACTUAL',
      // invalid role key (contains space), then valid
      'bad role',
      'operator',
      '',
      // skip web UI login
      'n',
      // add another slot? no
      'n',
    ]);
    await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => 'c17_token',
      qrRenderer: () => '',
    });
    expect(io.output.some((l) => l.includes('role must be alphanumeric'))).toBe(true);
  });

  it('rejects duplicate callsigns within the same session', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'squadron',
      'hold the line',
      '',
      'ACTUAL',
      'operator',
      '',
      // skip web UI login for operator
      'n',
      'y',
      // duplicate → re-prompted, then accepted
      'ACTUAL',
      'ALPHA-1',
      'implementer',
      '',
      'n',
    ]);
    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `c17_t_${++tokenCounter}`,
      qrRenderer: () => '',
    });
    expect(config.store.callsigns().sort()).toEqual(['ACTUAL', 'ALPHA-1']);
    expect(io.output.some((l) => l.includes("'ACTUAL' already added"))).toBe(true);
  });

  it('throws SlotLoadError when the IO is not interactive', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([], false);
    await expect(runFirstRunWizard({ configPath, io, tokenFactory: () => 'tok' })).rejects.toThrow(
      SlotLoadError,
    );
  });

  it('ships all 4 default roles (operator, implementer, reviewer, watcher)', () => {
    expect(Object.keys(DEFAULT_ROLES).sort()).toEqual([
      'implementer',
      'operator',
      'reviewer',
      'watcher',
    ]);
    expect(DEFAULT_ROLES.operator?.editor).toBe(true);
    expect(DEFAULT_ROLES.implementer?.editor).toBeUndefined();
  });

  // ── TOTP enrollment ────────────────────────────────────────────────

  describe('TOTP enrollment', () => {
    const FIXED_SECRET = 'JBSWY3DPEHPK3PXP';
    const FIXED_NOW = 1_700_000_000_000;

    function enrollmentOptions(io: WizardIO, configPath: string): RunWizardOptions {
      return {
        configPath,
        io,
        tokenFactory: () => 'c17_test_token',
        totpSecretFactory: () => FIXED_SECRET,
        now: () => FIXED_NOW,
        qrRenderer: () => '[qr-code]',
      };
    }

    it('enrolls an operator slot with a valid code and persists the secret', async () => {
      const configPath = tmpConfigPath();
      const code = currentCode(FIXED_SECRET, FIXED_NOW);
      const io = mockIO([
        '',
        'mission',
        '',
        'ACTUAL',
        'operator',
        '',
        // enable web UI login? default Y
        'y',
        // enter the 6-digit code
        code,
        // add another slot? no
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('c17_test_token')?.totpSecret).toBe(FIXED_SECRET);

      // Persisted on disk so the next boot reuses it.
      const reloaded = loadTeamConfigFromFile(configPath);
      expect(reloaded.store.resolve('c17_test_token')?.totpSecret).toBe(FIXED_SECRET);
      expect(io.output.some((l) => l.includes('enrollment confirmed for ACTUAL'))).toBe(true);
    });

    it('re-prompts on an incorrect code and accepts the retry', async () => {
      const configPath = tmpConfigPath();
      const code = currentCode(FIXED_SECRET, FIXED_NOW);
      const io = mockIO([
        '',
        'mission',
        '',
        'ACTUAL',
        'operator',
        '',
        // enable web UI login? yes
        'y',
        // first attempt: wrong
        '000000',
        // second attempt: correct
        code,
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('c17_test_token')?.totpSecret).toBe(FIXED_SECRET);
      expect(io.output.some((l) => l.includes('that code is incorrect'))).toBe(true);
    });

    it('skips enrollment when the user answers n at the prompt', async () => {
      const configPath = tmpConfigPath();
      const io = mockIO([
        '',
        'mission',
        '',
        'ACTUAL',
        'operator',
        '',
        // enable web UI login? no
        'n',
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      // Secret should not be set — the slot is machine-only until c17 enroll.
      expect(config.store.resolve('c17_test_token')?.totpSecret).toBeFalsy();
      expect(io.output.some((l) => l.includes('c17 enroll --slot ACTUAL'))).toBe(true);
    });

    it('bails after too many bad codes without persisting a secret', async () => {
      const configPath = tmpConfigPath();
      const io = mockIO([
        '',
        'mission',
        '',
        'ACTUAL',
        'operator',
        '',
        'y',
        // 3 bad attempts — exceeds TOTP_MAX_CONFIRM_ATTEMPTS
        '000000',
        '111111',
        '222222',
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('c17_test_token')?.totpSecret).toBeFalsy();
      expect(io.output.some((l) => l.includes('too many bad attempts'))).toBe(true);
    });

    it('does NOT prompt TOTP for non-editor role slots', async () => {
      const configPath = tmpConfigPath();
      const io = mockIO([
        '',
        'mission',
        '',
        // implementer is non-editor — TOTP prompt should not fire
        'ALPHA-1',
        'implementer',
        '',
        // add another slot? no
        'n',
      ]);
      await runFirstRunWizard(enrollmentOptions(io, configPath));
      // If the TOTP prompt had fired, the queue would exhaust and we'd
      // throw. Passing through means the prompt was correctly skipped.
      expect(io.output.every((l) => !l.includes('enable web UI login'))).toBe(true);
    });
  });
});
