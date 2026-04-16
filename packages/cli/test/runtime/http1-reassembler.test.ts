/**
 * Incremental HTTP/1.1 reassembler tests.
 *
 * Exercise the chunk → exchange pipeline with realistic shapes:
 *   - A complete request + response in one chunk each
 *   - A request split across multiple chunks
 *   - Back-to-back messages pipelined in one chunk
 *   - Two concurrent sessions interleaved at the chunk level
 *   - A streaming-style request that never gets a response →
 *     flushed on closeSession as request-only
 *   - A buffer overflow poisons the session
 */

import { describe, expect, it } from 'vitest';
import { type Http1Exchange, Http1Reassembler } from '../../src/runtime/trace/http1-reassembler.js';
import type { ProxyChunk } from '../../src/runtime/trace/proxy.js';

function chunk(
  sessionId: number,
  direction: 'client_to_upstream' | 'upstream_to_client',
  bytes: string,
  ts = Date.now(),
): ProxyChunk {
  return {
    sessionId,
    ts,
    direction,
    upstream: { host: 'api.anthropic.com', port: 443 },
    bytes: Buffer.from(bytes),
  };
}

function buildRequest(body: string): string {
  return (
    'POST /v1/messages HTTP/1.1\r\n' +
    'Host: api.anthropic.com\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${body.length}\r\n` +
    '\r\n' +
    body
  );
}

function buildResponse(body: string): string {
  return (
    'HTTP/1.1 200 OK\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${body.length}\r\n` +
    '\r\n' +
    body
  );
}

describe('Http1Reassembler', () => {
  it('emits a single exchange for a complete request + response pair', () => {
    const exchanges: Http1Exchange[] = [];
    const r = new Http1Reassembler({ onExchange: (e) => exchanges.push(e), log: () => {} });

    r.ingest(chunk(1, 'client_to_upstream', buildRequest('{"model":"x"}')));
    r.ingest(chunk(1, 'upstream_to_client', buildResponse('{"ok":true}')));

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.request.target).toBe('/v1/messages');
    expect(exchanges[0]?.response?.status).toBe(200);
    expect(exchanges[0]?.request.body.toString('utf8')).toBe('{"model":"x"}');
    expect(exchanges[0]?.response?.body.toString('utf8')).toBe('{"ok":true}');
  });

  it('reassembles a request split across multiple chunks', () => {
    const exchanges: Http1Exchange[] = [];
    const r = new Http1Reassembler({ onExchange: (e) => exchanges.push(e), log: () => {} });

    const req = buildRequest('{"model":"split"}');
    r.ingest(chunk(1, 'client_to_upstream', req.slice(0, 20)));
    expect(exchanges).toHaveLength(0); // incomplete
    r.ingest(chunk(1, 'client_to_upstream', req.slice(20, 50)));
    expect(exchanges).toHaveLength(0);
    r.ingest(chunk(1, 'client_to_upstream', req.slice(50)));

    r.ingest(chunk(1, 'upstream_to_client', buildResponse('{}')));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.request.body.toString('utf8')).toBe('{"model":"split"}');
  });

  it('parses back-to-back pipelined messages in one chunk', () => {
    const exchanges: Http1Exchange[] = [];
    const r = new Http1Reassembler({ onExchange: (e) => exchanges.push(e), log: () => {} });

    const req1 = buildRequest('{"i":1}');
    const req2 = buildRequest('{"i":2}');
    r.ingest(chunk(1, 'client_to_upstream', req1 + req2));

    r.ingest(chunk(1, 'upstream_to_client', buildResponse('{"r":1}') + buildResponse('{"r":2}')));

    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]?.request.body.toString('utf8')).toBe('{"i":1}');
    expect(exchanges[1]?.request.body.toString('utf8')).toBe('{"i":2}');
    expect(exchanges[0]?.response?.body.toString('utf8')).toBe('{"r":1}');
    expect(exchanges[1]?.response?.body.toString('utf8')).toBe('{"r":2}');
  });

  it('keeps concurrent sessions independent', () => {
    const exchanges: Http1Exchange[] = [];
    const r = new Http1Reassembler({ onExchange: (e) => exchanges.push(e), log: () => {} });

    // Session 1 and session 2 interleave their chunks but should
    // still reassemble independently.
    r.ingest(chunk(1, 'client_to_upstream', buildRequest('{"s":1}').slice(0, 30)));
    r.ingest(chunk(2, 'client_to_upstream', buildRequest('{"s":2}')));
    r.ingest(chunk(1, 'client_to_upstream', buildRequest('{"s":1}').slice(30)));
    r.ingest(chunk(2, 'upstream_to_client', buildResponse('{"r":2}')));
    r.ingest(chunk(1, 'upstream_to_client', buildResponse('{"r":1}')));

    expect(exchanges).toHaveLength(2);
    const s1 = exchanges.find((e) => e.sessionId === 1);
    const s2 = exchanges.find((e) => e.sessionId === 2);
    expect(s1?.request.body.toString('utf8')).toBe('{"s":1}');
    expect(s1?.response?.body.toString('utf8')).toBe('{"r":1}');
    expect(s2?.request.body.toString('utf8')).toBe('{"s":2}');
    expect(s2?.response?.body.toString('utf8')).toBe('{"r":2}');
  });

  it('emits pending requests as response-null exchanges on closeSession', () => {
    const exchanges: Http1Exchange[] = [];
    const r = new Http1Reassembler({ onExchange: (e) => exchanges.push(e), log: () => {} });

    // Request with no matching response — e.g. the server sent a
    // streaming response with no Content-Length and then closed
    // the connection.
    r.ingest(chunk(1, 'client_to_upstream', buildRequest('{"stream":true}')));
    expect(exchanges).toHaveLength(0); // request pending, waiting for response

    r.closeSession(1);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.request.body.toString('utf8')).toBe('{"stream":true}');
    expect(exchanges[0]?.response).toBeNull();
  });

  it('closeAll flushes all sessions', () => {
    const exchanges: Http1Exchange[] = [];
    const r = new Http1Reassembler({ onExchange: (e) => exchanges.push(e), log: () => {} });
    r.ingest(chunk(1, 'client_to_upstream', buildRequest('{"a":1}')));
    r.ingest(chunk(2, 'client_to_upstream', buildRequest('{"a":2}')));
    r.closeAll();
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]?.response).toBeNull();
    expect(exchanges[1]?.response).toBeNull();
  });

  it('uses orphan-response placeholder when response arrives with no pending request', () => {
    const exchanges: Http1Exchange[] = [];
    const r = new Http1Reassembler({ onExchange: (e) => exchanges.push(e), log: () => {} });

    r.ingest(chunk(1, 'upstream_to_client', buildResponse('{"orphan":true}')));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.request.method).toBe('UNKNOWN');
    expect(exchanges[0]?.response?.status).toBe(200);
  });
});
