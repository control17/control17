/**
 * HTTP CONNECT proxy tests — full MITM flow + raw TCP fallback.
 *
 * MITM path: we spin up a real loopback TLS server (pretending to
 * be an upstream API), configure the proxy with a CertPool, run
 * a real HTTPS client through the proxy while trusting our local
 * CA, and assert:
 *   - the HTTPS handshake completes on both legs
 *   - the round-trip succeeds at the application layer
 *   - captured chunks are **plaintext** HTTP (human-readable)
 *   - `onSessionEnd` fires with `mitm: true` and accurate byte
 *     counters
 *
 * Raw TCP path: no CertPool, CONNECT to a plain echo server. We
 * assert the tunnel works and `onSessionEnd` reports `mitm: false`.
 *
 * Malformed input: first-line parser rejects non-CONNECT verbs
 * with 400 Bad Request.
 */

import { createServer as createTcpServer, type Server, connect as tcpConnect } from 'node:net';
import {
  createServer as createTlsServer,
  type Server as TlsServer,
  connect as tlsConnect,
} from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { createCertPool, createTraceCa } from '../../src/runtime/trace/mitm/ca.js';
import {
  type ProxyChunk,
  type ProxySession,
  startProxyRelay,
} from '../../src/runtime/trace/proxy.js';

async function generateUpstreamCert(): Promise<{ cert: string; key: string }> {
  const { generate } = await import('selfsigned');
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: now,
    notAfterDate: tomorrow,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
    ],
  });
  return { cert: pems.cert, key: pems.private };
}

async function startHttpsEchoServer(): Promise<{
  server: TlsServer;
  port: number;
  cert: string;
}> {
  const { cert, key } = await generateUpstreamCert();
  const server = createTlsServer({ cert, key, minVersion: 'TLSv1.2' }, (socket) => {
    const parts: Buffer[] = [];
    socket.on('data', (data) => {
      parts.push(data);
      const buf = Buffer.concat(parts);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      // Simple HTTP/1.1 reply.
      const body = '{"upstream":"real","received":true}';
      socket.write(
        Buffer.from(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        ),
      );
      socket.end();
    });
    socket.on('error', () => {
      /* ignore */
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no upstream port');
  return { server, port: addr.port, cert };
}

describe('proxy MITM path', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c) await c().catch(() => {});
    }
  });

  it('terminates TLS on both legs and captures plaintext HTTP bytes', async () => {
    const upstream = await startHttpsEchoServer();
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));

    const chunks: ProxyChunk[] = [];
    const sessions: ProxySession[] = [];
    const ca = createTraceCa();
    const certPool = createCertPool(ca);
    const proxy = await startProxyRelay({
      log: () => {},
      certPool,
      // Test upstream uses a self-signed cert; accept it. In
      // production this stays at default (validate against system
      // CA store).
      upstreamTlsOptions: { rejectUnauthorized: false },
      onChunk: (c) => chunks.push({ ...c, bytes: Buffer.from(c.bytes) }),
      onSessionEnd: (s) => sessions.push(s),
    });
    cleanups.push(() => proxy.close());

    // Step 1: open a raw TCP connection to the proxy and speak CONNECT.
    const tcp = tcpConnect({ host: proxy.host, port: proxy.port });
    await new Promise<void>((resolve, reject) => {
      tcp.once('connect', () => resolve());
      tcp.once('error', reject);
    });

    tcp.write(
      `CONNECT localhost:${upstream.port} HTTP/1.1\r\nHost: localhost:${upstream.port}\r\n\r\n`,
    );
    // Read the proxy's "200 Connection Established" reply.
    await new Promise<void>((resolve, reject) => {
      let buf = '';
      const onData = (d: Buffer): void => {
        buf += d.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          tcp.off('data', onData);
          if (!buf.startsWith('HTTP/1.1 200')) {
            reject(new Error(`proxy replied: ${buf.split('\r\n')[0]}`));
          } else {
            resolve();
          }
        }
      };
      tcp.on('data', onData);
      tcp.once('error', reject);
    });

    // Step 2: wrap the now-plaintext TCP socket in TLS, trusting
    // our local CA. servername='localhost' so the MITM leaf cert
    // (which is for 'localhost') matches. This mirrors how undici
    // behaves under HTTPS_PROXY with NODE_EXTRA_CA_CERTS.
    const client = tlsConnect({
      socket: tcp,
      servername: 'localhost',
      ca: [ca.caCertPem],
      minVersion: 'TLSv1.2',
    });
    await new Promise<void>((resolve, reject) => {
      client.once('secureConnect', () => resolve());
      client.once('error', reject);
    });

    // Step 3: send an HTTP request through the double-encrypted
    // pipe and read the response.
    const request =
      'POST /v1/messages HTTP/1.1\r\n' +
      `Host: localhost\r\n` +
      'Content-Type: application/json\r\n' +
      'Content-Length: 18\r\n' +
      '\r\n' +
      '{"model":"claude"}';
    client.write(request);

    const response = await new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = [];
      client.on('data', (d) => parts.push(d));
      client.on('end', () => resolve(Buffer.concat(parts)));
      client.on('error', reject);
    });

    expect(response.toString('utf8')).toContain('HTTP/1.1 200');
    expect(response.toString('utf8')).toContain('"upstream":"real"');

    // Wait a tick for session end to propagate.
    await new Promise((r) => setTimeout(r, 50));

    // ── Assertions on captured chunks ─────────────────────────────
    // All chunks should be plaintext (HTTP wire format), not TLS
    // ciphertext. We check by looking for the HTTP method token
    // in the client→upstream direction and the status line in
    // the upstream→client direction.
    const clientText = Buffer.concat(
      chunks.filter((c) => c.direction === 'client_to_upstream').map((c) => c.bytes),
    ).toString('utf8');
    const serverText = Buffer.concat(
      chunks.filter((c) => c.direction === 'upstream_to_client').map((c) => c.bytes),
    ).toString('utf8');

    expect(clientText).toContain('POST /v1/messages');
    expect(clientText).toContain('{"model":"claude"}');
    expect(serverText).toContain('HTTP/1.1 200 OK');
    expect(serverText).toContain('"upstream":"real"');

    // Session summary should reflect MITM and accurate byte counts.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.mitm).toBe(true);
    expect(sessions[0]?.upstream.host).toBe('localhost');
    expect(sessions[0]?.upstream.port).toBe(upstream.port);
    expect(sessions[0]?.bytesOut).toBeGreaterThan(0);
    expect(sessions[0]?.bytesIn).toBeGreaterThan(0);
  }, 15_000);
});

