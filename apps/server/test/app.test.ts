import { Broker, InMemoryEventLog } from '@control17/core';
import { PROTOCOL_HEADER } from '@control17/sdk/protocol';
import type { BriefingResponse, Message, Role, RosterResponse, Team } from '@control17/sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { SessionStore } from '../src/sessions.js';
import { createSlotStore } from '../src/slots.js';

const OP_TOKEN = 'c17_test_operator_secret';
const BOT_TOKEN = 'c17_test_bot_secret';

const TEAM: Team = {
  name: 'alpha-squadron',
  mission: 'Ship and operate the payment service.',
  brief: 'We own the full lifecycle.',
};

const ROLES: Record<string, Role> = {
  operator: {
    description: 'Directs the team.',
    instructions: 'Lead the team.',
    editor: true,
  },
  implementer: {
    description: 'Writes code.',
    instructions: 'Ship work and report status.',
  },
};

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const slots = createSlotStore([
    { callsign: 'ACTUAL', role: 'operator', token: OP_TOKEN },
    { callsign: 'build-bot', role: 'implementer', token: BOT_TOKEN },
  ]);
  // Tests run with an in-memory SQLite solely for the sessions table.
  // The broker uses InMemoryEventLog above, so these two stores don't
  // actually share state — they only share the SQLite handle because
  // SessionStore needs one.
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const app = createApp({
    broker,
    slots,
    sessions,
    team: TEAM,
    roles: ROLES,
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  return { app, broker, slots, sessions, db };
}

function authed(token: string, body?: unknown): RequestInit {
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) {
    init.method = 'POST';
    init.body = JSON.stringify(body);
  }
  return init;
}

describe('app GET /healthz', () => {
  it('returns status ok without auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '0.0.0' });
  });
});

