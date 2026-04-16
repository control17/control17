/**
 * Agent activity endpoint tests.
 *
 * Covers the full permission matrix and query surface for
 * `POST /agents/:callsign/activity` and
 * `GET /agents/:callsign/activity`:
 *
 *   POST: only the slot itself may upload. Commanders reading
 *         someone else's activity is fine; commanders WRITING
 *         someone else's activity is not.
 *   GET:  the slot itself OR any commander. Non-commander reading
 *         another slot's activity is 403.
 *
 *   Range filters: from/to bounds, kind filter (single + array).
 *
 * The in-process EventEmitter-based SSE stream is NOT exercised
 * here — it requires holding the connection open, which the Hono
 * test app.request() interface doesn't quite support cleanly.
 * We rely on the store-level subscribe() tests for that behavior
 * and let an integration test at the runner level cover the
 * full stream path.
 */

import { Broker, InMemoryEventLog } from '@control17/core';
import { AGENT_PATHS } from '@control17/sdk/protocol';
import type {
  AgentActivityEvent,
  ListAgentActivityResponse,
  Role,
  Squadron,
} from '@control17/sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteAgentActivityStore } from '../src/agent-activity.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { SessionStore } from '../src/sessions.js';
import { createSlotStore } from '../src/slots.js';

const CMD_TOKEN = 'c17_test_commander';
const ASSIGNEE_TOKEN = 'c17_test_assignee';
const OTHER_TOKEN = 'c17_test_other';

const SQUADRON: Squadron = {
  name: 'alpha-squadron',
  mission: 'Ship the payments service.',
  brief: 'End-to-end ownership.',
};

