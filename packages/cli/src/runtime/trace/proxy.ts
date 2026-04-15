/**
 * HTTP CONNECT proxy relay for trace capture.
 *
 * We run this on loopback and point the agent at it via
 * `HTTPS_PROXY=http://127.0.0.1:<port>`. Every TCP tunnel the agent
 * opens for outbound HTTP(S) flows through here, which gives us a
 * first-class byte stream to observe without any MitM of the TLS
 * layer. TLS keys come from `SSLKEYLOGFILE` (see keylog.ts);
 * decryption happens out of band at span close via tshark (see
 * decrypt.ts).
 *
 * Why HTTP CONNECT and not SOCKS5:
 *   - undici (Node's built-in fetch, used by Claude Code, the
 *     Anthropic SDK, and most modern Node HTTP clients) supports
 *     HTTP CONNECT proxies via its ProxyAgent but rejects
 *     `socks5://` in `HTTPS_PROXY` with an "unsupported proxy"
 *     error. Clients bail before opening a single TCP connection.
 *   - curl, requests, Go's http.Transport, and every other mature
 *     HTTP client speak HTTP CONNECT fluently.
 *   - The protocol is simpler than SOCKS5: a single-line request
 *     (`CONNECT host:port HTTP/1.1`), a `200 Connection Established`
 *     reply, and from that point on it's raw TCP — no byte-level
 *     framing overhead, no authentication negotiation.
 *
 * Scope for v1:
 *   - CONNECT only. Plain HTTP requests (`GET http://…`) are rejected
 *     with `400 Bad Request` — we don't need them since HTTPS is the
 *     only thing worth capturing keys for.
 *   - No authentication. Loopback-only bind, and only the agent we
 *     spawned has `HTTPS_PROXY` pointing here, so the blast radius
 *     is a single user's login session.
 *   - IPv4, IPv6, and domain targets all accepted.
 *   - Every chunk flowing in either direction is reported to the
 *     caller via `onChunk`, stamped with a monotonic session id, the
 *     upstream `(host, port)`, a direction, and a timestamp. We do
 *     NOT copy the bytes — the callback gets the Buffer slice
 *     verbatim and must clone if it plans to retain or mutate.
 *   - When a connection closes, `onSessionEnd` fires with a
 *     `ProxySession` summary containing accurate byte counters.
 *
 * Concurrency: every accepted socket gets its own state machine
 * (`phase` + buffers). Sessions never share state, so N concurrent
 * tunnels work out of the box.
 */

import { connect, createServer, type Server, type Socket } from 'node:net';

export interface ProxyChunk {
  readonly sessionId: number;
  readonly ts: number;
  readonly direction: 'client_to_upstream' | 'upstream_to_client';
  readonly upstream: { host: string; port: number };
  /**
   * The bytes that flowed in this direction for this chunk. Not a
   * copy — the caller must clone if it intends to retain or mutate.
   */
  readonly bytes: Buffer;
}

export interface ProxySession {
  readonly id: number;
  readonly upstream: { host: string; port: number };
  readonly startedAt: number;
  readonly endedAt: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

export interface ProxyRelayOptions {
  /** Called synchronously for every chunk relayed through the proxy. */
  onChunk?: (chunk: ProxyChunk) => void;
  /** Called once per session when both sides of the tunnel have closed. */
  onSessionEnd?: (session: ProxySession) => void;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface ProxyRelay {
  readonly host: string;
  readonly port: number;
  /**
   * Convenience: the full URL the runner injects into the agent
   * child's env (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`).
   * Always `http://127.0.0.1:<port>`.
   */
  readonly proxyUrl: string;
  close(): Promise<void>;
}

/** Cap request-header accumulation at 8KB to defang header-bomb DoS. */
const MAX_HEADER_BYTES = 8 * 1024;

/**
 * Start an HTTP CONNECT proxy bound to 127.0.0.1 on an ephemeral
 * port. The returned handle exposes the chosen port (so the runner
 * can bake it into `HTTPS_PROXY`) and a `close()` that shuts down
 * the listener.
 */
export async function startProxyRelay(options: ProxyRelayOptions = {}): Promise<ProxyRelay> {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'proxy', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });

  let nextSessionId = 1;

