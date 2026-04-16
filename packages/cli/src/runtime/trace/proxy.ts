/**
 * HTTP CONNECT proxy with optional MITM TLS termination.
 *
 * The agent child is pointed at this proxy via `HTTPS_PROXY=
 * http://127.0.0.1:<port>` and `NODE_EXTRA_CA_CERTS=<ca.pem>`. It
 * speaks the standard HTTP CONNECT tunneling protocol for every
 * outbound HTTPS request.
 *
 * ```
 *           agent                 proxy              upstream
 *             │                     │                    │
 *             │  CONNECT host:443  │                    │
 *             │─────────────────────>                    │
 *             │                     │  TLS handshake    │
 *             │                     │────────────────────>
 *             │                     │<───────────────────│
 *             │  200 Connection..   │                    │
 *             │<─────────────────────                    │
 *             │  ClientHello (TLS)  │                    │
 *             │─────────────────────>                    │
 *             │    [downstream TLS terminated by proxy]  │
 *             │                     │                    │
 *             │ ──plain HTTP req──> │ ─encrypted req──> │
 *             │                     │                    │
 *             │ <──plain HTTP rsp── │ <─encrypted rsp── │
 * ```
 *
 * When a CertPool is provided AND the CONNECT target is port 443:
 *   1. We dial the real upstream as a standard TLS client (SNI =
 *      hostname, standard cert validation — so Anthropic can't tell
 *      us apart from any other user-agent).
 *   2. We issue a leaf cert for the hostname from the CertPool,
 *      signed by our session CA. The agent trusts our CA via
 *      `NODE_EXTRA_CA_CERTS`.
 *   3. We wrap the agent-side socket in a `TLSSocket` in server
 *      mode, using the leaf cert. The agent's client TLS handshake
 *      completes against our MITM.
 *   4. From this point on, both legs are independent TLS sessions.
 *      We capture plaintext on the agent-facing `TLSSocket`'s
 *      `'data'` event (client → upstream direction) and on the
 *      upstream-facing `TLSSocket`'s `'data'` event (upstream →
 *      client direction), then forward to the opposite leg. The
 *      captured bytes are DECRYPTED plaintext, ready for direct
 *      HTTP parsing with no TLS-layer work.
 *
 * For non-443 CONNECT targets OR when no CertPool is configured,
 * we fall back to a plain TCP bridge — the old behavior. Captured
 * chunks are raw TCP bytes in that case (usually ciphertext, so
 * the decrypt layer can't do much with them, but we still report
 * the flow for diagnostics).
 *
 * Transparency to upstream: the MITM only affects the **agent
 * side** of the connection. From the upstream's point of view,
 * we are a normal TLS client doing standard SNI + cert validation
 * + application data. OAuth flows, token refreshes, streaming
 * responses, server-sent events — all work identically because
 * the upstream sees real, unmodified TLS.
 */

import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { type ConnectionOptions, TLSSocket, connect as tlsConnect } from 'node:tls';
import type { CertPool } from './mitm/ca.js';

export interface ProxyChunk {
  readonly sessionId: number;
  readonly ts: number;
  readonly direction: 'client_to_upstream' | 'upstream_to_client';
  readonly upstream: { host: string; port: number };
  /**
   * The bytes that flowed in this direction for this chunk. For
   * MITM-intercepted sessions this is DECRYPTED plaintext. For raw
   * TCP tunnels this is whatever was on the wire (usually
   * ciphertext). Not a copy — the caller must clone if it intends
   * to retain or mutate.
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
  /** Whether this session was MITM-intercepted (true) or raw TCP (false). */
  readonly mitm: boolean;
}

export interface ProxyRelayOptions {
  /** Called synchronously for every chunk the proxy observes. */
  onChunk?: (chunk: ProxyChunk) => void;
  /** Called once per session when both legs have closed. */
  onSessionEnd?: (session: ProxySession) => void;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Per-hostname leaf cert issuer. When provided, CONNECT targets
   * get the MITM treatment; captured chunks are plaintext. Omit
   * for pure TCP relay behavior.
   */
  certPool?: CertPool;
  /**
   * Extra options merged into the upstream `tls.connect()` call
   * during MITM. Production uses this for nothing (the defaults
   * validate against the system CA store, which is what we want
   * when talking to real upstreams). Tests override it to accept
   * self-signed upstream certs.
   */
  upstreamTlsOptions?: ConnectionOptions;
}

export interface ProxyRelay {
  readonly host: string;
  readonly port: number;
  /** The URL the runner bakes into `HTTPS_PROXY`. Always `http://127.0.0.1:<port>`. */
  readonly proxyUrl: string;
  close(): Promise<void>;
}

