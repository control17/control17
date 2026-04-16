/**
 * HTTP/1.1 parser tests.
 *
 * Cover the framings the real Anthropic SDK emits/receives:
 *
 *   - Simple request + response with Content-Length
 *   - Chunked response body (Transfer-Encoding: chunked)
 *   - gzip-compressed response body (Content-Encoding: gzip)
 *   - Headers with repeated names (merged per RFC 7230 §3.2.2)
 *   - Back-to-back request/response in a single byte stream
 *   - Partial/incomplete input returns null without throwing
 *   - Multi-line header block with folded/extra whitespace
 */

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  type Http1Request,
  type Http1Response,
  parseHttp1Message,
  parseHttp1Stream,
} from '../../src/runtime/trace/http1.js';

function buildRequest(body: string): Buffer {
  return Buffer.from(
    `POST /v1/messages HTTP/1.1\r\n` +
      `Host: api.anthropic.com\r\n` +
      `User-Agent: test/1.0\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\n` +
      `\r\n` +
      body,
  );
}

function buildResponse(body: string, status = 200): Buffer {
  return Buffer.from(
    `HTTP/1.1 ${status} OK\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\n` +
      `\r\n` +
      body,
  );
}

describe('parseHttp1Message — request', () => {
  it('parses a basic POST with Content-Length body', () => {
    const body = '{"model":"claude-sonnet-4-6","messages":[]}';
    const bytes = buildRequest(body);
    const result = parseHttp1Message(bytes);
    expect(result.message?.kind).toBe('request');
    const req = result.message as Http1Request;
    expect(req.method).toBe('POST');
    expect(req.target).toBe('/v1/messages');
    expect(req.version).toBe('HTTP/1.1');
    expect(req.headers.host).toBe('api.anthropic.com');
    expect(req.headers['content-length']).toBe(String(body.length));
    expect(req.body.toString('utf8')).toBe(body);
    expect(req.decodedBody.toString('utf8')).toBe(body);
    expect(result.consumed).toBe(bytes.length);
  });

  it('parses GET with no body', () => {
    const bytes = Buffer.from('GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n');
    const result = parseHttp1Message(bytes);
    const req = result.message as Http1Request;
    expect(req?.kind).toBe('request');
    expect(req.method).toBe('GET');
    expect(req.body.length).toBe(0);
  });
});

describe('parseHttp1Message — response', () => {
  it('parses a 200 OK with Content-Length body', () => {
    const body = '{"id":"msg_01","type":"message"}';
    const bytes = buildResponse(body);
    const result = parseHttp1Message(bytes);
    const resp = result.message as Http1Response;
    expect(resp.kind).toBe('response');
    expect(resp.status).toBe(200);
    expect(resp.reason).toBe('OK');
    expect(resp.body.toString('utf8')).toBe(body);
    expect(result.consumed).toBe(bytes.length);
  });

  it('parses a chunked response body and concatenates chunk payloads', () => {
    const bytes = Buffer.from(
      'HTTP/1.1 200 OK\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        'Content-Type: application/json\r\n' +
        '\r\n' +
        '5\r\nhello\r\n' + // chunk 1: "hello"
        '6\r\n world\r\n' + // chunk 2: " world"
        '0\r\n' + // last chunk
        '\r\n', // trailer CRLF
    );
    const result = parseHttp1Message(bytes);
    const resp = result.message as Http1Response;
    expect(resp.kind).toBe('response');
    expect(resp.body.toString('utf8')).toBe('hello world');
    expect(result.consumed).toBe(bytes.length);
  });

  it('parses a chunked response with chunk extensions', () => {
    const bytes = Buffer.from(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
        '5;ext=foo\r\nhello\r\n' +
        '0\r\n\r\n',
    );
    const result = parseHttp1Message(bytes);
    const resp = result.message as Http1Response;
    expect(resp?.body.toString('utf8')).toBe('hello');
  });

  it('gunzips Content-Encoding: gzip response bodies', () => {
    const plain = '{"completion":"Hello, world."}';
    const compressed = gzipSync(Buffer.from(plain));
    const bytes = Buffer.concat([
      Buffer.from(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Encoding: gzip\r\n' +
          `Content-Length: ${compressed.length}\r\n\r\n`,
      ),
      compressed,
    ]);
    const result = parseHttp1Message(bytes);
    const resp = result.message as Http1Response;
    expect(resp.body.equals(compressed)).toBe(true);
    expect(resp.decodedBody.toString('utf8')).toBe(plain);
  });

  it('merges repeated headers with a comma', () => {
    const bytes = Buffer.from(
      'HTTP/1.1 200 OK\r\n' +
        'Set-Cookie: a=1\r\n' +
        'Set-Cookie: b=2\r\n' +
        'Content-Length: 0\r\n' +
        '\r\n',
    );
    const result = parseHttp1Message(bytes);
    expect(result.message?.headers['set-cookie']).toBe('a=1, b=2');
  });

  it('returns null when headers are incomplete', () => {
    const bytes = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n');
    const result = parseHttp1Message(bytes);
    expect(result.message).toBeNull();
    expect(result.consumed).toBe(0);
  });

  it('returns null when body bytes are missing', () => {
    const bytes = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc');
    const result = parseHttp1Message(bytes);
    expect(result.message).toBeNull();
    expect(result.consumed).toBe(0);
  });

  it('returns an error for malformed status line', () => {
    const bytes = Buffer.from('GIBBERISH LINE\r\n\r\n');
    const result = parseHttp1Message(bytes);
    expect(result.message).toBeNull();
    expect(result.error).toBeDefined();
  });
});

describe('parseHttp1Stream', () => {
  it('walks multiple back-to-back messages', () => {
    const req = buildRequest('{"a":1}');
    const resp = buildResponse('{"ok":true}');
    const stream = Buffer.concat([req, resp]);
    const messages = parseHttp1Stream(stream);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.kind).toBe('request');
    expect(messages[1]?.kind).toBe('response');
  });

  it('stops cleanly at a partial trailing message', () => {
    const req = buildRequest('{"a":1}');
    const partial = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n');
    const stream = Buffer.concat([req, partial]);
    const messages = parseHttp1Stream(stream);
    // Only the complete request; the partial response is held back.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe('request');
  });
});
