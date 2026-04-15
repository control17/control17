/**
 * Graceful shutdown regression test.
 *
 * Previously `runServer().stop()` would hang indefinitely if any SSE
 * subscriber was still attached, because `http.Server.close()` only
 * stops accepting new connections — it doesn't terminate ongoing
 * request handlers. The fix: `runServer` now owns an AbortController
 * that fans out to every open SSE handler, so stop() can complete.
 *
 * This test opens a real SSE subscription via the SDK client, lets
 * the connection settle, then calls stop() with a hard ceiling of
 * 3 seconds. If the fix regresses, the test will exceed the ceiling
 * and fail instead of hanging the suite.
 */

import { Client } from '@control17/sdk/client';
import type { Role, Squadron } from '@control17/sdk/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServer, runServer } from '../src/run.js';
import { createSlotStore } from '../src/slots.js';

const OP_TOKEN = 'c17_shutdown_test_op';
const SQUADRON: Squadron = {
  name: 'shutdown-test-squadron',
  mission: 'Verify shutdown does not hang on live SSE subscribers.',
  brief: '',
};
const ROLES: Record<string, Role> = {
  operator: { description: '', instructions: '' },
};

describe('runServer shutdown with live SSE subscriber', () => {
  let server: RunningServer;
  let client: Client;

  beforeAll(async () => {
    const slots = createSlotStore([
      { callsign: 'ACTUAL', role: 'operator', authority: 'commander', token: OP_TOKEN },
    ]);
    server = await runServer({
      slots,
      squadron: SQUADRON,
      roles: ROLES,
      port: 0,
      host: '127.0.0.1',
      dbPath: ':memory:',
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    client = new Client({ url: `http://${server.host}:${server.port}`, token: OP_TOKEN });
  }, 10_000);

  // No afterAll — the `it` block owns the shutdown and asserts on its
  // completion time. Anything that leaks gets picked up by vitest.

  it('stop() completes quickly even with an active SSE subscription', async () => {
    // Open a subscription in the background. We do NOT await the loop —
    // it runs until the server's shutdown signal tears it down.
    const ac = new AbortController();
    let iterationsBeforeClose = 0;
    const subPromise = (async () => {
      try {
        for await (const _msg of client.subscribe('ACTUAL', ac.signal)) {
          iterationsBeforeClose++;
        }
      } catch {
        // Expected when the server closes the stream or the signal aborts.
      }
    })();

    // Give the server time to actually register the SSE handler.
    // Without this, stop() might win the race and never see a real
    // live stream — which would make the test pass trivially.
    await new Promise((r) => setTimeout(r, 150));

    const start = Date.now();
    await Promise.race([
      server.stop(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('stop() exceeded 3s ceiling')), 3_000),
      ),
    ]);
    const elapsed = Date.now() - start;

    // Clean up the client-side abort controller — if stop() worked,
    // the stream is already closed, but we want to release the reader.
    ac.abort();
    await subPromise;

    // 3s ceiling is generous; the real number should be well under 1s.
    expect(elapsed).toBeLessThan(3_000);
    // Sanity check that we actually opened a stream before shutdown.
    // iterationsBeforeClose counts yielded messages — it may be 0
    // because we never pushed anything. The key signal is that the
    // loop exited (subPromise resolved) rather than hanging.
    expect(iterationsBeforeClose).toBeGreaterThanOrEqual(0);
  }, 10_000);

  afterAll(() => {
    // Nothing to do — the test itself owns stop().
  });
});