/** Cap request-header accumulation to defang header-bomb DoS. */
const MAX_HEADER_BYTES = 8 * 1024;

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
    handleSession({
      client,
      sessionId,
      certPool: options.certPool,
      upstreamTlsOptions: options.upstreamTlsOptions,
      onChunk: options.onChunk,
      onSessionEnd: options.onSessionEnd,
      log,
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
  log('proxy: listening', { host, port, mitm: options.certPool !== undefined });

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

// ─── Per-session state machine ─────────────────────────────────────

interface SessionContext {
  client: Socket;
  sessionId: number;
  certPool: CertPool | undefined;
  upstreamTlsOptions: ConnectionOptions | undefined;
  onChunk: ((chunk: ProxyChunk) => void) | undefined;
  onSessionEnd: ((session: ProxySession) => void) | undefined;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

function handleSession(ctx: SessionContext): void {
  const { client, sessionId, log } = ctx;
  const startedAt = Date.now();
  let upstreamHost = '';
  let upstreamPort = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let mitm = false;
  let phase: 'headers' | 'connecting' | 'bridging' | 'closed' = 'headers';
  let headerBuf = Buffer.alloc(0);
  let pendingClientBytes = Buffer.alloc(0);

  const finalize = (): void => {
    if (phase === 'closed') return;
    phase = 'closed';
    ctx.onSessionEnd?.({
      id: sessionId,
      upstream: { host: upstreamHost, port: upstreamPort },
      startedAt,
      endedAt: Date.now(),
      bytesIn,
      bytesOut,
      mitm,
    });
  };

  client.on('error', (err) => {
    log('proxy: client socket error', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  client.on('close', () => finalize());

  // Single data listener handles 'headers' and 'connecting' phases.
  // When we transition into 'bridging', we `off('data', headerData)`
  // and let whichever transport (TLSSocket or raw TCP bridge) attach
  // its own listeners.
  const headerData = (chunk: Buffer): void => {
    if (phase === 'closed') return;

    if (phase === 'headers') {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const end = headerBuf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (headerBuf.length > MAX_HEADER_BYTES) {
          client.write('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
          client.destroy();
        }
        return;
      }
      const headerBytes = headerBuf.subarray(0, end);
      pendingClientBytes = Buffer.from(headerBuf.subarray(end + 4));
      headerBuf = Buffer.alloc(0);

      const parsed = parseConnectLine(headerBytes);
      if (!parsed) {
        const previewLen = Math.min(headerBytes.length, 80);
        const previewAscii = headerBytes
          .subarray(0, previewLen)
          // eslint-disable-next-line no-control-regex
          .toString('ascii')
          .replace(/[^\x20-\x7e]/g, '.');
        const previewHex = headerBytes.subarray(0, previewLen).toString('hex');
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
      phase = 'connecting';

      // MITM whenever a CertPool is configured, regardless of port.
      // In practice agents only CONNECT to HTTPS targets (443 or
      // vanity ports like 8443); the TLS handshake would fail
      // cleanly on any non-TLS traffic. Keeping the code path
      // uniform makes testing easier and avoids silent misbehavior.
      if (ctx.certPool) {
        startMitmBridge();
      } else {
        startRawBridge();
      }
      return;
    }

    if (phase === 'connecting') {
      // More bytes arrived while we're still dialing upstream. Queue
      // them; they'll be flushed into whichever bridge we pick.
      pendingClientBytes = Buffer.concat([pendingClientBytes, chunk]);
      return;
    }
  };
  client.on('data', headerData);

  // ── MITM bridge: terminate TLS on both sides, capture plaintext ──
  const startMitmBridge = (): void => {
    if (!ctx.certPool) return;
    const certPool = ctx.certPool;
    const upstreamMeta = { host: upstreamHost, port: upstreamPort };

    // 1. Dial upstream as a real TLS client. SNI = hostname,
    //    standard cert validation. We forward the ClientHello the
    //    agent sends us (after our leaf-cert handshake with them)
    //    only in spirit — our own upstream TLS is an entirely
    //    independent session.
    const upstreamTls = tlsConnect({
      host: upstreamHost,
      port: upstreamPort,
      servername: upstreamHost,
      // We're a real client, not the agent, so we use the standard
      // Node CA store. No shenanigans here. Tests may override via
      // `upstreamTlsOptions` (e.g. to accept a self-signed fake
      // upstream during unit testing).
      ALPNProtocols: ['http/1.1'],
      ...ctx.upstreamTlsOptions,
    });

    upstreamTls.once('secureConnect', () => {
      if (phase !== 'connecting') {
        upstreamTls.destroy();
        return;
      }

      // 2. Hand off data listener from the header state machine
      //    to the downstream TLSSocket (which will attach its own).
      client.off('data', headerData);

      // 3. Reply 200 to the agent BEFORE we wrap the socket in TLS.
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      // 4. If the agent pipelined its ClientHello after the CONNECT
      //    header, push those bytes back onto the socket's readable
      //    stream so the TLSSocket wrapper sees them.
      if (pendingClientBytes.length > 0) {
        client.unshift(pendingClientBytes);
        pendingClientBytes = Buffer.alloc(0);
      }

      // 5. Issue a leaf cert for this hostname and wrap the agent
      //    socket in a TLSSocket as a server. The leaf cert subject
      //    matches what the agent asked for via CONNECT; SNI should
      //    be the same (we don't currently verify that).
      const leaf = certPool.issueLeaf(upstreamHost);
      let downstreamTls: TLSSocket;
      try {
        downstreamTls = new TLSSocket(client, {
          isServer: true,
          cert: leaf.certPem,
          key: leaf.keyPem,
          ALPNProtocols: ['http/1.1'],
        });
      } catch (err) {
        log('proxy: mitm downstream wrap failed', {
          sessionId,
          host: upstreamHost,
          error: err instanceof Error ? err.message : String(err),
        });
        upstreamTls.destroy();
        client.destroy();
        return;
      }

      mitm = true;
      phase = 'bridging';

      // 6. Plaintext bridge with capture. Both directions.
      downstreamTls.on('data', (data: Buffer) => {
        bytesOut += data.length;
        ctx.onChunk?.({
          sessionId,
          ts: Date.now(),
          direction: 'client_to_upstream',
          upstream: upstreamMeta,
          bytes: data,
        });
        if (!upstreamTls.destroyed) upstreamTls.write(data);
      });
      upstreamTls.on('data', (data: Buffer) => {
        bytesIn += data.length;
        ctx.onChunk?.({
          sessionId,
          ts: Date.now(),
          direction: 'upstream_to_client',
          upstream: upstreamMeta,
          bytes: data,
        });
        if (!downstreamTls.destroyed) downstreamTls.write(data);
      });

      downstreamTls.on('end', () => {
        if (!upstreamTls.destroyed) upstreamTls.end();
      });
      upstreamTls.on('end', () => {
        if (!downstreamTls.destroyed) downstreamTls.end();
      });
      downstreamTls.on('error', (err) => {
        log('proxy: mitm downstream error', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!upstreamTls.destroyed) upstreamTls.destroy();
      });
      upstreamTls.on('error', (err) => {
        log('proxy: mitm upstream error', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!downstreamTls.destroyed) downstreamTls.destroy();
      });
    });

    upstreamTls.on('error', (err) => {
      if (phase === 'connecting') {
        log('proxy: mitm upstream dial failed', {
          sessionId,
          host: upstreamHost,
          port: upstreamPort,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } catch {
          /* socket may already be closed */
        }
        client.destroy();
      }
    });
  };

  // ── Raw TCP bridge: no TLS interception, plain byte relay ────────
  const startRawBridge = (): void => {
    const upstream = netConnect({ host: upstreamHost, port: upstreamPort });
    const upstreamMeta = { host: upstreamHost, port: upstreamPort };

    upstream.once('connect', () => {
      if (phase !== 'connecting') {
        upstream.destroy();
        return;
      }
      client.off('data', headerData);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      phase = 'bridging';

      // Flush any pipelined bytes into upstream before wiring pipes.
      if (pendingClientBytes.length > 0) {
        bytesOut += pendingClientBytes.length;
        ctx.onChunk?.({
          sessionId,
          ts: Date.now(),
          direction: 'client_to_upstream',
          upstream: upstreamMeta,
          bytes: pendingClientBytes,
        });
        upstream.write(pendingClientBytes);
        pendingClientBytes = Buffer.alloc(0);
      }

      client.on('data', (data: Buffer) => {
        bytesOut += data.length;
        ctx.onChunk?.({
          sessionId,
          ts: Date.now(),
          direction: 'client_to_upstream',
          upstream: upstreamMeta,
          bytes: data,
        });
        if (!upstream.destroyed) upstream.write(data);
      });
      upstream.on('data', (data: Buffer) => {
        bytesIn += data.length;
        ctx.onChunk?.({
          sessionId,
          ts: Date.now(),
          direction: 'upstream_to_client',
          upstream: upstreamMeta,
          bytes: data,
        });
        if (!client.destroyed) client.write(data);
      });
      client.on('end', () => {
        if (!upstream.destroyed) upstream.end();
      });
      upstream.on('end', () => {
        if (!client.destroyed) client.end();
      });
    });

    upstream.on('error', (err) => {
      log('proxy: raw upstream error', {
        sessionId,
        host: upstreamHost,
        port: upstreamPort,
        error: err instanceof Error ? err.message : String(err),
      });
      if (phase === 'connecting') {
        try {
          client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } catch {
          /* socket may already be closed */
        }
      }
      client.destroy();
    });
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Parse a `CONNECT host:port HTTP/1.[01]` request line. Returns the
 * extracted host and port or null on any malformed input. Accepts
 * IPv6 literals in bracket form: `CONNECT [::1]:443 HTTP/1.1`.
 */
function parseConnectLine(headerBytes: Buffer): { host: string; port: number } | null {
  const firstLineEnd = headerBytes.indexOf('\r\n');
  const firstLine = (
    firstLineEnd === -1 ? headerBytes : headerBytes.subarray(0, firstLineEnd)
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