  const server: Server = createServer((client) => {
    const sessionId = nextSessionId++;
    const startedAt = Date.now();
    let upstream: Socket | null = null;
    let upstreamHost = '';
    let upstreamPort = 0;
    let bytesIn = 0;
    let bytesOut = 0;
    // State machine: headers → connecting → tunneled → closed.
    //   headers    — accumulating the CONNECT request line + headers
    //   connecting — CONNECT parsed, upstream connect in flight, any
    //                client bytes that arrive now get buffered
    //   tunneled   — both sides of the tunnel are live, chunks flow
    //   closed     — finalize() has fired, ignore further events
    let phase: 'headers' | 'connecting' | 'tunneled' | 'closed' = 'headers';
    let headerBuf = Buffer.alloc(0);
    let pendingClientBytes = Buffer.alloc(0);

    const finalize = (): void => {
      if (phase === 'closed') return;
      phase = 'closed';
      options.onSessionEnd?.({
        id: sessionId,
        upstream: { host: upstreamHost, port: upstreamPort },
        startedAt,
        endedAt: Date.now(),
        bytesIn,
        bytesOut,
      });
    };

    client.on('error', (err) => {
      log('proxy: client socket error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    client.on('close', () => {
      if (upstream !== null && !upstream.destroyed) upstream.destroy();
      finalize();
    });

    client.on('data', (chunk) => {
      if (phase === 'closed') return;

      if (phase === 'headers') {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const headerEnd = headerBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (headerBuf.length > MAX_HEADER_BYTES) {
            client.write('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
            client.destroy();
          }
          return;
        }
        const headerBytes = headerBuf.slice(0, headerEnd);
        const rest = headerBuf.slice(headerEnd + 4);
        headerBuf = Buffer.alloc(0);

        const parsed = parseConnectLine(headerBytes);
        if (!parsed) {
          // Dump a sanitized preview of whatever came in so we can
          // diagnose clients that send something other than HTTP/1.x
          // CONNECT (HTTP/2 preface, forward-proxy GETs, lowercased
          // verbs, extra whitespace, etc.).
          const previewLen = Math.min(headerBytes.length, 80);
          const previewAscii = headerBytes
            .slice(0, previewLen)
            // eslint-disable-next-line no-control-regex
            .toString('ascii')
            .replace(/[^\x20-\x7e]/g, '.');
          const previewHex = headerBytes.slice(0, previewLen).toString('hex');
          log('proxy: unsupported method', {
            sessionId,
            headerLen: headerBytes.length,
            previewAscii,
            previewHex,
          });
          client.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          client.destroy();
          return;
        }
        upstreamHost = parsed.host;
        upstreamPort = parsed.port;
        pendingClientBytes = rest;
        phase = 'connecting';

        upstream = connect({ host: parsed.host, port: parsed.port }, () => {
          if (phase !== 'connecting') return; // client dropped while we were dialing
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');

          // Wire the upstream→client pipe BEFORE flushing any
          // pending client bytes, so a fast upstream reply doesn't
          // race the listener attachment.
          upstream?.on('data', (upstreamChunk) => {
            if (phase !== 'tunneled') return;
            bytesIn += upstreamChunk.length;
            options.onChunk?.({
              sessionId,
              ts: Date.now(),
              direction: 'upstream_to_client',
              upstream: { host: parsed.host, port: parsed.port },
              bytes: upstreamChunk,
            });
            if (!client.destroyed) client.write(upstreamChunk);
          });

          phase = 'tunneled';

          // Flush any bytes the client pipelined after the CONNECT
          // header (typical: TLS ClientHello arrives in the same
          // packet as the CONNECT). These count as the first real
          // chunk of the tunnel.
          if (pendingClientBytes.length > 0) {
            bytesOut += pendingClientBytes.length;
            options.onChunk?.({
              sessionId,
              ts: Date.now(),
              direction: 'client_to_upstream',
              upstream: { host: parsed.host, port: parsed.port },
              bytes: pendingClientBytes,
            });
            if (upstream && !upstream.destroyed) upstream.write(pendingClientBytes);
            pendingClientBytes = Buffer.alloc(0);
          }
        });

        upstream.on('error', (err) => {
          log('proxy: upstream error', {
            sessionId,
            host: parsed.host,
            port: parsed.port,
            error: err instanceof Error ? err.message : String(err),
          });
          if (phase === 'connecting' && !client.destroyed) {
            client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          }
          client.destroy();
        });
        upstream.on('close', () => {
          if (!client.destroyed) client.end();
        });
        return;
      }

      if (phase === 'connecting') {
        // More client bytes arrived while we're still dialing upstream.
        // Buffer them; they'll be flushed the moment the upstream
        // connect callback fires.
        pendingClientBytes = Buffer.concat([pendingClientBytes, chunk]);
        return;
      }

      if (phase === 'tunneled') {
        bytesOut += chunk.length;
        options.onChunk?.({
          sessionId,
          ts: Date.now(),
          direction: 'client_to_upstream',
          upstream: { host: upstreamHost, port: upstreamPort },
          bytes: chunk,
        });
        if (upstream && !upstream.destroyed) upstream.write(chunk);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err) => reject(err));
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('proxy: server.address() returned non-TCP binding');
  }
  const host = address.address;
  const port = address.port;
  log('proxy: listening', { host, port });

  return {
    host,
    port,
    proxyUrl: `http://${host}:${port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Parse a `CONNECT host:port HTTP/1.[01]` request line. Returns the
 * extracted host and port or null on any malformed input. Accepts
 * IPv6 literals in bracket form: `CONNECT [::1]:443 HTTP/1.1`.
 */
function parseConnectLine(headerBytes: Buffer): { host: string; port: number } | null {
  const firstLineEnd = headerBytes.indexOf('\r\n');
  const firstLine = (
    firstLineEnd === -1 ? headerBytes : headerBytes.slice(0, firstLineEnd)
  ).toString('ascii');
  const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/.exec(firstLine);
  if (!match) return null;
  const target = match[1] ?? '';

  let host: string;
  let portStr: string;
  if (target.startsWith('[')) {
    const closeBracket = target.indexOf(']');
    if (closeBracket === -1) return null;
    host = target.slice(1, closeBracket);
    if (target[closeBracket + 1] !== ':') return null;
    portStr = target.slice(closeBracket + 2);
  } else {
    const colonIdx = target.lastIndexOf(':');
    if (colonIdx === -1) return null;
    host = target.slice(0, colonIdx);
    portStr = target.slice(colonIdx + 1);
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (host.length === 0) return null;
  return { host, port };
}
