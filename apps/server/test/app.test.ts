import { Broker, InMemoryEventLog } from '@control17/core';
import { PROTOCOL_HEADER } from '@control17/sdk/protocol';
import type { Message } from '@control17/sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const TOKEN = 'test-token';

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const app = createApp({
    broker,
    token: TOKEN,
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

function authed(body?: unknown): RequestInit {
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
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

describe('app auth', () => {
  it('rejects /agents without a bearer token', async () => {
    const { app } = makeApp();
    const res = await app.request('/agents');
    expect(res.status).toBe(401);
  });

  it('rejects /agents with the wrong token', async () => {
    const { app } = makeApp();
    const res = await app.request('/agents', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with a mismatched protocol version', async () => {
    const { app } = makeApp();
    const res = await app.request('/agents', {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        [PROTOCOL_HEADER]: '999',
      },
    });
    expect(res.status).toBe(400);
  });
});

describe('app POST /register + GET /agents', () => {
  it('registers an agent and returns it in the list', async () => {
    const { app } = makeApp();
    const reg = await app.request('/register', authed({ agentId: 'agent-1' }));
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as { agentId: string; registeredAt: number };
    expect(regBody.agentId).toBe('agent-1');

    const list = await app.request('/agents', authed());
    const listBody = (await list.json()) as { agents: Array<{ agentId: string }> };
    expect(listBody.agents).toHaveLength(1);
    expect(listBody.agents[0]?.agentId).toBe('agent-1');
  });

  it('rejects registration with invalid agentId', async () => {
    const { app } = makeApp();
    const res = await app.request('/register', authed({ agentId: 'has spaces' }));
    expect(res.status).toBe(400);
  });
});

describe('app POST /push', () => {
  it('delivers a targeted push to live subscribers', async () => {
    const { app, broker } = makeApp();
    await broker.register('agent-1');
    const received: Message[] = [];
    broker.subscribe('agent-1', (m) => {
      received.push(m);
    });

    const res = await app.request('/push', authed({ agentId: 'agent-1', body: 'hello' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery: { sse: number; targets: number };
      message: { body: string };
    };
    expect(body.delivery.sse).toBe(1);
    expect(body.delivery.targets).toBe(1);
    expect(body.message.body).toBe('hello');
    expect(received).toHaveLength(1);
  });

  it('returns 404 when targeting an unknown agent', async () => {
    const { app } = makeApp();
    const res = await app.request('/push', authed({ agentId: 'ghost', body: 'hi' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid push body', async () => {
    const { app } = makeApp();
    const res = await app.request('/push', authed({ body: '' }));
    expect(res.status).toBe(400);
  });

  it('broadcasts to all registered agents when agentId is omitted', async () => {
    const { app, broker } = makeApp();
    await broker.register('a1');
    await broker.register('a2');
    const res = await app.request('/push', authed({ body: 'broadcast' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery: { targets: number } };
    expect(body.delivery.targets).toBe(2);
  });
});
