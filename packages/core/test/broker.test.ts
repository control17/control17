import type { Message } from '@control17/sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { Broker, InMemoryEventLog } from '../src/index.js';

function makeBroker(overrides: { idFactory?: () => string; now?: () => number } = {}) {
  const eventLog = new InMemoryEventLog();
  let tick = 0;
  let id = 0;
  const broker = new Broker({
    eventLog,
    now: overrides.now ?? (() => ++tick),
    idFactory: overrides.idFactory ?? (() => `msg-${++id}`),
  });
  return { broker, eventLog };
}

describe('Broker.register', () => {
  it('creates a new agent on first register', async () => {
    const { broker } = makeBroker();
    const reg = await broker.register('agent-1');
    expect(reg.agentId).toBe('agent-1');
    expect(reg.registeredAt).toBe(1);
    expect(broker.listAgents()).toHaveLength(1);
  });

  it('is idempotent for repeated registers (preserves createdAt)', async () => {
    const { broker } = makeBroker();
    const first = await broker.register('agent-1');
    const second = await broker.register('agent-1');
    expect(first.registeredAt).toBe(second.registeredAt);
    expect(broker.listAgents()).toHaveLength(1);
  });
});

describe('Broker.push targeted', () => {
  it('delivers to every subscriber of the target agent and writes event log', async () => {
    const { broker, eventLog } = makeBroker();
    await broker.register('agent-1');
    const received: Message[] = [];
    broker.subscribe('agent-1', (msg) => {
      received.push(msg);
    });

    const result = await broker.push({ agentId: 'agent-1', body: 'hello' });

    expect(result.delivery.sse).toBe(1);
    expect(result.delivery.targets).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('hello');
    expect(received[0]?.agentId).toBe('agent-1');
    expect(await eventLog.tail()).toHaveLength(1);
  });

  it('returns targets: 0 when the target agent is unknown', async () => {
    const { broker } = makeBroker();
    const result = await broker.push({ agentId: 'ghost', body: 'hi' });
    expect(result.delivery.sse).toBe(0);
    expect(result.delivery.targets).toBe(0);
  });

  it('fans out to multiple subscribers of the same agent', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    const a: Message[] = [];
    const b: Message[] = [];
    broker.subscribe('agent-1', (m) => {
      a.push(m);
    });
    broker.subscribe('agent-1', (m) => {
      b.push(m);
    });

    const result = await broker.push({ agentId: 'agent-1', body: 'hi' });
    expect(result.delivery.sse).toBe(2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('isolates a throwing subscriber from other subscribers on the same agent', async () => {
    const warn = vi.fn();
    const eventLog = new InMemoryEventLog();
    const broker = new Broker({
      eventLog,
      now: () => 1,
      idFactory: () => 'msg-1',
      logger: { warn, error: () => {} },
    });
    await broker.register('agent-1');
    const good: Message[] = [];
    broker.subscribe('agent-1', () => {
      throw new Error('boom');
    });
    broker.subscribe('agent-1', (m) => {
      good.push(m);
    });

    const result = await broker.push({ agentId: 'agent-1', body: 'hi' });
    expect(good).toHaveLength(1);
    expect(result.delivery.sse).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('Broker.push broadcast', () => {
  it('delivers to every registered agent when agentId is omitted', async () => {
    const { broker } = makeBroker();
    await broker.register('a1');
    await broker.register('a2');
    const r1: Message[] = [];
    const r2: Message[] = [];
    broker.subscribe('a1', (m) => {
      r1.push(m);
    });
    broker.subscribe('a2', (m) => {
      r2.push(m);
    });

    const result = await broker.push({ body: 'broadcast' });
    expect(result.delivery.targets).toBe(2);
    expect(result.delivery.sse).toBe(2);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it('broadcast to empty registry reports zeros', async () => {
    const { broker } = makeBroker();
    const result = await broker.push({ body: 'hello void' });
    expect(result.delivery.targets).toBe(0);
    expect(result.delivery.sse).toBe(0);
  });
});

describe('Broker.subscribe', () => {
  it('auto-registers the agent if not previously known', async () => {
    const { broker } = makeBroker();
    broker.subscribe('autoreg', () => {});
    expect(broker.hasAgent('autoreg')).toBe(true);
  });

  it('unsubscribe stops further deliveries', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    const received: Message[] = [];
    const unsub = broker.subscribe('agent-1', (m) => {
      received.push(m);
    });
    await broker.push({ agentId: 'agent-1', body: 'first' });
    unsub();
    await broker.push({ agentId: 'agent-1', body: 'second' });
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('first');
  });

  it('listAgents reports the live subscriber count in `connected`', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    expect(broker.listAgents()[0]?.connected).toBe(0);
    const unsub = broker.subscribe('agent-1', () => {});
    expect(broker.listAgents()[0]?.connected).toBe(1);
    unsub();
    expect(broker.listAgents()[0]?.connected).toBe(0);
  });
});

describe('InMemoryEventLog', () => {
  it('append + tail round-trip', async () => {
    const log = new InMemoryEventLog();
    const m1: Message = {
      id: 'a',
      ts: 1,
      agentId: 'x',
      title: null,
      body: 'a',
      level: 'info',
      data: {},
    };
    const m2: Message = { ...m1, id: 'b', ts: 2, body: 'b' };
    await log.append(m1);
    await log.append(m2);
    const out = await log.tail();
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe('a');
    expect(out[1]?.id).toBe('b');
  });

  it('tail honours since and limit', async () => {
    const log = new InMemoryEventLog();
    for (let i = 0; i < 5; i++) {
      await log.append({
        id: `m${i}`,
        ts: i,
        agentId: null,
        title: null,
        body: `msg ${i}`,
        level: 'info',
        data: {},
      });
    }
    const sinceOut = await log.tail({ since: 3 });
    expect(sinceOut.map((m) => m.id)).toEqual(['m3', 'm4']);

    const limitOut = await log.tail({ limit: 2 });
    expect(limitOut.map((m) => m.id)).toEqual(['m3', 'm4']);
  });
});