describe('proxy raw TCP fallback path', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c) await c().catch(() => {});
    }
  });

  async function startEchoServer(): Promise<{ server: Server; port: number }> {
    const server = createTcpServer((socket) => {
      socket.on('data', (data) => socket.write(data));
      socket.on('end', () => socket.end());
    });
    await new Promise<void>((r, j) => {
      server.once('listening', () => r());
      server.once('error', j);
      server.listen(0, '127.0.0.1');
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no echo port');
    return { server, port: addr.port };
  }

  it('tunnels raw TCP bytes when no CertPool is configured', async () => {
    const echo = await startEchoServer();
    cleanups.push(() => new Promise<void>((r) => echo.server.close(() => r())));

    const chunks: ProxyChunk[] = [];
    const sessions: ProxySession[] = [];
    const proxy = await startProxyRelay({
      log: () => {},
      onChunk: (c) => chunks.push({ ...c, bytes: Buffer.from(c.bytes) }),
      onSessionEnd: (s) => sessions.push(s),
    });
    cleanups.push(() => proxy.close());

    const client = tcpConnect({ host: proxy.host, port: proxy.port });
    await new Promise<void>((r, j) => {
      client.once('connect', () => r());
      client.once('error', j);
    });

    client.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
    await new Promise<void>((resolve) => {
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          client.off('data', onData);
          resolve();
        }
      };
      client.on('data', onData);
    });

    const payload = Buffer.from('hello-raw-bridge-bytes');
    client.write(payload);
    await new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      let total = 0;
      const onData = (d: Buffer) => {
        parts.push(d);
        total += d.length;
        if (total >= payload.length) {
          client.off('data', onData);
          resolve(Buffer.concat(parts));
        }
      };
      client.on('data', onData);
    });
    client.end();
    await new Promise<void>((r) => client.once('close', () => r()));

    const toUpstream = chunks
      .filter((c) => c.direction === 'client_to_upstream')
      .map((c) => c.bytes.toString('utf8'))
      .join('');
    expect(toUpstream).toContain('hello-raw-bridge-bytes');

    await new Promise((r) => setTimeout(r, 50));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.mitm).toBe(false);
    expect(sessions[0]?.upstream.port).toBe(echo.port);
  });

  it('rejects non-CONNECT methods with 400 Bad Request', async () => {
    const proxy = await startProxyRelay({ log: () => {} });
    cleanups.push(() => proxy.close());

    const client = tcpConnect({ host: proxy.host, port: proxy.port });
    await new Promise<void>((r, j) => {
      client.once('connect', () => r());
      client.once('error', j);
    });

    client.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    const reply = await new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      client.on('data', (d: Buffer) => {
        parts.push(d);
        if (parts.reduce((n, p) => n + p.length, 0) >= 25) {
          resolve(Buffer.concat(parts));
        }
      });
    });
    expect(reply.toString('ascii').startsWith('HTTP/1.1 400')).toBe(true);
    await new Promise<void>((r) => client.once('close', () => r()));
  });

  it('exposes host, port, and proxyUrl', async () => {
    const proxy = await startProxyRelay({ log: () => {} });
    cleanups.push(() => proxy.close());
    expect(proxy.host).toBe('127.0.0.1');
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.proxyUrl).toBe(`http://127.0.0.1:${proxy.port}`);
    expect(proxy.proxyUrl.startsWith('http://')).toBe(true);
  });
});
