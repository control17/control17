/**
 * Incremental HTTP/1.1 reassembler for the MITM proxy's plaintext
 * chunk stream.
 *
 * The proxy hands us plaintext `ProxyChunk`s as they flow through
 * each TLS session. This module keeps per-session rolling buffers
 * and tries to parse complete HTTP/1.1 messages out of them via the
 * existing `parseHttp1Message` helper whenever new bytes arrive.
 * As requests and responses complete, it pairs them in FIFO order
 * (one flow == one connection == ordered request/response pairs)
 * and emits each pair as an `Http1Exchange` via `onExchange`.
 *
 * Per-session state lives in a `Session` object keyed by the
 * proxy's session id. On `closeSession`, any unpaired requests
 * are emitted as request-only exchanges — typical for streaming
 * responses that close the TCP connection before a clean final
 * chunk arrives.
 *
 * The reassembler is push-driven and fully synchronous. It never
 * buffers more than one in-flight message worth of bytes per
 * direction per session — old bytes are sliced off as soon as a
 * message is consumed. Memory usage stays bounded by the per-
 * message max, not by session lifetime.
 */

import type { Http1Request, Http1Response } from './http1.js';
import { parseHttp1Message } from './http1.js';
import type { ProxyChunk } from './proxy.js';

export interface Http1Exchange {
  readonly sessionId: number;
  readonly upstream: { host: string; port: number };
  /** Request always present. For streaming flows, present even if the response is null. */
  readonly request: Http1Request;
  /** Response is null when the request completed but no response ever arrived. */
  readonly response: Http1Response | null;
  /** Start-of-request wall clock time. */
  readonly startedAt: number;
  /** End-of-response wall clock time (or end-of-request if no response). */
  readonly endedAt: number;
}

export interface Http1ReassemblerOptions {
  /**
   * Called synchronously for every completed exchange (request + optional
   * response). For streaming response flows, the exchange fires once the
   * response is fully parsed; for terminated connections with no response,
   * it fires from `closeSession` with `response: null`.
   */
  onExchange: (exchange: Http1Exchange) => void;
  /**
   * Log hook for parser errors and oversized buffers. Errors are recoverable —
   * the reassembler drops the affected session's buffers and keeps going.
   */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Per-message max body size. Anthropic responses can be large
 * (full tool_use transcripts, long assistant replies); we cap at
 * 32 MB to protect against runaway allocations from malformed
 * framing that we can't ever parse successfully. Past this cap the
 * session is torn down and no exchanges fire.
 */
const MAX_DIRECTION_BUFFER = 32 * 1024 * 1024;

interface PendingRequest {
  readonly request: Http1Request;
  readonly startedAt: number;
}

interface Session {
  readonly id: number;
  readonly upstream: { host: string; port: number };
  /** Accumulated client→upstream plaintext waiting to be parsed. */
  clientBuf: Buffer;
  /** Accumulated upstream→client plaintext waiting to be parsed. */
  serverBuf: Buffer;
  /** Requests parsed and waiting for a matching response. */
  pending: PendingRequest[];
  /** ts of the most recent client→upstream chunk, used as request start. */
  lastClientTs: number;
  /** ts of the most recent upstream→client chunk, used as response end. */
  lastServerTs: number;
  /** True once a buffer overflowed — we stop parsing and wait for close. */
  poisoned: boolean;
}

export class Http1Reassembler {
  private readonly sessions = new Map<number, Session>();
  private readonly onExchange: (exchange: Http1Exchange) => void;
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;

  constructor(options: Http1ReassemblerOptions) {
    this.onExchange = options.onExchange;
    this.log = options.log ?? (() => {});
  }