describe('app GET /briefing', () => {
  it('returns the team-context briefing for the authenticated slot', async () => {
    const { app } = makeApp();
    const res = await app.request('/briefing', authed(OP_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as BriefingResponse;
    expect(body.callsign).toBe('ACTUAL');
    expect(body.role).toBe('operator');
    expect(body.team).toEqual(TEAM);
    expect(body.teammates.map((t) => t.callsign).sort()).toEqual(['ACTUAL', 'build-bot']);
    expect(body.canEdit).toBe(true);
    expect(body.instructions).toContain('ACTUAL');
    expect(body.instructions).toContain('operator');
    expect(body.instructions).toContain(TEAM.mission);
  });

  it('returns canEdit=false for slots whose role lacks the editor flag', async () => {
    const { app } = makeApp();
    const res = await app.request('/briefing', authed(BOT_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as BriefingResponse;
    expect(body.callsign).toBe('build-bot');
    expect(body.role).toBe('implementer');
    expect(body.canEdit).toBe(false);
  });

  it('requires auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/briefing');
    expect(res.status).toBe(401);
  });
});

describe('app auth', () => {
  it('rejects /roster without a bearer token', async () => {
    const { app } = makeApp();
    const res = await app.request('/roster');
    expect(res.status).toBe(401);
  });

  it('rejects /roster with an unknown token', async () => {
    const { app } = makeApp();
    const res = await app.request('/roster', {
      headers: { Authorization: 'Bearer not-in-config' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts /roster from any configured slot', async () => {
    const { app } = makeApp();
    const asOp = await app.request('/roster', authed(OP_TOKEN));
    expect(asOp.status).toBe(200);
    const asBot = await app.request('/roster', authed(BOT_TOKEN));
    expect(asBot.status).toBe(200);
  });

  it('rejects requests with a mismatched protocol version', async () => {
    const { app } = makeApp();
    const res = await app.request('/roster', {
      headers: {
        Authorization: `Bearer ${OP_TOKEN}`,
        [PROTOCOL_HEADER]: '999',
      },
    });
    expect(res.status).toBe(400);
  });
});

describe('app GET /roster', () => {
  it('returns all teammates from the slot config plus runtime connection state', async () => {
    const { app, broker } = makeApp();
    // Pre-seed both slots so they appear in connected state
    broker.seedSlots([
      { callsign: 'ACTUAL', role: 'operator' },
      { callsign: 'build-bot', role: 'implementer' },
    ]);

    const res = await app.request('/roster', authed(OP_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RosterResponse;
    expect(body.teammates.map((t) => t.callsign).sort()).toEqual(['ACTUAL', 'build-bot']);
    expect(body.connected.map((a) => a.agentId).sort()).toEqual(['ACTUAL', 'build-bot']);
    expect(body.connected.every((a) => a.connected === 0)).toBe(true);
  });
});

describe('app GET /subscribe identity', () => {
  it('rejects subscribe to a callsign other than the caller', async () => {
    const { app } = makeApp();
    const res = await app.request('/subscribe?agentId=build-bot', authed(OP_TOKEN));
    expect(res.status).toBe(403);
  });

  it('requires agentId query parameter', async () => {
    const { app } = makeApp();
    const res = await app.request('/subscribe', authed(OP_TOKEN));
    expect(res.status).toBe(400);
  });
});

describe('app POST /push', () => {
  it('delivers a targeted push and stamps from=<callsign>', async () => {
    const { app, broker } = makeApp();
    await broker.register('build-bot');
    const received: Message[] = [];
    broker.subscribe('build-bot', (m) => {
      received.push(m);
    });

    const res = await app.request(
      '/push',
      authed(OP_TOKEN, { agentId: 'build-bot', body: 'hello' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery: { sse: number; targets: number };
      message: { body: string; from: string };
    };
    expect(body.delivery.sse).toBe(1);
    expect(body.delivery.targets).toBe(1);
    expect(body.message.body).toBe('hello');
    expect(body.message.from).toBe('ACTUAL');
    expect(received).toHaveLength(1);
    expect(received[0]?.from).toBe('ACTUAL');
  });

  it('fans out a DM to the sender if the sender is registered', async () => {
    const { app, broker } = makeApp();
    await broker.register('build-bot');
    await broker.register('ACTUAL');
    const opInbox: Message[] = [];
    const botInbox: Message[] = [];
    broker.subscribe('ACTUAL', (m) => {
      opInbox.push(m);
    });
    broker.subscribe('build-bot', (m) => {
      botInbox.push(m);
    });

    const res = await app.request(
      '/push',
      authed(OP_TOKEN, { agentId: 'build-bot', body: 'status?' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery: { sse: number; targets: number } };
    expect(body.delivery.targets).toBe(1);
    expect(body.delivery.sse).toBe(2);
    expect(botInbox).toHaveLength(1);
    expect(opInbox).toHaveLength(1);
  });

  it('stamps from based on which token authenticated, not on payload', async () => {
    const { app } = makeApp();
    const res = await app.request(
      '/push',
      authed(BOT_TOKEN, { body: 'hi', data: { from: 'spoofed' } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { from: string; data: Record<string, unknown> } };
    expect(body.message.from).toBe('build-bot');
    expect(body.message.data).toEqual({ from: 'spoofed' });
  });

  it('returns 404 when targeting an unknown callsign', async () => {
    const { app } = makeApp();
    const res = await app.request('/push', authed(OP_TOKEN, { agentId: 'ghost', body: 'hi' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid push body', async () => {
    const { app } = makeApp();
    const res = await app.request('/push', authed(OP_TOKEN, { body: '' }));
    expect(res.status).toBe(400);
  });

  it('broadcasts to all registered agents when agentId is omitted', async () => {
    const { app, broker } = makeApp();
    await broker.register('a1');
    await broker.register('a2');
    const res = await app.request('/push', authed(OP_TOKEN, { body: 'broadcast' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery: { targets: number } };
    expect(body.delivery.targets).toBe(2);
  });

  it('treats explicit agentId: null as a broadcast', async () => {
    const { app, broker } = makeApp();
    await broker.register('a1');
    const res = await app.request(
      '/push',
      authed(OP_TOKEN, { agentId: null, body: 'null-target' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery: { targets: number };
      message: { agentId: string | null };
    };
    expect(body.delivery.targets).toBe(1);
    expect(body.message.agentId).toBeNull();
  });
});

describe('app GET /history', () => {
  it('returns history filtered by the with parameter', async () => {
    const { app, broker } = makeApp();
    await broker.register('ACTUAL');
    await broker.register('build-bot');

    // Use the broker directly to push so we can set from.
    await broker.push({ body: 'broadcast' }, { from: 'ACTUAL' });
    await broker.push({ agentId: 'build-bot', body: 'dm to bot' }, { from: 'ACTUAL' });
    await broker.push({ agentId: 'ACTUAL', body: 'dm from bot' }, { from: 'build-bot' });

    // Full feed for operator: broadcast + both DMs
    const full = await app.request('/history', authed(OP_TOKEN));
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as { messages: Array<{ body: string }> };
    expect(fullBody.messages).toHaveLength(3);

    // DMs with build-bot only
    const dm = await app.request('/history?with=build-bot', authed(OP_TOKEN));
    expect(dm.status).toBe(200);
    const dmBody = (await dm.json()) as { messages: Array<{ body: string }> };
    expect(dmBody.messages).toHaveLength(2);
    expect(dmBody.messages.every((m) => m.body.includes('dm'))).toBe(true);
  });

  it('rejects an invalid `with` callsign with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/history?with=%00%20bad%20callsign', authed(OP_TOKEN));
    expect(res.status).toBe(400);
  });

  it('rejects a non-finite `before` parameter with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/history?before=not-a-number', authed(OP_TOKEN));
    expect(res.status).toBe(400);
  });

  it('clamps limit=0 to the default page size', async () => {
    const { app, broker } = makeApp();
    for (let i = 0; i < 3; i++) {
      await broker.push({ body: `msg-${i}` }, { from: 'ACTUAL' });
    }
    const res = await app.request('/history?limit=0', authed(OP_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages.length).toBe(3);
  });
});
