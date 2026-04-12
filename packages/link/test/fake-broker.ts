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
  registrations: string[];
  subscribers: SseSubscriber[];
  waitForSubscriber: (agentId: string, timeoutMs?: number) => Promise<SseSubscriber>;
  close: () => Promise<void>;
}

const TOKEN = 'fake-broker-token';
// Principal the fake broker claims to recognise. The link calls
// /whoami at startup to self-derive its agentId; this is what it
// gets back, and what it will then register + subscribe under.
export const FAKE_BROKER_PRINCIPAL = 'link-test-agent';

export async function startFakeBroker(): Promise<FakeBroker> {
  const pushes: FakeBrokerPush[] = [];
  const registrations: string[] = [];
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

    if (url.pathname === '/whoami' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ name: FAKE_BROKER_PRINCIPAL, kind: 'agent' }));
      return;
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as { agentId: string };
      registrations.push(parsed.agentId);
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          agentId: parsed.agentId,
          registeredAt: Date.now(),
        }),
      );
      return;
    }

    if (url.pathname === '/agents' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          agents: [
            {
              agentId: 'peer-1',
              connected: 1,
              createdAt: 1_700_000_000_000,
              lastSeen: 1_700_000_000_000,
              kind: 'agent',
            },
          ],
        }),
      );
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
            from: FAKE_BROKER_PRINCIPAL,
            title: parsed.title ?? null,
            body: parsed.body,
            level: parsed.level ?? 'info',
            data: parsed.data ?? {},
          },
        }),
      );
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
    registrations,
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
