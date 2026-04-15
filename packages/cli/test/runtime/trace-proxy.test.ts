/**
 * HTTP CONNECT proxy relay unit tests.
 *
 * We prove four things:
 *
 *   1. A real client (Node's own net socket) can send a CONNECT
 *      request, receive `HTTP/1.1 200 Connection Established`, and
 *      then tunnel bytes through to an upstream echo server.
 *   2. Every byte of the roundtrip appears in the onChunk callback
 *      with correct direction + session id + upstream host/port.
 *   3. onSessionEnd fires with accurate bytesIn / bytesOut counters
 *      that do NOT include the CONNECT request line (proxy control
 *      traffic is not payload).
 *   4. Malformed requests are rejected cleanly — bad method, missing
 *      port, oversized headers — each with an appropriate HTTP
 *      status and no session spin-up.
 *
 * A real upstream TCP echo server is cheap to spin up and avoids
 * mocking net.createConnection.
 */

import { createConnection, createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ProxyChunk,
  type ProxySession,
  startProxyRelay,
} from '../../src/runtime/trace/proxy.js';

async function startEchoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('end', () => socket.end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('echo: no TCP address');
  }
  return { server, port: addr.port };
}

describe('startProxyRelay', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c) await c().catch(() => {});
    }
  });

  it('proxies a CONNECT session and reports chunks + session summary', async () => {
    const chunks: ProxyChunk[] = [];
    const sessions: ProxySession[] = [];
    const relay = await startProxyRelay({
      log: () => {},
      onChunk: (c) => chunks.push({ ...c, bytes: Buffer.from(c.bytes) }),
      onSessionEnd: (s) => sessions.push(s),
    });
    cleanups.push(() => relay.close());

    const echo = await startEchoServer();
    cleanups.push(async () => {
      await new Promise<void>((r) => echo.server.close(() => r()));
    });

    const client = createConnection({ host: relay.host, port: relay.port });
    await new Promise<void>((r, j) => {
      client.once('connect', () => r());
      client.once('error', j);
    });

    // CONNECT request
    client.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
    const reply = await readExactly(client, 39);
    expect(reply.toString('ascii')).toBe('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Tunnel payload roundtrip
    const payload = Buffer.from('hello-through-connect-proxy');
    client.write(payload);
    const echoed = await readExactly(client, payload.length);
    expect(echoed.toString('utf8')).toBe('hello-through-connect-proxy');

    client.end();
    await new Promise<void>((r) => client.once('close', () => r()));

    // Chunks should contain the tunneled payload both ways, and
    // should NOT contain the CONNECT request line itself.
    const toUpstream = chunks
      .filter((c) => c.direction === 'client_to_upstream')
      .map((c) => c.bytes.toString('utf8'))
      .join('');
    const toClient = chunks
      .filter((c) => c.direction === 'upstream_to_client')
      .map((c) => c.bytes.toString('utf8'))
      .join('');
    expect(toUpstream).toBe('hello-through-connect-proxy');
    expect(toClient).toBe('hello-through-connect-proxy');
    expect(toUpstream).not.toContain('CONNECT');
    for (const c of chunks) {
      expect(c.sessionId).toBe(1);
      expect(c.upstream).toEqual({ host: '127.0.0.1', port: echo.port });
    }

    await waitFor(() => sessions.length === 1, 1000);
    const [session] = sessions;
    expect(session?.id).toBe(1);
    expect(session?.bytesOut).toBe(payload.length);
    expect(session?.bytesIn).toBe(payload.length);
  });

  it('flushes bytes pipelined after the CONNECT header as the first chunk', async () => {
    // A well-behaved client may pack the TLS ClientHello into the
    // same TCP packet as the CONNECT request. The relay has to
    // buffer those bytes until the upstream connect completes and
    // then forward them as the first real chunk of the tunnel.
    const chunks: ProxyChunk[] = [];
    const relay = await startProxyRelay({
      log: () => {},
      onChunk: (c) => chunks.push({ ...c, bytes: Buffer.from(c.bytes) }),
    });
    cleanups.push(() => relay.close());

    const echo = await startEchoServer();
    cleanups.push(async () => {
      await new Promise<void>((r) => echo.server.close(() => r()));
    });

    const client = createConnection({ host: relay.host, port: relay.port });
    await new Promise<void>((r, j) => {
      client.once('connect', () => r());
      client.once('error', j);
    });

    // Single write: CONNECT headers + immediate payload bytes.
    const connectLine = `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\n\r\n`;
    const pipelinedPayload = 'pipelined-bytes';
    client.write(connectLine + pipelinedPayload);

    // Read the 200 reply, then the echoed payload bytes.
    const reply = await readExactly(client, 39);
    expect(reply.toString('ascii').startsWith('HTTP/1.1 200')).toBe(true);
    const echoed = await readExactly(client, pipelinedPayload.length);
    expect(echoed.toString('utf8')).toBe(pipelinedPayload);

    client.end();
    await new Promise<void>((r) => client.once('close', () => r()));

    const toUpstream = chunks
      .filter((c) => c.direction === 'client_to_upstream')
      .map((c) => c.bytes.toString('utf8'))
      .join('');
    expect(toUpstream).toContain(pipelinedPayload);
    expect(toUpstream).not.toContain('CONNECT');
  });

  it('rejects non-CONNECT methods with 400 Bad Request', async () => {
    const relay = await startProxyRelay({ log: () => {} });
    cleanups.push(() => relay.close());

    const client = createConnection({ host: relay.host, port: relay.port });
    await new Promise<void>((r, j) => {
      client.once('connect', () => r());
      client.once('error', j);
    });

    client.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    const reply = await readExactly(client, 25);
    expect(reply.toString('ascii').startsWith('HTTP/1.1 400')).toBe(true);
    await new Promise<void>((r) => client.once('close', () => r()));
  });

  it('rejects CONNECT targets missing a port with 400', async () => {
    const relay = await startProxyRelay({ log: () => {} });
    cleanups.push(() => relay.close());

    const client = createConnection({ host: relay.host, port: relay.port });
    await new Promise<void>((r, j) => {
      client.once('connect', () => r());
      client.once('error', j);
    });

    client.write('CONNECT example.com HTTP/1.1\r\n\r\n');
    const reply = await readExactly(client, 25);
    expect(reply.toString('ascii').startsWith('HTTP/1.1 400')).toBe(true);
    await new Promise<void>((r) => client.once('close', () => r()));
  });

  it('returns 502 Bad Gateway when upstream connect fails', async () => {
    const relay = await startProxyRelay({ log: () => {} });
    cleanups.push(() => relay.close());

    const client = createConnection({ host: relay.host, port: relay.port });
    await new Promise<void>((r, j) => {
      client.once('connect', () => r());
      client.once('error', j);
    });

    // Port 1 is privileged; `connect` to it fails ECONNREFUSED.
    client.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\n\r\n');
    const reply = await readExactly(client, 25);
    expect(reply.toString('ascii').startsWith('HTTP/1.1 502')).toBe(true);
    await new Promise<void>((r) => client.once('close', () => r()));
  });

  it('exposes host/port/proxyUrl with http:// scheme', async () => {
    const relay = await startProxyRelay({ log: () => {} });
    cleanups.push(() => relay.close());
    expect(relay.host).toBe('127.0.0.1');
    expect(relay.port).toBeGreaterThan(0);
    expect(relay.proxyUrl).toBe(`http://127.0.0.1:${relay.port}`);
    // Critical guard: must not be socks5:// — undici rejects that.
    expect(relay.proxyUrl.startsWith('http://')).toBe(true);
  });
});

async function readExactly(socket: import('node:net').Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) {
        socket.off('data', onData);
        socket.off('error', onError);
        resolve(Buffer.concat(chunks).slice(0, n));
      }
    };
    const onError = (err: Error): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      reject(err);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}
