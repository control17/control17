/**
 * TraceHost integration test.
 *
 * Starts the full trace host (HTTP CONNECT relay + keylog tailer +
 * per-span buffer wired together), drives a real HTTP CONNECT
 * conversation through the proxy into a loopback echo server,
 * appends real keylog lines, and asserts both land in the open
 * span's snapshot at close time. This is the end-to-end capture
 * path minus the decryption step.
 */

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTraceHost } from '../../src/runtime/trace/host.js';

async function startEchoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((s) => {
    s.on('data', (c) => s.write(c));
    s.on('end', () => s.end());
  });
  await new Promise<void>((r, j) => {
    server.once('listening', () => r());
    server.once('error', j);
    server.listen(0, '127.0.0.1');
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  return { server, port: addr.port };
}

describe('TraceHost', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'c17-trace-host-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures HTTP CONNECT traffic and keylog entries into an open span', async () => {
    const keylogPath = join(tmpDir, 'keys.log');
    const host = await startTraceHost({
      log: () => {},
      keylogPath,
    });
    const echo = await startEchoServer();

    try {
      host.openSpan('obj-1');
      expect(host.hasOpenSpan('obj-1')).toBe(true);

      // Drive an HTTP CONNECT conversation through the relay.
      const client = createConnection({ host: host.proxy.host, port: host.proxy.port });
      await new Promise<void>((r, j) => {
        client.once('connect', () => r());
        client.once('error', j);
      });

      const connectLine = `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`;
      client.write(connectLine);
      const reply = await waitForBytes(client, 39);
      expect(reply.toString('ascii').startsWith('HTTP/1.1 200')).toBe(true);

      client.write(Buffer.from('trace-through-proxy'));
      await waitForBytes(client, 'trace-through-proxy'.length);
      client.end();
      await new Promise<void>((r) => client.once('close', () => r()));

      // Append a couple of synthetic keylog entries and let the tailer pick them up.
      appendFileSync(
        keylogPath,
        'CLIENT_HANDSHAKE_TRAFFIC_SECRET aabbccdd 112233\n' +
          'SERVER_HANDSHAKE_TRAFFIC_SECRET aabbccdd 445566\n',
      );
      await host.keylog.drain();

      const snap = host.closeSpan('obj-1');
      expect(snap).not.toBeNull();
      expect(snap?.keys).toHaveLength(2);
      expect(snap?.keys[0]?.label).toBe('CLIENT_HANDSHAKE_TRAFFIC_SECRET');
      // The roundtrip payload appears in both directions.
      const concatChunks = snap?.chunks.map((c) => c.bytes.toString('utf8')).join('') ?? '';
      expect(concatChunks).toContain('trace-through-proxy');
    } finally {
      await new Promise<void>((r) => echo.server.close(() => r()));
      await host.close();
    }
  });

  it('envVars merges NODE_OPTIONS with any existing value', async () => {
    const host = await startTraceHost({
      log: () => {},
      keylogPath: join(tmpDir, 'env-keys.log'),
    });
    try {
      const env = host.envVars({ NODE_OPTIONS: '--max-old-space-size=4096' });
      // Caller's existing NODE_OPTIONS is preserved; we append both
      // --tls-keylog and --require=<shim> so either native flag or
      // preload shim can write TLS keys to the file.
      expect(env.NODE_OPTIONS).toContain('--max-old-space-size=4096');
      expect(env.NODE_OPTIONS).toContain(`--tls-keylog=${host.keylogPath}`);
      expect(env.NODE_OPTIONS).toContain(`--require=${host.shimPath}`);
      expect(env.HTTPS_PROXY).toBe(host.proxy.proxyUrl);
      expect(env.HTTP_PROXY).toBe(host.proxy.proxyUrl);
      expect(env.ALL_PROXY).toBe(host.proxy.proxyUrl);
      expect(env.NODE_USE_ENV_PROXY).toBe('1');
      expect(env.SSLKEYLOGFILE).toBe(host.keylogPath);
      // Critical regression guard: the relay must speak HTTP CONNECT,
      // not SOCKS. undici rejects socks5:// with "unsupported proxy".
      expect(host.proxy.proxyUrl.startsWith('http://')).toBe(true);
      // NO_PROXY must include loopback so local MCP servers and
      // other localhost endpoints bypass the proxy. Regression
      // guard for the "claude hits cmdcntr on 127.0.0.1:8765 and
      // our relay 400s it" bug.
      expect(env.NO_PROXY).toContain('127.0.0.1');
      expect(env.NO_PROXY).toContain('localhost');
      expect(env.NO_PROXY).toContain('::1');
    } finally {
      await host.close();
    }
  });

  it('envVars merges with an existing NO_PROXY instead of overwriting', async () => {
    const host = await startTraceHost({
      log: () => {},
      keylogPath: join(tmpDir, 'noproxy-keys.log'),
    });
    try {
      const env = host.envVars({ NO_PROXY: 'internal.corp,10.0.0.0/8' });
      // The caller's hosts are preserved; loopback is appended.
      expect(env.NO_PROXY).toContain('internal.corp');
      expect(env.NO_PROXY).toContain('10.0.0.0/8');
      expect(env.NO_PROXY).toContain('127.0.0.1');
    } finally {
      await host.close();
    }
  });

  it('writes a TLS keylog shim at startup and deletes it on close', async () => {
    const keylogPath = join(tmpDir, 'shim-probe.log');
    const host = await startTraceHost({ log: () => {}, keylogPath });
    const fs = await import('node:fs');
    // Shim file exists, is non-empty, and contains the hook code.
    expect(fs.existsSync(host.shimPath)).toBe(true);
    const shimBody = fs.readFileSync(host.shimPath, 'utf8');
    expect(shimBody).toContain("require('tls')");
    expect(shimBody).toContain('keylog');
    expect(shimBody).toContain('SSLKEYLOGFILE');
    await host.close();
    expect(fs.existsSync(host.shimPath)).toBe(false);
  });

  it('close() deletes the keylog file', async () => {
    const keylogPath = join(tmpDir, 'ephemeral.log');
    const host = await startTraceHost({ log: () => {}, keylogPath });
    const fs = await import('node:fs');
    expect(fs.existsSync(keylogPath)).toBe(true);
    await host.close();
    expect(fs.existsSync(keylogPath)).toBe(false);
  });
});

async function waitForBytes(socket: import('node:net').Socket, n: number): Promise<Buffer> {
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
