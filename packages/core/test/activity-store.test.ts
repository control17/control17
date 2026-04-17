import type { AgentActivityEvent, AgentActivityKind } from '@control17/sdk/types';
import { describe, expect, it } from 'vitest';
import { clampListLimit, InMemoryActivityStore } from '../src/activity-store.js';

// ── helpers ──────────────────────────────────────────────────────────

function llm(ts: number): AgentActivityEvent {
  return {
    kind: 'llm_exchange',
    ts,
    duration: 100,
    entry: {
      kind: 'anthropic_messages',
      startedAt: ts,
      endedAt: ts + 100,
      host: 'api.anthropic.com',
      method: 'POST',
      url: '/v1/messages',
      status: 200,
      model: 'claude-sonnet-4-6',
      maxTokens: 1024,
      system: [],
      messages: [],
      tools: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  };
}

function opaque(ts: number, host = 'example.com'): AgentActivityEvent {
  return {
    kind: 'opaque_http',
    ts,
    duration: 50,
    entry: {
      kind: 'opaque_http',
      startedAt: ts,
      endedAt: ts + 50,
      host,
      method: 'GET',
      url: '/',
      status: 200,
      requestHeaders: {},
      responseHeaders: {},
      requestBodyPreview: null,
      responseBodyPreview: null,
    },
  };
}

function objectiveOpen(ts: number, id = 'obj-1'): AgentActivityEvent {
  return { kind: 'objective_open', ts, objectiveId: id };
}

function store(options: { now?: () => number; maxLimit?: number } = {}) {
  let tick = 0;
  return new InMemoryActivityStore({
    now: options.now ?? (() => ++tick),
    maxLimit: options.maxLimit,
  });
}

// ── clampListLimit ───────────────────────────────────────────────────

describe('clampListLimit', () => {
  it('returns max/2 when undefined', () => {
    expect(clampListLimit(undefined, 1000)).toBe(500);
  });
  it('returns max/2 when non-finite or <=0', () => {
    expect(clampListLimit(Number.NaN, 1000)).toBe(500);
    expect(clampListLimit(0, 1000)).toBe(500);
    expect(clampListLimit(-5, 1000)).toBe(500);
  });
  it('clamps above max', () => {
    expect(clampListLimit(5000, 1000)).toBe(1000);
  });
  it('floors to an integer', () => {
    expect(clampListLimit(42.9, 1000)).toBe(42);
  });
});

// ── append ──────────────────────────────────────────────────────────

describe('InMemoryActivityStore.append', () => {
  it('returns rows with monotonic ids and the injected createdAt', () => {
    const s = store({ now: () => 777 });
    const rows = s.append('ALPHA-1', [llm(100), llm(200)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(1);
    expect(rows[1]?.id).toBe(2);
    expect(rows[0]?.slotCallsign).toBe('ALPHA-1');
    expect(rows[0]?.createdAt).toBe(777);
    expect(rows[1]?.createdAt).toBe(777);
  });

  it('is a no-op on empty-array input', () => {
    const s = store();
    const rows = s.append('ALPHA-1', []);
    expect(rows).toEqual([]);
    expect(s.size()).toBe(0);
  });

  it('keeps id monotonically increasing across slots', () => {
    const s = store();
    const a = s.append('ALPHA-1', [llm(1)]);
    const b = s.append('BRAVO-1', [llm(2)]);
    const c = s.append('ALPHA-1', [llm(3)]);
    expect(a[0]?.id).toBe(1);
    expect(b[0]?.id).toBe(2);
    expect(c[0]?.id).toBe(3);
  });
});

// ── list ─────────────────────────────────────────────────────────────

describe('InMemoryActivityStore.list', () => {
  it('returns newest-first', () => {
    const s = store();
    s.append('ALPHA-1', [llm(100), llm(200), llm(150)]);
    const rows = s.list({ slotCallsign: 'ALPHA-1' });
    // Newest-first by ts; then stable on insertion within same ts.
    expect(rows.map((r) => r.event.ts)).toEqual([150, 200, 100]);
  });

  it('filters by kind', () => {
    const s = store();
    s.append('ALPHA-1', [llm(100), opaque(150), objectiveOpen(200)]);
    const opaqueRows = s.list({ slotCallsign: 'ALPHA-1', kinds: ['opaque_http'] });
    expect(opaqueRows).toHaveLength(1);
    expect(opaqueRows[0]?.event.kind).toBe('opaque_http');

    const lifecycleRows = s.list({
      slotCallsign: 'ALPHA-1',
      kinds: ['objective_open', 'objective_close'] as readonly AgentActivityKind[],
    });
    expect(lifecycleRows).toHaveLength(1);
    expect(lifecycleRows[0]?.event.kind).toBe('objective_open');
  });

  it('filters by from/to inclusive', () => {
    const s = store();
    s.append('ALPHA-1', [llm(100), llm(200), llm(300), llm(400)]);
    const rows = s.list({ slotCallsign: 'ALPHA-1', from: 200, to: 300 });
    expect(rows.map((r) => r.event.ts).sort()).toEqual([200, 300]);
  });

  it('honors limit', () => {
    const s = store();
    const events = Array.from({ length: 50 }, (_, i) => llm(i + 1));
    s.append('ALPHA-1', events);
    const rows = s.list({ slotCallsign: 'ALPHA-1', limit: 5 });
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.event.ts)).toEqual([50, 49, 48, 47, 46]);
  });

  it('clamps limit to maxLimit', () => {
    const s = store({ maxLimit: 10 });
    const events = Array.from({ length: 100 }, (_, i) => llm(i + 1));
    s.append('ALPHA-1', events);
    const rows = s.list({ slotCallsign: 'ALPHA-1', limit: 999 });
    expect(rows).toHaveLength(10);
  });

  it('returns empty for unknown slot', () => {
    const s = store();
    expect(s.list({ slotCallsign: 'NOBODY' })).toEqual([]);
  });

  it('isolates slots from each other', () => {
    const s = store();
    s.append('ALPHA-1', [llm(10)]);
    s.append('BRAVO-1', [llm(20), llm(30)]);
    expect(s.list({ slotCallsign: 'ALPHA-1' })).toHaveLength(1);
    expect(s.list({ slotCallsign: 'BRAVO-1' })).toHaveLength(2);
  });
});

// ── subscribe ────────────────────────────────────────────────────────

describe('InMemoryActivityStore.subscribe', () => {
  it('fires listeners per appended row', () => {
    const s = store();
    const seen: number[] = [];
    s.subscribe('ALPHA-1', (row) => seen.push(row.event.ts));
    s.append('ALPHA-1', [llm(100), llm(200)]);
    expect(seen).toEqual([100, 200]);
  });

  it('only fires listeners for the matching slot', () => {
    const s = store();
    const aSeen: number[] = [];
    const bSeen: number[] = [];
    s.subscribe('ALPHA-1', (row) => aSeen.push(row.event.ts));
    s.subscribe('BRAVO-1', (row) => bSeen.push(row.event.ts));
    s.append('ALPHA-1', [llm(100)]);
    s.append('BRAVO-1', [llm(200)]);
    expect(aSeen).toEqual([100]);
    expect(bSeen).toEqual([200]);
  });

  it('unsubscribe stops further fires', () => {
    const s = store();
    const seen: number[] = [];
    const unsub = s.subscribe('ALPHA-1', (row) => seen.push(row.event.ts));
    s.append('ALPHA-1', [llm(100)]);
    unsub();
    s.append('ALPHA-1', [llm(200)]);
    expect(seen).toEqual([100]);
  });

  it('a listener that unsubscribes itself during a batch still processes the rest of its rows', () => {
    const s = store();
    const seen: number[] = [];
    const unsub = s.subscribe('ALPHA-1', (row) => {
      seen.push(row.event.ts);
      // Unsubscribes immediately on first fire. Second row in the same
      // batch still reaches this listener because the append's listener
      // loop holds a snapshot; other listeners (if any) would observe
      // the unsubscribe for future batches.
      unsub();
    });
    s.append('ALPHA-1', [llm(100), llm(200)]);
    expect(seen).toEqual([100, 200]);
    // Second append doesn't fire the (now-unsubscribed) listener.
    s.append('ALPHA-1', [llm(300)]);
    expect(seen).toEqual([100, 200]);
  });

  it('a throwing listener does not abort fan-out to other listeners', () => {
    const s = store();
    const good: number[] = [];
    s.subscribe('ALPHA-1', () => {
      throw new Error('boom');
    });
    s.subscribe('ALPHA-1', (row) => good.push(row.event.ts));
    s.append('ALPHA-1', [llm(100)]);
    expect(good).toEqual([100]);
  });

  it('row appears in a synchronous list() from inside a listener', () => {
    const s = store();
    const seenCountAtFireTime: number[] = [];
    s.subscribe('ALPHA-1', () => {
      seenCountAtFireTime.push(s.list({ slotCallsign: 'ALPHA-1' }).length);
    });
    s.append('ALPHA-1', [llm(100), llm(200)]);
    // Both calls happen AFTER the batch was fully persisted, so both
    // list() calls see the full 2-row state.
    expect(seenCountAtFireTime).toEqual([2, 2]);
  });
});
