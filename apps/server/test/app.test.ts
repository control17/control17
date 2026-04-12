import { Broker, InMemoryEventLog } from '@control17/core';
import { PROTOCOL_HEADER } from '@control17/sdk/protocol';
import type { Message } from '@control17/sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createPrincipalStore } from '../src/principals.js';

const ALICE_TOKEN = 'c17_test_alice_secret';
const BOT_TOKEN = 'c17_test_bot_secret';

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const principals = createPrincipalStore([
    { name: 'alice', kind: 'human', token: ALICE_TOKEN },
    { name: 'build-bot', kind: 'agent', token: BOT_TOKEN },
  ]);
  const app = createApp({
    broker,
    principals,
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  return { app, broker };
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

describe('app GET /whoami', () => {
  it('returns the authenticated principal', async () => {
    const { app } = makeApp();
    const res = await app.request('/whoami', authed(ALICE_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'alice', kind: 'human' });
  });

  it('requires auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/whoami');
    expect(res.status).toBe(401);
  });
});

describe('app auth', () => {
  it('rejects /agents without a bearer token', async () => {
    const { app } = makeApp();
    const res = await app.request('/agents');
    expect(res.status).toBe(401);
  });

  it('rejects /agents with an unknown token', async () => {
    const { app } = makeApp();
    const res = await app.request('/agents', {
      headers: { Authorization: 'Bearer not-in-config' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts /agents from any configured principal', async () => {
    const { app } = makeApp();
    const asAlice = await app.request('/agents', authed(ALICE_TOKEN));
    expect(asAlice.status).toBe(200);
    const asBot = await app.request('/agents', authed(BOT_TOKEN));
    expect(asBot.status).toBe(200);
  });

  it('rejects requests with a mismatched protocol version', async () => {
    const { app } = makeApp();
    const res = await app.request('/agents', {
      headers: {
        Authorization: `Bearer ${ALICE_TOKEN}`,
        [PROTOCOL_HEADER]: '999',
      },
    });
    expect(res.status).toBe(400);
  });
});

describe('app POST /register', () => {
  it('registers the caller under its own principal name', async () => {
    const { app } = makeApp();
    const reg = await app.request('/register', authed(BOT_TOKEN, { agentId: 'build-bot' }));
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as { agentId: string };
    expect(regBody.agentId).toBe('build-bot');

    const list = await app.request('/agents', authed(ALICE_TOKEN));
    const listBody = (await list.json()) as {
      agents: Array<{ agentId: string; kind: string | null }>;
    };
    expect(listBody.agents).toHaveLength(1);
    expect(listBody.agents[0]?.agentId).toBe('build-bot');
    expect(listBody.agents[0]?.kind).toBe('agent');
  });

  it('rejects register when agentId does not equal the principal name', async () => {
    const { app } = makeApp();
    const res = await app.request('/register', authed(BOT_TOKEN, { agentId: 'alice' }));
    expect(res.status).toBe(403);
  });

  it('rejects registration with invalid agentId', async () => {
    const { app } = makeApp();
    const res = await app.request('/register', authed(ALICE_TOKEN, { agentId: 'has spaces' }));
    expect(res.status).toBe(400);
  });
});

describe('app GET /subscribe identity', () => {
  it('rejects subscribe to an agentId other than the principal name', async () => {
    const { app } = makeApp();
    const res = await app.request('/subscribe?agentId=build-bot', authed(ALICE_TOKEN));
    expect(res.status).toBe(403);
  });

  it('requires agentId query parameter', async () => {
    const { app } = makeApp();
    const res = await app.request('/subscribe', authed(ALICE_TOKEN));
    expect(res.status).toBe(400);
  });
});

describe('app POST /push', () => {
  it('delivers a targeted push and stamps from=<principal.name>', async () => {
    const { app, broker } = makeApp();
    await broker.register('build-bot');
    const received: Message[] = [];
    broker.subscribe('build-bot', (m) => {
      received.push(m);
    });

    const res = await app.request(
      '/push',
      authed(ALICE_TOKEN, { agentId: 'build-bot', body: 'hello' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery: { sse: number; targets: number };
      message: { body: string; from: string };
    };
    expect(body.delivery.sse).toBe(1);
    expect(body.delivery.targets).toBe(1);
    expect(body.message.body).toBe('hello');
    expect(body.message.from).toBe('alice');
    expect(received).toHaveLength(1);
    expect(received[0]?.from).toBe('alice');
  });

  it('fans out a DM to the sender if the sender is registered', async () => {
    const { app, broker } = makeApp();
    await broker.register('build-bot');
    await broker.register('alice');
    const aliceInbox: Message[] = [];
    const botInbox: Message[] = [];
    broker.subscribe('alice', (m) => {
      aliceInbox.push(m);
    });
    broker.subscribe('build-bot', (m) => {
      botInbox.push(m);
    });

    const res = await app.request(
      '/push',
      authed(ALICE_TOKEN, { agentId: 'build-bot', body: 'status?' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery: { sse: number; targets: number } };
    expect(body.delivery.targets).toBe(1);
    expect(body.delivery.sse).toBe(2);
    expect(botInbox).toHaveLength(1);
    expect(aliceInbox).toHaveLength(1);
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

  it('returns 404 when targeting an unknown agent', async () => {
    const { app } = makeApp();
    const res = await app.request('/push', authed(ALICE_TOKEN, { agentId: 'ghost', body: 'hi' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid push body', async () => {
    const { app } = makeApp();
    const res = await app.request('/push', authed(ALICE_TOKEN, { body: '' }));
    expect(res.status).toBe(400);
  });

  it('broadcasts to all registered agents when agentId is omitted', async () => {
    const { app, broker } = makeApp();
    await broker.register('a1');
    await broker.register('a2');
    const res = await app.request('/push', authed(ALICE_TOKEN, { body: 'broadcast' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery: { targets: number } };
    expect(body.delivery.targets).toBe(2);
  });
});

describe('app GET /history', () => {
  it('returns broadcasts and DMs relevant to the authenticated caller', async () => {
    const { app } = makeApp();
    // Push a broadcast and a DM to alice.
    await app.request('/push', authed(BOT_TOKEN, { body: 'broadcast' }));
    await app.request('/push', authed(BOT_TOKEN, { agentId: 'alice', body: 'dm to alice' }));
    // Register alice so the push to alice succeeds
    // (push 404s if target is unknown — pre-register)
    // Actually, pushes to unknown agents 404 at the HTTP layer; we need to
    // register alice first, then push again.
  });

  it('returns history filtered by the with parameter', async () => {
    const { app, broker } = makeApp();
    await broker.register('alice');
    await broker.register('build-bot');

    // Use the broker directly to push so we can set from.
    await broker.push({ body: 'broadcast' }, { from: 'alice' });
    await broker.push({ agentId: 'build-bot', body: 'dm to bot' }, { from: 'alice' });
    await broker.push({ agentId: 'alice', body: 'dm from bot' }, { from: 'build-bot' });

    // Full feed for alice: broadcast + both DMs
    const full = await app.request('/history', authed(ALICE_TOKEN));
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as { messages: Array<{ body: string }> };
    expect(fullBody.messages).toHaveLength(3);

    // DMs with build-bot only
    const dm = await app.request('/history?with=build-bot', authed(ALICE_TOKEN));
    expect(dm.status).toBe(200);
    const dmBody = (await dm.json()) as { messages: Array<{ body: string }> };
    expect(dmBody.messages).toHaveLength(2);
    expect(dmBody.messages.every((m) => m.body.includes('dm'))).toBe(true);
  });
});
