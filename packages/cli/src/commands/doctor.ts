/**
 * `c17 claude-code --doctor` — preflight check for trace capture.
 *
 * Runs a short series of checks against the environment and reports
 * pass / warn / fail for each. The check list mirrors what the
 * runner and trace host actually need at runtime:
 *
 *   1. `claude` binary on PATH (or via `$CLAUDE_PATH`)
 *   2. `tshark` on PATH — required for decryption (Phase 6)
 *   3. `$TMPDIR` writable — keylog + pcap land here
 *   4. Can bind a SOCKS listener on 127.0.0.1:0 — Phase 5 relay
 *
 * The doctor never reaches out to a broker or spawns an agent; it's
 * a local check the operator runs before their first `c17 claude-code`
 * invocation.
 *
 * Output is plain text — one check per line, each prefixed with its
 * status marker. No emoji unless the user explicitly asks. Returns
 * an exit code: 0 if everything PASSes, 1 if any check FAILs. WARNs
 * don't fail the exit code; they're advisory.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapterError, findClaudeBinary } from '../runtime/agents/claude-code.js';
import { probeTshark } from '../runtime/trace/decrypt.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  anyFail: boolean;
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(await checkClaude());
  checks.push(await checkTshark());
  checks.push(await checkTmpdir());
  checks.push(await checkSocksBind());
  return { checks, anyFail: checks.some((c) => c.status === 'FAIL') };
}

async function checkClaude(): Promise<DoctorCheck> {
  try {
    const path = findClaudeBinary();
    return { name: 'claude binary', status: 'PASS', detail: path };
  } catch (err) {
    const detail =
      err instanceof ClaudeCodeAdapterError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { name: 'claude binary', status: 'FAIL', detail };
  }
}

async function checkTshark(): Promise<DoctorCheck> {
  const result = await probeTshark();
  if (result.present) {
    return {
      name: 'tshark (for trace decryption)',
      status: 'PASS',
      detail: result.version ?? 'present',
    };
  }
  return {
    name: 'tshark (for trace decryption)',
    status: 'WARN',
    detail:
      'not found — trace capture still works but decoded entries will be empty. ' +
      'Install with `apt install tshark` (Debian/Ubuntu) or `brew install wireshark`.',
  };
}

async function checkTmpdir(): Promise<DoctorCheck> {
  const dir = tmpdir();
  const probePath = join(dir, `c17-doctor-${randomBytes(4).toString('hex')}`);
  try {
    await fs.writeFile(probePath, 'ok', { mode: 0o600 });
    await fs.unlink(probePath);
    return { name: '$TMPDIR writable', status: 'PASS', detail: dir };
  } catch (err) {
    return {
      name: '$TMPDIR writable',
      status: 'FAIL',
      detail: `${dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkSocksBind(): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('listening', () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr !== 'string') {
          resolve({
            name: 'SOCKS loopback bindable',
            status: 'PASS',
            detail: `bound ephemeral on 127.0.0.1:${addr.port}`,
          });
        } else {
          resolve({
            name: 'SOCKS loopback bindable',
            status: 'FAIL',
            detail: 'unexpected address shape after bind',
          });
        }
      });
    });
    server.once('error', (err) => {
      resolve({
        name: 'SOCKS loopback bindable',
        status: 'FAIL',
        detail: err instanceof Error ? err.message : String(err),
      });
    });
    server.listen(0, '127.0.0.1');
  });
}

/** Format a report for human-readable stdout. */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.name} — ${check.detail}`);
  }
  lines.push('');
  lines.push(report.anyFail ? 'doctor: FAIL' : 'doctor: OK');
  return lines.join('\n');
}
