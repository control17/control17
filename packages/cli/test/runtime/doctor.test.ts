/**
 * Doctor unit tests — we exercise the high-level report shape rather
 * than every individual check. The individual checks (tshark,
 * tmpdir, SOCKS bind, claude binary) all have their own failure
 * paths covered in the trace module tests; here we just prove the
 * overall runner wires them together, formats them readably, and
 * sets `anyFail` correctly when any check fails.
 *
 * We mask out CLAUDE_PATH to force the claude check into its
 * failure path (assuming there's no global `claude` binary on the
 * box — this is true in CI). The tmpdir + SOCKS checks are expected
 * to PASS on any reasonable dev environment.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatReport, runDoctor } from '../../src/commands/doctor.js';

describe('runDoctor', () => {
  let savedClaudePath: string | undefined;

  beforeEach(() => {
    savedClaudePath = process.env.CLAUDE_PATH;
    delete process.env.CLAUDE_PATH;
  });

  afterEach(() => {
    if (savedClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = savedClaudePath;
  });

  it('returns a check for every category (claude/tshark/tmpdir/socks)', async () => {
    const report = await runDoctor();
    const names = report.checks.map((c) => c.name);
    expect(names).toContain('tshark (for trace decryption)');
    expect(names).toContain('$TMPDIR writable');
    expect(names).toContain('SOCKS loopback bindable');
    expect(names.some((n) => n.includes('claude'))).toBe(true);
  });

  it('sets anyFail true when a required check fails', async () => {
    // Force claude failure by pointing at a bad path.
    process.env.CLAUDE_PATH = '/nonexistent/claude-binary';
    const report = await runDoctor();
    const claude = report.checks.find((c) => c.name.includes('claude'));
    expect(claude?.status).toBe('FAIL');
    expect(report.anyFail).toBe(true);
  });

  it('tshark-missing is a WARN not a FAIL', async () => {
    const report = await runDoctor();
    const tshark = report.checks.find((c) => c.name.includes('tshark'));
    if (tshark?.status === 'PASS') return; // tshark happens to be installed
    expect(tshark?.status).toBe('WARN');
  });

  it('formatReport produces human-readable output', async () => {
    const report = await runDoctor();
    const text = formatReport(report);
    expect(text).toMatch(/\[(PASS|WARN|FAIL)\]/);
    expect(text).toMatch(/doctor: (OK|FAIL)/);
  });
});
