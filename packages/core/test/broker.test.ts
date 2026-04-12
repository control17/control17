import type { Message } from '@control17/sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { AgentIdentityError, Broker, InMemoryEventLog } from '../src/index.js';

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

  it('records principal kind from the register context', async () => {
    const { broker } = makeBroker();
    await broker.register('build-bot', { kind: 'agent' });
    const agents = broker.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.kind).toBe('agent');
  });

  it('defaults kind to null when no context is supplied', async () => {
    const { broker } = makeBroker();
    await broker.register('nameless');
    expect(broker.listAgents()[0]?.kind).toBeNull();
  });

  it('allows the matching principal to register idempotently', async () => {
    const { broker } = makeBroker();
    await broker.register('alice', { kind: 'human', principal: 'alice' });
    await broker.register('alice', { kind: 'human', principal: 'alice' });
    expect(broker.listAgents()).toHaveLength(1);
  });

  it('rejects register when agentId does not equal principal', async () => {
    const { broker } = makeBroker();
    await expect(
      broker.register('alice', { kind: 'human', principal: 'mallory' }),
    ).rejects.toBeInstanceOf(AgentIdentityError);
  });

  it('skips the identity check when no principal is supplied', async () => {
    const { broker } = makeBroker();
    await expect(broker.register('whoever')).resolves.toBeDefined();
  });
});

describe('Broker.subscribe identity', () => {
  it('rejects subscribe when agentId does not equal principal', async () => {
    const { broker } = makeBroker();
    expect(() => broker.subscribe('alice', () => {}, { principal: 'mallory' })).toThrow(
      AgentIdentityError,
    );
  });

  it('allows the matching principal to subscribe', async () => {
    const { broker } = makeBroker();
    const received: Message[] = [];
    broker.subscribe(
      'alice',
      (m) => {
        received.push(m);
      },
      { principal: 'alice' },
    );
    await broker.push({ agentId: 'alice', body: 'hi' }, { from: 'bob' });
    expect(received).toHaveLength(1);
  });
});

describe('Broker.push DM sender-fanout', () => {
  it("delivers a DM to the sender's own agent when both are registered", async () => {
    const { broker } = makeBroker();
    await broker.register('alice', { kind: 'human', principal: 'alice' });
    await broker.register('build-bot', { kind: 'agent', principal: 'build-bot' });

    const aliceReceived: Message[] = [];
    const botReceived: Message[] = [];
    broker.subscribe(
      'alice',
      (m) => {
        aliceReceived.push(m);
      },
      { principal: 'alice' },
    );
    broker.subscribe(
      'build-bot',
      (m) => {
        botReceived.push(m);
      },
      { principal: 'build-bot' },
    );

    const result = await broker.push({ agentId: 'build-bot', body: 'status?' }, { from: 'alice' });

    // Primary target is still build-bot; alice's copy is sender-fanout
    // for multi-device consistency.
    expect(result.delivery.targets).toBe(1);
    expect(result.delivery.sse).toBe(2);
    expect(botReceived).toHaveLength(1);
    expect(aliceReceived).toHaveLength(1);
    expect(aliceReceived[0]?.agentId).toBe('build-bot');
    expect(aliceReceived[0]?.from).toBe('alice');
  });

  it('does not double-deliver when the sender talks to themselves', async () => {
    const { broker } = makeBroker();
    await broker.register('alice', { kind: 'human', principal: 'alice' });
    const received: Message[] = [];
    broker.subscribe(
      'alice',
      (m) => {
        received.push(m);
      },
      { principal: 'alice' },
    );

    const result = await broker.push({ agentId: 'alice', body: 'note-to-self' }, { from: 'alice' });

    expect(result.delivery.targets).toBe(1);
    expect(result.delivery.sse).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('is a no-op when the sender has no registered agent', async () => {
    const { broker } = makeBroker();
    await broker.register('build-bot', { kind: 'agent', principal: 'build-bot' });
    const received: Message[] = [];
    broker.subscribe(
      'build-bot',
      (m) => {
        received.push(m);
      },
      { principal: 'build-bot' },
    );

    const result = await broker.push({ agentId: 'build-bot', body: 'hello' }, { from: 'alice' });
    expect(result.delivery.targets).toBe(1);
    expect(result.delivery.sse).toBe(1);
    expect(received).toHaveLength(1);
  });
});

describe('Broker.push stamping', () => {
  it('stamps `from` from the push context, never from the payload', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');

    // The payload has no way to supply `from` at the type level, but
    // even if a runtime adapter accidentally passed one in via `data`,
    // the broker must ignore it — only the context value wins.
    const result = await broker.push(
      { agentId: 'agent-1', body: 'hi', data: { from: 'spoofed' } },
      { from: 'alice' },
    );

    expect(result.message.from).toBe('alice');
    expect(result.message.data).toEqual({ from: 'spoofed' }); // data passed through untouched
  });

  it('stamps `from: null` when no context is supplied', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    const result = await broker.push({ agentId: 'agent-1', body: 'hi' });
    expect(result.message.from).toBeNull();
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

describe('InMemoryEventLog.query', () => {
  function msg(overrides: Partial<Message> & { id: string; ts: number }): Message {
    return {
      agentId: null,
      from: null,
      title: null,
      body: 'msg',
      level: 'info',
      data: {},
      ...overrides,
    };
  }

  it('returns broadcasts + DMs involving the viewer', async () => {
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'bcast', ts: 1 }));
    await log.append(msg({ id: 'dm-to-alice', ts: 2, agentId: 'alice', from: 'bob' }));
    await log.append(msg({ id: 'dm-from-alice', ts: 3, agentId: 'bob', from: 'alice' }));
    await log.append(msg({ id: 'other-dm', ts: 4, agentId: 'carol', from: 'bob' }));

    const result = await log.query({ viewer: 'alice' });
    const ids = result.map((m) => m.id);
    expect(ids).toContain('bcast');
    expect(ids).toContain('dm-to-alice');
    expect(ids).toContain('dm-from-alice');
    expect(ids).not.toContain('other-dm');
  });

  it('narrows to DMs with a specific other when `with` is set', async () => {
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'bcast', ts: 1 }));
    await log.append(msg({ id: 'dm-alice-bob', ts: 2, agentId: 'bob', from: 'alice' }));
    await log.append(msg({ id: 'dm-bob-alice', ts: 3, agentId: 'alice', from: 'bob' }));
    await log.append(msg({ id: 'dm-alice-carol', ts: 4, agentId: 'carol', from: 'alice' }));

    const result = await log.query({ viewer: 'alice', with: 'bob' });
    const ids = result.map((m) => m.id);
    expect(ids).toEqual(['dm-bob-alice', 'dm-alice-bob']);
    expect(ids).not.toContain('bcast');
    expect(ids).not.toContain('dm-alice-carol');
  });

  it('respects limit and before for pagination', async () => {
    const log = new InMemoryEventLog();
    for (let i = 1; i <= 10; i++) {
      await log.append(msg({ id: `m${i}`, ts: i }));
    }
    const page1 = await log.query({ viewer: 'alice', limit: 3 });
    expect(page1.map((m) => m.id)).toEqual(['m10', 'm9', 'm8']);

    const page2 = await log.query({ viewer: 'alice', limit: 3, before: 8 });
    expect(page2.map((m) => m.id)).toEqual(['m7', 'm6', 'm5']);
  });
});

describe('InMemoryEventLog', () => {
  it('append + tail round-trip', async () => {
    const log = new InMemoryEventLog();
    const m1: Message = {
      id: 'a',
      ts: 1,
      agentId: 'x',
      from: null,
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
        from: null,
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
