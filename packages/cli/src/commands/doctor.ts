/**
 * `c17 claude-code --doctor` — preflight check for trace capture.
 *
 * Runs a short series of checks against the environment and reports
 * pass / warn / fail for each. The check list mirrors what the
 * runner and trace host actually need at runtime:
 *
 *   1. `claude` binary on PATH (or via `$CLAUDE_PATH`)
 *   2. `$TMPDIR` writable — where the CA cert PEM is written
 *   3. Can bind a loopback TCP listener — for the MITM proxy
 *   4. Per-session CA + leaf cert generation works — catches
 *      crypto-runtime issues before the first `c17 claude-code`
 *
 * The doctor never reaches out to a broker or spawns an agent; it's
 * a local check the operator runs before their first `c17 claude-code`
 * invocation.
 *
 * Output is plain text — one check per line, each prefixed with its
 * status marker. Returns exit code 0 if everything PASSes, 1 if any
 * check FAILs. WARNs don't fail the exit code; they're advisory.
 */

import { randomBytes, X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapterError, findClaudeBinary } from '../runtime/agents/claude-code.js';
import { createCertPool, createTraceCa } from '../runtime/trace/mitm/ca.js';

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
  checks.push(await checkTmpdir());
  checks.push(await checkLoopbackBind());
  checks.push(checkCaGeneration());
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

async function checkLoopbackBind(): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('listening', () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr !== 'string') {
          resolve({
            name: 'loopback proxy bindable',
            status: 'PASS',
            detail: `bound ephemeral on 127.0.0.1:${addr.port}`,
          });
        } else {
          resolve({
            name: 'loopback proxy bindable',
            status: 'FAIL',
            detail: 'unexpected address shape after bind',
          });
        }
      });
    });
    server.once('error', (err) => {
      resolve({
        name: 'loopback proxy bindable',
        status: 'FAIL',
        detail: err instanceof Error ? err.message : String(err),
      });
    });
    server.listen(0, '127.0.0.1');
  });
}

/**
 * Exercise the full CA + leaf cert pipeline once. Failures here
 * indicate a problem with node-forge's crypto runtime, the bundled
 * Node crypto module, or our own code — operator should see an
 * actionable error instead of a generic "trace host failed to
 * start" at `c17 claude-code` time.
 */
function checkCaGeneration(): DoctorCheck {
  try {
    const ca = createTraceCa();
    const pool = createCertPool(ca);
    const leaf = pool.issueLeaf('api.anthropic.com');
    // Sanity-check: Node accepts both PEMs as real X509.
    new X509Certificate(ca.caCertPem);
    new X509Certificate(leaf.certPem);
    return {
      name: 'trace CA + leaf cert generation',
      status: 'PASS',
      detail: 'CA + leaf cert generated and parsed successfully',
    };
  } catch (err) {
    return {
      name: 'trace CA + leaf cert generation',
      status: 'FAIL',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
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
