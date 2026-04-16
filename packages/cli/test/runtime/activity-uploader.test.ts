/**
 * Streaming activity uploader tests.
 *
 * We pass in a fake `Client` whose `uploadAgentActivity` is a
 * `vi.fn()` that records calls and can be programmed to throw on
 * specific attempts. Tests exercise:
 *
 *   - Batching by event count
 *   - Time-based flush when count/size thresholds aren't hit
 *   - Retry with backoff after a failed upload
 *   - Queue-cap eviction (oldest-first drop)
 *   - Explicit `flush()` and `close()`
 */

import type { Client as BrokerClient } from '@control17/sdk/client';
import type { AgentActivityEvent } from '@control17/sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityUploader } from '../../src/runtime/trace/activity-uploader.js';

function makeEvent(ts: number): AgentActivityEvent {
  return { kind: 'objective_open', ts, objectiveId: `obj-${ts}` };
}

interface FakeClient {
  uploadAgentActivity: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return {
    uploadAgentActivity: vi.fn(async (_callsign: string, req: { events: unknown[] }) => ({
      accepted: req.events.length,
    })),
  };
}

describe('ActivityUploader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a full batch immediately when maxBatchEvents is reached', async () => {
    const client = makeFakeClient();
    const u = new ActivityUploader({
      brokerClient: client as unknown as BrokerClient,
      callsign: 'ALPHA-1',
      log: () => {},
      maxBatchEvents: 3,
    });
    u.enqueue(makeEvent(1));
    u.enqueue(makeEvent(2));
    expect(client.uploadAgentActivity).not.toHaveBeenCalled();
    u.enqueue(makeEvent(3));
    // Threshold reached, scheduled with delay 0 → advance microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.uploadAgentActivity).toHaveBeenCalledTimes(1);
    const payload = client.uploadAgentActivity.mock.calls[0]?.[1] as { events: unknown[] };
    expect(payload.events).toHaveLength(3);
  });

  it('flushes on the time threshold when the count is under the batch cap', async () => {
    const client = makeFakeClient();
    const u = new ActivityUploader({
      brokerClient: client as unknown as BrokerClient,
      callsign: 'ALPHA-1',
      log: () => {},
      maxBatchEvents: 100,
      maxBatchAgeMs: 500,
    });
    u.enqueue(makeEvent(1));
    expect(client.uploadAgentActivity).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(client.uploadAgentActivity).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(client.uploadAgentActivity).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff after a failed upload', async () => {
    const client = makeFakeClient();
    client.uploadAgentActivity
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ accepted: 1 });
    const u = new ActivityUploader({
      brokerClient: client as unknown as BrokerClient,
      callsign: 'ALPHA-1',
      log: () => {},
      maxBatchEvents: 1,
    });
    u.enqueue(makeEvent(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.uploadAgentActivity).toHaveBeenCalledTimes(1);
    // First call failed — queue should still have the event.
    expect(u.__debugQueueLength()).toBe(1);
    // Backoff starts at 200ms. The backoff callback fires at 200ms,
    // then schedules a fresh flush with delay 0, which fires on the
    // next tick. Advance past both.
    await vi.advanceTimersByTimeAsync(250);
    expect(client.uploadAgentActivity).toHaveBeenCalledTimes(2);
    expect(u.__debugQueueLength()).toBe(0);
  });

  it('drops oldest events when the queue cap is hit', () => {
    // Don't use fake timers for this one — we never advance, so
    // the scheduled flush never fires. A large maxBatchEvents
    // (higher than the queue cap) prevents the flush from
    // draining before the cap check kicks in.
    vi.useRealTimers();
    const client = makeFakeClient();
    const u = new ActivityUploader({
      brokerClient: client as unknown as BrokerClient,
      callsign: 'ALPHA-1',
      log: () => {},
      maxBatchEvents: 100,
      maxBatchAgeMs: 60_000,
      maxQueueEvents: 3,
    });
    for (let i = 0; i < 6; i++) u.enqueue(makeEvent(i));
    // Cap is 3 → only the last 3 survive.
    expect(u.__debugQueueLength()).toBe(3);
    vi.useFakeTimers();
  });

  it('close() drains the queue via a final flush', async () => {
    const client = makeFakeClient();
    const u = new ActivityUploader({
      brokerClient: client as unknown as BrokerClient,
      callsign: 'ALPHA-1',
      log: () => {},
      maxBatchEvents: 100,
      maxBatchAgeMs: 10_000, // so it won't flush on its own
    });
    u.enqueue(makeEvent(1));
    u.enqueue(makeEvent(2));
    expect(client.uploadAgentActivity).not.toHaveBeenCalled();
    await u.close();
    expect(client.uploadAgentActivity).toHaveBeenCalledTimes(1);
    expect(u.__debugQueueLength()).toBe(0);
  });

  it('close() drops events permanently on repeated upload failure', async () => {
    const client = makeFakeClient();
    client.uploadAgentActivity.mockRejectedValue(new Error('unreachable'));
    const u = new ActivityUploader({
      brokerClient: client as unknown as BrokerClient,
      callsign: 'ALPHA-1',
      log: () => {},
      maxBatchAgeMs: 10_000,
    });
    u.enqueue(makeEvent(1));
    await u.close();
    expect(u.__debugQueueLength()).toBe(0);
  });
});
