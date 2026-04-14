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
export const FAKE_BROKER_TEAM_NAME = 'fake-squadron';
export const FAKE_BROKER_MISSION = 'Exercise the link in isolation.';

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
          team: {
            name: FAKE_BROKER_TEAM_NAME,
            mission: FAKE_BROKER_MISSION,
            brief: '',
          },
          teammates: [
            { callsign: FAKE_BROKER_CALLSIGN, role: 'implementer' },
            { callsign: 'peer-1', role: 'reviewer' },
          ],
          instructions:
            `You've connected to the control17 net. On this team you go by ${FAKE_BROKER_CALLSIGN}.\n` +
            `Team: ${FAKE_BROKER_TEAM_NAME}\n` +
            `Mission: ${FAKE_BROKER_MISSION}`,
          canEdit: false,
        }),
      );
      return;
    }

    if (url.pathname === '/roster' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          teammates: [
            { callsign: FAKE_BROKER_CALLSIGN, role: 'implementer' },
            { callsign: 'peer-1', role: 'reviewer' },
          ],
          connected: [
            {
              agentId: 'peer-1',
              connected: 1,
              createdAt: 1_700_000_000_000,
              lastSeen: 1_700_000_000_000,
              role: 'reviewer',
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
