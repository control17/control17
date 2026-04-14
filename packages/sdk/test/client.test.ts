import { describe, expect, it } from 'vitest';
import { Client, ClientError } from '../src/client.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../src/protocol.js';
import type { Message, PushResult } from '../src/types.js';

function makeFakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('Client', () => {
  it('sends protocol header and bearer token on authenticated calls', async () => {
    let captured: { url: URL; headers: Headers } | null = null;
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'test-secret',
      fetch: makeFakeFetch((url, init) => {
        captured = { url, headers: new Headers(init.headers) };
        return jsonResponse({ teammates: [], connected: [] });
      }),
    });

    await client.roster();

    expect(captured).not.toBeNull();
    const { url, headers } = captured as unknown as { url: URL; headers: Headers };
    expect(url.pathname).toBe('/roster');
    expect(headers.get(PROTOCOL_HEADER)).toBe(String(PROTOCOL_VERSION));
    expect(headers.get('Authorization')).toBe('Bearer test-secret');
  });

  it('omits auth header on /healthz', async () => {
    let captured: Headers | null = null;
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'test-secret',
      fetch: makeFakeFetch((_url, init) => {
        captured = new Headers(init.headers);
        return jsonResponse({ status: 'ok', version: '0.0.0' });
      }),
    });
    await client.health();
    expect(captured).not.toBeNull();
    expect((captured as unknown as Headers).get('Authorization')).toBeNull();
  });

  it('parses and validates a push result', async () => {
    const fakeMessage: Message = {
      id: 'msg-1',
      ts: 1_700_000_000_000,
      agentId: 'agent-1',
      from: 'operator',
      title: 'hi',
      body: 'hello world',
      level: 'info',
      data: {},
    };
    const payload: PushResult = {
      delivery: { sse: 1, targets: 1 },
      message: fakeMessage,
    };
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'x',
      fetch: makeFakeFetch(() => jsonResponse(payload)),
    });
    const result = await client.push({ agentId: 'agent-1', body: 'hello world' });
    expect(result.message.body).toBe('hello world');
    expect(result.delivery.sse).toBe(1);
  });

  it('throws ClientError on non-2xx with the response body', async () => {
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'x',
      fetch: makeFakeFetch(
        () =>
          new Response('unauthorized', {
            status: 401,
            statusText: 'Unauthorized',
          }),
      ),
    });
    await expect(client.roster()).rejects.toBeInstanceOf(ClientError);
    try {
      await client.roster();
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      const e = err as ClientError;
      expect(e.status).toBe(401);
      expect(e.body).toContain('unauthorized');
    }
  });

  it('subscribe yields parsed messages from SSE frames', async () => {
    const fakeMessage: Message = {
      id: 'msg-1',
      ts: 1_700_000_000_000,
      agentId: 'agent-1',
      from: null,
      title: null,
      body: 'hi',
      level: 'info',
      data: {},
    };
    const fakeMessage2: Message = { ...fakeMessage, id: 'msg-2', body: 'second' };
    const sse =
      `data: ${JSON.stringify(fakeMessage)}\n\n` + `data: ${JSON.stringify(fakeMessage2)}\n\n`;

    const client = new Client({
      url: 'http://example.test:8717',
      token: 'x',
      fetch: makeFakeFetch(
        () =>
          new Response(sse, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    });

    const received: Message[] = [];
    for await (const msg of client.subscribe('agent-1')) {
      received.push(msg);
    }
    expect(received).toHaveLength(2);
    expect(received[0]?.id).toBe('msg-1');
    expect(received[1]?.body).toBe('second');
  });

  it('subscribe handles frames split across chunks', async () => {
    const fakeMessage: Message = {
      id: 'msg-split',
      ts: 1_700_000_000_000,
      agentId: 'agent-1',
      from: null,
      title: null,
      body: 'split across chunks',
      level: 'info',
      data: {},
    };
    const json = JSON.stringify(fakeMessage);
    // Split the frame mid-payload to exercise the buffering path.
    const mid = Math.floor(json.length / 2);
    const chunk1 = `data: ${json.slice(0, mid)}`;
    const chunk2 = `${json.slice(mid)}\n\n`;

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(chunk1));
        controller.enqueue(enc.encode(chunk2));
        controller.close();
      },
    });

    const client = new Client({
      url: 'http://example.test:8717',
      token: 'x',
      fetch: makeFakeFetch(() => new Response(stream, { status: 200 })),
    });
    const received: Message[] = [];
    for await (const msg of client.subscribe('agent-1')) {
      received.push(msg);
    }
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('split across chunks');
  });
});
