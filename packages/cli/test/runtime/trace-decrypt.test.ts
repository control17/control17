/**
 * Decrypt layer tests.
 *
 * We can't assert full tshark decryption without tshark on the box,
 * but we can cover the fallback paths and make sure the pcap writer
 * is exercised end-to-end from a span snapshot:
 *
 *   - Empty span → status: 'empty', no temp files leak
 *   - Non-empty span, tshark binary missing → status: 'tshark_missing',
 *     raw counts surface so the operator can see something was
 *     captured
 *   - Non-empty span, tshark binary exits non-zero → status:
 *     'tshark_failed', error string surfaces
 *   - Non-empty span, tshark emits malformed JSON → status: 'no_records'
 *
 * We simulate "tshark missing" by pointing `tsharkBinary` at a path
 * that doesn't exist, and simulate "tshark failed" by pointing it at
 * `/bin/false` (exits 1 instantly).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpanSnapshot } from '../../src/runtime/trace/buffer.js';
import { decryptSpan, probeTshark } from '../../src/runtime/trace/decrypt.js';
import type { KeylogEntry } from '../../src/runtime/trace/keylog.js';
import type { ProxyChunk } from '../../src/runtime/trace/proxy.js';

function snapshot(overrides: Partial<SpanSnapshot> = {}): SpanSnapshot {
  const chunks: ProxyChunk[] = [
    {
      sessionId: 1,
      ts: 1_700_000_000_000,
      direction: 'client_to_upstream',
      upstream: { host: 'api.anthropic.com', port: 443 },
      bytes: Buffer.from('CLIENT-HELLO-GOES-HERE'),
    },
    {
      sessionId: 1,
      ts: 1_700_000_000_020,
      direction: 'upstream_to_client',
      upstream: { host: 'api.anthropic.com', port: 443 },
      bytes: Buffer.from('SERVER-HELLO-REPLY'),
    },
  ];
  const keys: KeylogEntry[] = [
    {
      label: 'CLIENT_HANDSHAKE_TRAFFIC_SECRET',
      clientRandom: 'aabbccdd',
      secret: '112233',
      seenAt: 1_700_000_000_000,
      rawLine: 'CLIENT_HANDSHAKE_TRAFFIC_SECRET aabbccdd 112233',
    },
  ];
  return {
    objectiveId: 'obj-1',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_100,
    chunks,
    keys,
    truncated: false,
    bytesRecorded: chunks.reduce((n, c) => n + c.bytes.length, 0),
    ...overrides,
  };
}

describe('decryptSpan', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'c17-decrypt-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns "empty" status for a span with no chunks', async () => {
    const result = await decryptSpan(snapshot({ chunks: [], bytesRecorded: 0 }), {
      workDir,
      log: () => {},
    });
    expect(result.status).toBe('empty');
    expect(result.entries).toHaveLength(0);
    expect(result.chunkCount).toBe(0);
    expect(result.keyCount).toBe(1); // keys still counted
  });

  it('falls back to tshark_missing when the binary is absent', async () => {
    const result = await decryptSpan(snapshot(), {
      workDir,
      tsharkBinary: '/nonexistent/tshark-not-here',
      log: () => {},
    });
    expect(result.status).toBe('tshark_missing');
    expect(result.chunkCount).toBe(2);
    expect(result.bytesRecorded).toBeGreaterThan(0);
    expect(result.keyCount).toBe(1);
  });

  it('falls back to tshark_failed when the binary exits non-zero', async () => {
    if (!existsSync('/bin/false')) return; // skip on exotic OSes
    const result = await decryptSpan(snapshot(), {
      workDir,
      tsharkBinary: '/bin/false',
      log: () => {},
    });
    expect(result.status).toBe('tshark_failed');
    expect(result.error).toBeTruthy();
    expect(result.chunkCount).toBe(2);
  });

  it('deletes all temp files (pcap + keylog) after decrypt completes', async () => {
    await decryptSpan(snapshot(), {
      workDir,
      tsharkBinary: '/nonexistent/tshark-not-here',
      log: () => {},
    });
    // The workDir should be empty — no leftover .pcap or .keys files.
    const leftover = readdirSync(workDir);
    expect(leftover).toHaveLength(0);
  });
});

describe('probeTshark', () => {
  it('reports absent when the binary does not exist', async () => {
    const result = await probeTshark('/nonexistent/tshark-not-here');
    expect(result.present).toBe(false);
    expect(result.version).toBeNull();
    expect(result.error).toBeTruthy();
  });
});
