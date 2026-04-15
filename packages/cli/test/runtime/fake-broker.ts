/**
 * Minimal HTTP broker used by the link integration tests.
 *
 * Speaks just enough of the control17 wire protocol to exercise the
 * link's HTTP + SSE paths without pulling in @control17/core or the
 * real server. Pushes are captured in an array; incoming subscribers
 * are exposed so tests can inject messages on demand.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeBrokerPush {
  agentId?: string | null;
  title?: string | null;
  body: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface SseSubscriber {
  agentId: string;
  write: (json: Record<string, unknown>) => void;
  close: () => void;
}

export interface FakeBroker {
  port: number;
  url: string;
  pushes: FakeBrokerPush[];
  subscribers: SseSubscriber[];
  waitForSubscriber: (agentId: string, timeoutMs?: number) => Promise<SseSubscriber>;
  close: () => Promise<void>;
}

const TOKEN = 'fake-broker-token';
// Callsign the fake broker returns from /briefing. The link calls
// /briefing at startup to self-derive its callsign; this is what it
// gets back, and what it will then subscribe under.
export const FAKE_BROKER_CALLSIGN = 'link-test-agent';
export const FAKE_BROKER_SQUADRON_NAME = 'fake-squadron';
export const FAKE_BROKER_MISSION = 'Exercise the link in isolation.';

/**
 * Objectives the fake broker will return from /briefing + /objectives.
 * Tests can push onto or read from this to verify the link's sticky
 * tool-description refresh path.
 */
export const fakeBrokerObjectives: Array<Record<string, unknown>> = [];

export async function startFakeBroker(): Promise<FakeBroker> {
  const pushes: FakeBrokerPush[] = [];
  const subscribers: SseSubscriber[] = [];

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const jsonHeaders = { 'Content-Type': 'application/json' };

    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, jsonHeaders);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (url.pathname === '/briefing' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          callsign: FAKE_BROKER_CALLSIGN,
          role: 'implementer',
          // Commander authority so the link test exercises the full
          // authority-gated tool surface (objectives_create /
          // _cancel / _reassign / _watchers). Operator-authority
          // behavior is tested at the unit level via defineTools.
          authority: 'commander',
          squadron: {
            name: FAKE_BROKER_SQUADRON_NAME,
            mission: FAKE_BROKER_MISSION,
            brief: '',
          },
          teammates: [
            { callsign: FAKE_BROKER_CALLSIGN, role: 'implementer', authority: 'operator' },
            { callsign: 'peer-1', role: 'reviewer', authority: 'operator' },
          ],
          openObjectives: fakeBrokerObjectives,
          instructions:
            `You've connected to the control17 net. In this squadron you go by ${FAKE_BROKER_CALLSIGN}.\n` +
            `Squadron: ${FAKE_BROKER_SQUADRON_NAME}\n` +
            `Mission: ${FAKE_BROKER_MISSION}`,
        }),
      );
      return;
    }

    if (url.pathname === '/roster' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          teammates: [
            { callsign: FAKE_BROKER_CALLSIGN, role: 'implementer', authority: 'operator' },
            { callsign: 'peer-1', role: 'reviewer', authority: 'operator' },
          ],
          connected: [
            {
              agentId: 'peer-1',
              connected: 1,
              createdAt: 1_700_000_000_000,
              lastSeen: 1_700_000_000_000,
              role: 'reviewer',
              authority: 'operator',
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname === '/objectives' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ objectives: fakeBrokerObjectives }));
      return;
    }

    if (url.pathname.startsWith('/objectives/') && req.method === 'GET') {
      const id = url.pathname.slice('/objectives/'.length);
      const objective = fakeBrokerObjectives.find((o) => o.id === id);
      if (!objective) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: `no such objective: ${id}` }));
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ objective, events: [] }));
      return;
    }

    if (url.pathname === '/push' && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as FakeBrokerPush;
      pushes.push(parsed);
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          delivery: { sse: 1, targets: 1 },
          message: {
            id: `fake-${pushes.length}`,
            ts: Date.now(),
            agentId: parsed.agentId ?? null,
            from: FAKE_BROKER_CALLSIGN,
            title: parsed.title ?? null,
            body: parsed.body,
            level: parsed.level ?? 'info',
            data: parsed.data ?? {},
          },
        }),
      );
      return;
    }

    if (url.pathname === '/history' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ messages: [] }));
      return;
    }

    if (url.pathname === '/subscribe' && req.method === 'GET') {
      const agentId = url.searchParams.get('agentId') ?? '';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Initial flush so the link's SSE parser has something to work with.
      res.write(': connected\n\n');
      const sub: SseSubscriber = {
        agentId,
        write: (json) => {
          res.write(`data: ${JSON.stringify(json)}\n\n`);
        },
        close: () => res.end(),
      };
      subscribers.push(sub);
      req.on('close', () => {
        const idx = subscribers.indexOf(sub);
        if (idx >= 0) subscribers.splice(idx, 1);
      });
      return;
    }

    res.writeHead(404, jsonHeaders);
    res.end(JSON.stringify({ error: 'not found' }));
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address() as AddressInfo;

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    pushes,
    subscribers,
    waitForSubscriber: async (agentId, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const sub = subscribers.find((s) => s.agentId === agentId);
        if (sub) return sub;
        await sleep(20);
      }
      throw new Error(`timeout waiting for subscriber ${agentId}`);
    },
    close: () =>
      new Promise((resolve) => {
        for (const sub of subscribers) sub.close();
        httpServer.close(() => resolve());
      }),
  };
}

export const FAKE_BROKER_TOKEN = TOKEN;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
