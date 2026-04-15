/**
 * Keylog tailer unit tests.
 *
 * We use a tmp file + appendFile + drain() to avoid races with the
 * poll timer. The tailer supports three shapes of input:
 *   - Valid NSS entries (label + client_random + secret)
 *   - Comment lines beginning with `#`
 *   - Malformed lines (fewer than 3 fields)
 */

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type KeylogEntry, startKeylogTailer } from '../../src/runtime/trace/keylog.js';

describe('startKeylogTailer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'c17-keylog-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tails new lines appended to the keylog file', async () => {
    const path = join(tmpDir, 'keys.log');
    const entries: KeylogEntry[] = [];
    const tailer = await startKeylogTailer({
      path,
      log: () => {},
      pollIntervalMs: 20,
      onEntry: (e) => entries.push(e),
    });
    try {
      appendFileSync(
        path,
        'CLIENT_HANDSHAKE_TRAFFIC_SECRET aaaaaaaa bbbbbbbb\n' +
          '# comment line\n' +
          'SERVER_HANDSHAKE_TRAFFIC_SECRET cccccccc dddddddd\n',
      );
      await tailer.drain();
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({
        label: 'CLIENT_HANDSHAKE_TRAFFIC_SECRET',
        clientRandom: 'aaaaaaaa',
        secret: 'bbbbbbbb',
      });
      expect(entries[1]?.label).toBe('#');
      expect(entries[1]?.rawLine).toBe('# comment line');
      expect(entries[2]?.label).toBe('SERVER_HANDSHAKE_TRAFFIC_SECRET');
    } finally {
      await tailer.close();
    }
  });

  it('handles appends that arrive across multiple read cycles', async () => {
    const path = join(tmpDir, 'keys.log');
    const entries: KeylogEntry[] = [];
    const tailer = await startKeylogTailer({
      path,
      log: () => {},
      pollIntervalMs: 20,
      onEntry: (e) => entries.push(e),
    });
    try {
      appendFileSync(path, 'CLIENT_RANDOM aa bb\n');
      await tailer.drain();
      expect(entries).toHaveLength(1);

      appendFileSync(path, 'CLIENT_RANDOM cc dd\n');
      await tailer.drain();
      expect(entries).toHaveLength(2);
      expect(entries[1]?.clientRandom).toBe('cc');
    } finally {
      await tailer.close();
    }
  });

  it('surfaces malformed lines with MALFORMED label rather than dropping', async () => {
    const path = join(tmpDir, 'keys.log');
    const entries: KeylogEntry[] = [];
    const tailer = await startKeylogTailer({
      path,
      log: () => {},
      pollIntervalMs: 20,
      onEntry: (e) => entries.push(e),
    });
    try {
      appendFileSync(path, 'only_two_fields value\n');
      await tailer.drain();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.label).toBe('MALFORMED');
      expect(entries[0]?.rawLine).toBe('only_two_fields value');
    } finally {
      await tailer.close();
    }
  });

  it('carries partial trailing lines across reads until a newline arrives', async () => {
    const path = join(tmpDir, 'keys.log');
    const entries: KeylogEntry[] = [];
    const tailer = await startKeylogTailer({
      path,
      log: () => {},
      pollIntervalMs: 20,
      onEntry: (e) => entries.push(e),
    });
    try {
      appendFileSync(path, 'CLIENT_RANDOM aaaa bb');
      await tailer.drain();
      expect(entries).toHaveLength(0);

      appendFileSync(path, 'bb\n');
      await tailer.drain();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.secret).toBe('bbbb');
    } finally {
      await tailer.close();
    }
  });

  it('close() is idempotent', async () => {
    const path = join(tmpDir, 'keys.log');
    const tailer = await startKeylogTailer({ path, log: () => {}, pollIntervalMs: 20 });
    await tailer.close();
    await tailer.close();
  });
});