  /** Push a chunk from the proxy into the reassembler. */
  ingest(chunk: ProxyChunk): void {
    let session = this.sessions.get(chunk.sessionId);
    if (!session) {
      session = {
        id: chunk.sessionId,
        upstream: chunk.upstream,
        clientBuf: Buffer.alloc(0),
        serverBuf: Buffer.alloc(0),
        pending: [],
        lastClientTs: chunk.ts,
        lastServerTs: chunk.ts,
        poisoned: false,
      };
      this.sessions.set(chunk.sessionId, session);
    }
    if (session.poisoned) return;

    if (chunk.direction === 'client_to_upstream') {
      session.clientBuf = Buffer.concat([session.clientBuf, chunk.bytes]);
      session.lastClientTs = chunk.ts;
      this.drainClient(session);
    } else {
      session.serverBuf = Buffer.concat([session.serverBuf, chunk.bytes]);
      session.lastServerTs = chunk.ts;
      this.drainServer(session);
    }

    if (
      session.clientBuf.length > MAX_DIRECTION_BUFFER ||
      session.serverBuf.length > MAX_DIRECTION_BUFFER
    ) {
      this.log('http1-reassembler: session buffer overflow, poisoning', {
        sessionId: session.id,
        clientLen: session.clientBuf.length,
        serverLen: session.serverBuf.length,
      });
      session.poisoned = true;
      session.clientBuf = Buffer.alloc(0);
      session.serverBuf = Buffer.alloc(0);
    }
  }

  /**
   * End a session (TCP connection closed). Flushes any pending
   * requests as request-only exchanges. Forgets the session
   * afterwards.
   */
  closeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.poisoned) return;

    // Try one more drain — a terminating server might have sent a
    // response without Content-Length by closing the connection; in
    // that case parseHttp1Stream can't decide the body is complete
    // from the byte stream alone, but we already have all the bytes.
    // Our parser hands back `null` for "need more data" on incomplete
    // framing, so there's no way to flush a Content-Length-less
    // response here without re-running it with a "stream ended"
    // signal. Accept that edge case: such responses become
    // request-only exchanges. A follow-up can add a "flush" mode
    // to the parser if it matters in practice.
    this.drainClient(session);
    this.drainServer(session);

    for (const pending of session.pending) {
      this.onExchange({
        sessionId: session.id,
        upstream: session.upstream,
        request: pending.request,
        response: null,
        startedAt: pending.startedAt,
        endedAt: pending.startedAt,
      });
    }
  }

  /** Tear down all sessions (runner shutdown). */
  closeAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.closeSession(id);
    }
  }

  // ── Internal drain loops ──────────────────────────────────────

  private drainClient(session: Session): void {
    for (;;) {
      if (session.clientBuf.length === 0) return;
      const result = parseHttp1Message(session.clientBuf);
      if (result.error) {
        // Malformed request — drop the buffer up to the next
        // plausible line break and keep trying. If we can't find
        // anything, poison the session.
        this.log('http1-reassembler: client parse error', {
          sessionId: session.id,
          error: result.error,
        });
        session.clientBuf = Buffer.alloc(0);
        return;
      }
      if (!result.message) return; // need more data
      if (result.message.kind !== 'request') {
        // Server-side message on the client direction? Drop it.
        session.clientBuf = session.clientBuf.subarray(result.consumed);
        continue;
      }
      session.pending.push({
        request: result.message,
        startedAt: session.lastClientTs,
      });
      session.clientBuf = session.clientBuf.subarray(result.consumed);
    }
  }

  private drainServer(session: Session): void {
    for (;;) {
      if (session.serverBuf.length === 0) return;
      const result = parseHttp1Message(session.serverBuf);
      if (result.error) {
        this.log('http1-reassembler: server parse error', {
          sessionId: session.id,
          error: result.error,
        });
        session.serverBuf = Buffer.alloc(0);
        return;
      }
      if (!result.message) return; // need more data
      if (result.message.kind !== 'response') {
        session.serverBuf = session.serverBuf.subarray(result.consumed);
        continue;
      }
      const pending = session.pending.shift();
      if (!pending) {
        // Orphan response. Emit with a synthetic request placeholder
        // so the web UI still sees it.
        this.onExchange({
          sessionId: session.id,
          upstream: session.upstream,
          request: {
            kind: 'request',
            method: 'UNKNOWN',
            target: '',
            version: 'HTTP/1.1',
            headers: {},
            body: Buffer.alloc(0),
            decodedBody: Buffer.alloc(0),
          },
          response: result.message,
          startedAt: session.lastServerTs,
          endedAt: session.lastServerTs,
        });
      } else {
        this.onExchange({
          sessionId: session.id,
          upstream: session.upstream,
          request: pending.request,
          response: result.message,
          startedAt: pending.startedAt,
          endedAt: session.lastServerTs,
        });
      }
      session.serverBuf = session.serverBuf.subarray(result.consumed);
    }
  }
}
