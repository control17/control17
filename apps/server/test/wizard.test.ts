import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSquadronConfigFromFile, SlotLoadError } from '../src/slots.js';
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

  it('creates a squadron with a single commander slot using defaults', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      // squadron name (default my-team)
      '',
      // mission (required)
      'Ship the payment service',
      // brief (empty)
      '',
      // slot 1: callsign (default operator-1)
      '',
      // slot 1: role (default operator)
      '',
      // slot 1: authority (default commander)
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
    const actual = config.store.resolve('c17_test_token_1');
    expect(actual?.callsign).toBe('operator-1');
    expect(actual?.role).toBe('operator');
    expect(actual?.authority).toBe('commander');
    expect(config.squadron.name).toBe('my-team');
    expect(config.squadron.mission).toBe('Ship the payment service');
    expect(config.squadron.brief).toBe('');

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      squadron: { name: string; mission: string; brief: string };
      roles: Record<string, { description?: string; instructions?: string }>;
      slots: Array<{ callsign: string; role: string; authority?: string; tokenHash: string }>;
    };
    expect(onDisk.squadron.name).toBe('my-team');
    expect(onDisk.squadron.mission).toBe('Ship the payment service');
    expect(onDisk.slots).toHaveLength(1);
    expect(onDisk.slots[0]?.callsign).toBe('operator-1');
    expect(onDisk.slots[0]?.role).toBe('operator');
    expect(onDisk.slots[0]?.authority).toBe('commander');
    expect(onDisk.slots[0]?.tokenHash).toMatch(/^sha256:/);

    // All 4 default roles ship with every generated config.
    expect(Object.keys(onDisk.roles).sort()).toEqual([
      'implementer',
      'operator',
      'reviewer',
      'watcher',
    ]);

    // File can be re-loaded round-trip.
    const reloaded = loadSquadronConfigFromFile(configPath);
    const reloadedSlot = reloaded.store.resolve('c17_test_token_1');
    expect(reloadedSlot?.callsign).toBe('operator-1');
    expect(reloadedSlot?.authority).toBe('commander');
  });

  it('collects multiple slots with mixed authority tiers', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'alpha-squadron',
      'ship the payment service',
      'we own the full lifecycle',
      // slot 1 — commander (TOTP prompt fires, skip)
      'ACTUAL',
      'operator',
      '', // default commander
      '',
      'n',
      'y',
      // slot 2 — operator (no TOTP prompt)
      'ALPHA-1',
      'implementer',
      '', // default operator
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
    expect(config.store.resolve('c17_test_token_1')?.authority).toBe('commander');
    expect(config.store.resolve('c17_test_token_2')?.callsign).toBe('ALPHA-1');
    expect(config.store.resolve('c17_test_token_2')?.role).toBe('implementer');
    expect(config.store.resolve('c17_test_token_2')?.authority).toBe('operator');
    expect(config.squadron.name).toBe('alpha-squadron');
    expect(config.squadron.brief).toBe('we own the full lifecycle');
  });

  it('accepts lieutenant as an explicit authority', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'alpha-squadron',
      'mission',
      '',
      // slot 1: commander (default)
      'ACTUAL',
      'operator',
      '',
      '',
      'n',
      'y',
      // slot 2: explicit lieutenant
      'LT-ONE',
      'operator',
      'lieutenant',
      '',
      // LT gets TOTP prompt — skip
      'n',
      'n',
    ]);
    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `c17_t_${++tokenCounter}`,
      qrRenderer: () => '',
    });
    expect(config.store.resolve('c17_t_2')?.authority).toBe('lieutenant');
  });

  it('re-prompts on invalid authority', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([
      'squadron',
      'hold the line',
      '',
      'ACTUAL',
      'operator',
      // invalid authority, then valid
      'admin',
      '',
      // press enter after banner
      '',
      'n',
      'n',
    ]);
    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => 'c17_tok',
      qrRenderer: () => '',
    });
    expect(config.store.size()).toBe(1);
    expect(io.output.some((l) => l.includes('authority must be one of'))).toBe(true);
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
      // commander default
      '',
      '',
      // commander → TOTP prompt fires, skip
      'n',
      'n',
    ]);

    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => 'c17_mocked_token',
      qrRenderer: () => '',
    });

    expect(config.store.size()).toBe(1);
    expect(config.store.resolve('c17_mocked_token')?.callsign).toBe('valid-callsign');
    expect(config.store.resolve('c17_mocked_token')?.role).toBe('custom-role');
    expect(config.roles['custom-role']).toBeDefined();
    expect(io.output.some((l) => l.includes('alphanumeric'))).toBe(true);
    expect(io.output.some((l) => l.includes('custom role'))).toBe(true);

    // Generated config must be loadable — custom role was auto-injected.
    const reloaded = loadSquadronConfigFromFile(configPath);
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
      // commander default
      '',
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
      '', // commander
      '',
      'n',
      'y',
      // duplicate → re-prompted
      'ACTUAL',
      'ALPHA-1',
      'implementer',
      '', // operator
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

    it('enrolls a commander slot with a valid code and persists the secret', async () => {
      const configPath = tmpConfigPath();
      const code = currentCode(FIXED_SECRET, FIXED_NOW);
      const io = mockIO([
        '',
        'mission',
        '',
        'ACTUAL',
        'operator',
        '', // commander (default)
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

      const reloaded = loadSquadronConfigFromFile(configPath);
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
        '', // commander
        '',
        'y',
        '000000',
        code,
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('c17_test_token')?.totpSecret).toBe(FIXED_SECRET);
      expect(io.output.some((l) => l.includes('that code is incorrect'))).toBe(true);
    });

    it('skips enrollment when the user answers n at the prompt', async () => {
      const configPath = tmpConfigPath();
      const io = mockIO(['', 'mission', '', 'ACTUAL', 'operator', '', '', 'n', 'n']);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
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
        '',
        'y',
        '000000',
        '111111',
        '222222',
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('c17_test_token')?.totpSecret).toBeFalsy();
      expect(io.output.some((l) => l.includes('too many bad attempts'))).toBe(true);
    });

    it('does NOT prompt TOTP for plain-operator-authority slots', async () => {
      // The scenario: a single slot that the user explicitly marks as
      // operator authority. Since at least one commander is required,
      // the wizard rejects the config at write time — but the point of
      // this test is just that the TOTP prompt never fires. We catch
      // the SlotLoadError at the end.
      const configPath = tmpConfigPath();
      const io = mockIO([
        '',
        'mission',
        '',
        'ACTUAL',
        'operator',
        'operator', // explicitly downgrade authority
        '',
        // no TOTP prompt — go straight to "add another slot?"
        'n',
      ]);
      await expect(runFirstRunWizard(enrollmentOptions(io, configPath))).rejects.toThrow(
        /at least one slot must have authority=commander/,
      );
      // If the TOTP prompt had fired, the queue would exhaust before
      // we got to the "no commander" check.
      expect(io.output.every((l) => !l.includes('enable web UI login'))).toBe(true);
    });
  });
});