const ROLES: Record<string, Role> = {
  operator: { description: 'Directs the squadron.', instructions: 'Lead.' },
  implementer: { description: 'Writes code.', instructions: 'Ship work.' },
};

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const slots = createSlotStore([
    { callsign: 'ACTUAL', role: 'operator', authority: 'commander', token: CMD_TOKEN },
    { callsign: 'ALPHA-1', role: 'implementer', token: ASSIGNEE_TOKEN },
    { callsign: 'BRAVO-1', role: 'implementer', token: OTHER_TOKEN },
  ]);
  const db = openDatabase(':memory:');
  const agentActivity = createSqliteAgentActivityStore(db);
  const app = createApp({
    broker,
    slots,
    sessions: new SessionStore(db),
    agentActivity,
    squadron: SQUADRON,
    roles: ROLES,
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  return { app, agentActivity, db };
}

function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

function post(token: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function sampleEvent(
  ts: number,
  kind: 'llm_exchange' | 'opaque_http' = 'llm_exchange',
): AgentActivityEvent {
  if (kind === 'llm_exchange') {
    return {
      kind: 'llm_exchange',
      ts,
      duration: 123,
      entry: {
        kind: 'anthropic_messages',
        startedAt: ts,
        endedAt: ts + 123,
        request: {
          model: 'claude-sonnet-4-6',
          maxTokens: 1024,
          temperature: null,
          system: null,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          tools: null,
        },
        response: {
          stopReason: 'end_turn',
          stopSequence: null,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
          status: 200,
        },
      },
    };
  }
  return {
    kind: 'opaque_http',
    ts,
    duration: 10,
    entry: {
      kind: 'opaque_http',
      startedAt: ts,
      endedAt: ts + 10,
      host: 'telemetry.example.com',
      method: 'POST',
      url: '/ping',
      status: 204,
      requestHeaders: {},
      responseHeaders: {},
      requestBodyPreview: null,
      responseBodyPreview: null,
    },
  };
}

describe('POST /agents/:callsign/activity', () => {
  let app: ReturnType<typeof makeApp>['app'];

  beforeEach(() => {
    app = makeApp().app;
  });

  it('accepts events from the slot itself and returns the count', async () => {
    const res = await app.request(
      AGENT_PATHS.activity('ALPHA-1'),
      post(ASSIGNEE_TOKEN, { events: [sampleEvent(1_700_000_000_000)] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accepted: number };
    expect(body.accepted).toBe(1);
  });

  it('rejects uploads targeting another slot (even from a commander)', async () => {
    const res = await app.request(
      AGENT_PATHS.activity('ALPHA-1'),
      post(CMD_TOKEN, { events: [sampleEvent(1_700_000_000_000)] }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects uploads from an unrelated teammate', async () => {
    const res = await app.request(
      AGENT_PATHS.activity('ALPHA-1'),
      post(OTHER_TOKEN, { events: [sampleEvent(1_700_000_000_000)] }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects malformed event payloads', async () => {
    const res = await app.request(
      AGENT_PATHS.activity('ALPHA-1'),
      post(ASSIGNEE_TOKEN, { events: [{ kind: 'bogus', ts: 1 }] }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects empty event lists (schema requires at least one)', async () => {
    const res = await app.request(
      AGENT_PATHS.activity('ALPHA-1'),
      post(ASSIGNEE_TOKEN, { events: [] }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /agents/:callsign/activity', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let agentActivity: ReturnType<typeof makeApp>['agentActivity'];

  beforeEach(() => {
    const fixture = makeApp();
    app = fixture.app;
    agentActivity = fixture.agentActivity;

    // Seed three events at different timestamps + kinds.
    agentActivity.append('ALPHA-1', [
      sampleEvent(1_000, 'llm_exchange'),
      sampleEvent(2_000, 'opaque_http'),
      sampleEvent(3_000, 'llm_exchange'),
    ]);
  });

  it('returns all events for the slot itself', async () => {
    const res = await app.request(AGENT_PATHS.activity('ALPHA-1'), bearer(ASSIGNEE_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAgentActivityResponse;
    expect(body.activity).toHaveLength(3);
  });

  it('returns all events to a commander reading another slot', async () => {
    const res = await app.request(AGENT_PATHS.activity('ALPHA-1'), bearer(CMD_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAgentActivityResponse;
    expect(body.activity).toHaveLength(3);
  });

  it('rejects a non-commander reading another slot', async () => {
    const res = await app.request(AGENT_PATHS.activity('ALPHA-1'), bearer(OTHER_TOKEN));
    expect(res.status).toBe(403);
  });

  it('filters by ts range', async () => {
    const res = await app.request(
      `${AGENT_PATHS.activity('ALPHA-1')}?from=1500&to=2500`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAgentActivityResponse;
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0]?.event.ts).toBe(2_000);
  });

  it('filters by single kind', async () => {
    const res = await app.request(
      `${AGENT_PATHS.activity('ALPHA-1')}?kind=llm_exchange`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAgentActivityResponse;
    expect(body.activity).toHaveLength(2);
    for (const row of body.activity) {
      expect(row.event.kind).toBe('llm_exchange');
    }
  });

  it('filters by multiple kinds (?kind=llm_exchange&kind=opaque_http)', async () => {
    const res = await app.request(
      `${AGENT_PATHS.activity('ALPHA-1')}?kind=llm_exchange&kind=opaque_http`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAgentActivityResponse;
    expect(body.activity).toHaveLength(3);
  });

  it('rejects an unknown kind', async () => {
    const res = await app.request(
      `${AGENT_PATHS.activity('ALPHA-1')}?kind=nope`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(400);
  });

  it('honors limit and returns newest-first', async () => {
    const res = await app.request(
      `${AGENT_PATHS.activity('ALPHA-1')}?limit=2`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAgentActivityResponse;
    expect(body.activity).toHaveLength(2);
    // Newest first.
    expect(body.activity[0]?.event.ts).toBe(3_000);
    expect(body.activity[1]?.event.ts).toBe(2_000);
  });

  it('returns empty list for an unknown callsign (no 404)', async () => {
    // We don't gate GET on callsign existence — an unknown slot
    // just has no rows. 403 would leak whether the slot exists;
    // empty list is the correct shape.
    const res = await app.request(AGENT_PATHS.activity('UNKNOWN'), bearer(CMD_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAgentActivityResponse;
    expect(body.activity).toHaveLength(0);
  });
});

describe('agent activity store directly', () => {
  it('subscribe fires synchronously on append', () => {
    const db = openDatabase(':memory:');
    const store = createSqliteAgentActivityStore(db);
    const received: number[] = [];
    const unsubscribe = store.subscribe('ALPHA-1', (row) => {
      received.push(row.event.ts);
    });
    store.append('ALPHA-1', [sampleEvent(1_000), sampleEvent(2_000)]);
    expect(received).toEqual([1_000, 2_000]);
    unsubscribe();
    store.append('ALPHA-1', [sampleEvent(3_000)]);
    // No more calls after unsubscribe.
    expect(received).toEqual([1_000, 2_000]);
  });

  it('subscribe is keyed per callsign', () => {
    const db = openDatabase(':memory:');
    const store = createSqliteAgentActivityStore(db);
    const alphaRows: number[] = [];
    const bravoRows: number[] = [];
    store.subscribe('ALPHA-1', (row) => alphaRows.push(row.event.ts));
    store.subscribe('BRAVO-1', (row) => bravoRows.push(row.event.ts));
    store.append('ALPHA-1', [sampleEvent(1)]);
    store.append('BRAVO-1', [sampleEvent(2)]);
    expect(alphaRows).toEqual([1]);
    expect(bravoRows).toEqual([2]);
  });
});
