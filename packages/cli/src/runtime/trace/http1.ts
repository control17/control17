/**
 * HTTP/1.1 wire-format parser.
 *
 * Walks a reassembled plaintext byte stream (post TLS decryption)
 * and yields request/response messages. Supports:
 *
 *   - Request-line + status-line parsing with method / target /
 *     version extraction.
 *   - Headers until the `\r\n\r\n` delimiter, stripped of folding
 *     whitespace.
 *   - Content-Length bodies.
 *   - Transfer-Encoding: chunked bodies (RFC 7230 §4.1).
 *   - Content-Encoding: gzip, deflate, br decoding (Node zlib +
 *     built-in brotli). Failures fall through with the raw bytes
 *     so the downstream parser can still inspect them.
 *
 * Does NOT support:
 *   - Pipelined connection reuse (multiple request/response pairs
 *     on one byte stream). In practice the Anthropic SDK opens a
 *     fresh connection per request, so this is fine for v1; we'll
 *     add a state machine if we see multi-request flows.
 *   - HTTP/0.9 or HTTP/2. HTTP/2 is a binary wire format and needs
 *     an entirely different parser (deferred).
 *   - Content-Length + Transfer-Encoding together (malformed, we
 *     honor Transfer-Encoding and ignore Content-Length).
 *
 * The parser is a set of pure functions operating on a byte buffer
 * plus a cursor. It never mutates its inputs and returns a fresh
 * result object per call.
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export interface Http1Headers {
  [name: string]: string;
}

export interface Http1Request {
  readonly kind: 'request';
  readonly method: string;
  readonly target: string;
  readonly version: string;
  readonly headers: Http1Headers;
  readonly body: Buffer;
  /** Decoded body after Content-Encoding is applied. Same as `body` if no encoding. */
  readonly decodedBody: Buffer;
}

export interface Http1Response {
  readonly kind: 'response';
  readonly version: string;
  readonly status: number;
  readonly reason: string;
  readonly headers: Http1Headers;
  readonly body: Buffer;
  readonly decodedBody: Buffer;
}

export type Http1Message = Http1Request | Http1Response;

export interface ParseResult {
  readonly message: Http1Message | null;
  readonly consumed: number;
  readonly error?: string;
}

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

/**
 * Attempt to parse a single HTTP/1.1 message from the head of the
 * buffer. Returns `{ message, consumed }` on success, `{ message: null,
 * consumed: 0 }` if more data is needed, or `{ message: null, error }`
 * for malformed input.
 */
export function parseHttp1Message(bytes: Buffer): ParseResult {
  if (bytes.length === 0) return { message: null, consumed: 0 };

  // Find the end of the header block.
  const headerEnd = bytes.indexOf(DOUBLE_CRLF);
  if (headerEnd === -1) return { message: null, consumed: 0 };

  const headerBlock = bytes.subarray(0, headerEnd);
  const bodyStart = headerEnd + DOUBLE_CRLF.length;

  // Split header block on CRLF
  const lines = splitCrlf(headerBlock);
  if (lines.length === 0) return { message: null, consumed: 0, error: 'empty header block' };

  const firstLine = (lines[0] ?? Buffer.alloc(0)).toString('ascii');
  const parsedLine = parseFirstLine(firstLine);
  if (!parsedLine) {
    return {
      message: null,
      consumed: 0,
      error: `unrecognized first line: ${firstLine.slice(0, 80)}`,
    };
  }

  const headers = parseHeaders(lines.slice(1));

  // Figure out body framing.
  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();
  const contentLength = parseContentLength(headers['content-length']);

  let body: Buffer;
  let bodyConsumed: number;
  if (transferEncoding.includes('chunked')) {
    const chunked = decodeChunked(bytes.subarray(bodyStart));
    if (chunked === null) return { message: null, consumed: 0 };
    body = chunked.body;
    bodyConsumed = chunked.consumed;
  } else if (contentLength !== null) {
    if (bytes.length - bodyStart < contentLength) return { message: null, consumed: 0 };
    body = bytes.subarray(bodyStart, bodyStart + contentLength);
    bodyConsumed = contentLength;
  } else if (parsedLine.kind === 'request') {
    // No body framing → no body.
    body = Buffer.alloc(0);
    bodyConsumed = 0;
  } else {
    // Response without framing → read to end of stream. Since our
    // input is the whole TLS flow, "end of stream" = rest of bytes.
    body = bytes.subarray(bodyStart);
    bodyConsumed = body.length;
  }

  const contentEncoding = (headers['content-encoding'] ?? '').toLowerCase().trim();
  const decodedBody = decodeBody(body, contentEncoding);

  const consumed = bodyStart + bodyConsumed;
  if (parsedLine.kind === 'request') {
    return {
      message: {
        kind: 'request',
        method: parsedLine.method,
        target: parsedLine.target,
        version: parsedLine.version,
        headers,
        body,
        decodedBody,
      },
      consumed,
    };
  }
  return {
    message: {
      kind: 'response',
      version: parsedLine.version,
      status: parsedLine.status,
      reason: parsedLine.reason,
      headers,
      body,
      decodedBody,
    },
    consumed,
  };
}

/**
 * Walk a byte buffer pulling HTTP/1.1 messages until no more can be
 * parsed. Useful when feeding a whole decrypted flow at once.
 */
export function parseHttp1Stream(bytes: Buffer): Http1Message[] {
  const out: Http1Message[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const slice = bytes.subarray(offset);
    const result = parseHttp1Message(slice);
    if (result.error || !result.message) break;
    out.push(result.message);
    offset += result.consumed;
  }
  return out;
}

// ─── First-line parsing ────────────────────────────────────────────

type ParsedLine =
  | { kind: 'request'; method: string; target: string; version: string }
  | { kind: 'response'; version: string; status: number; reason: string };

function parseFirstLine(line: string): ParsedLine | null {
  // Status line: `HTTP/1.1 200 OK`
  // Request line: `GET /v1/messages HTTP/1.1`
  if (line.startsWith('HTTP/')) {
    const match = /^(HTTP\/\d\.\d)\s+(\d{3})\s*(.*)$/.exec(line);
    if (!match) return null;
    return {
      kind: 'response',
      version: match[1] ?? 'HTTP/1.1',
      status: Number(match[2]),
      reason: match[3] ?? '',
    };
  }
  const match = /^(\S+)\s+(\S+)\s+(HTTP\/\d\.\d)$/.exec(line);
  if (!match) return null;
  return {
    kind: 'request',
    method: match[1] ?? '',
    target: match[2] ?? '',
    version: match[3] ?? 'HTTP/1.1',
  };
}

// ─── Header parsing ────────────────────────────────────────────────

function splitCrlf(block: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  while (start < block.length) {
    const idx = block.indexOf(CRLF, start);
    if (idx === -1) {
      out.push(block.subarray(start));
      break;
    }
    out.push(block.subarray(start, idx));
    start = idx + CRLF.length;
  }
  return out;
}

function parseHeaders(lines: Buffer[]): Http1Headers {
  const headers: Http1Headers = {};
  for (const raw of lines) {
    const line = raw.toString('utf8');
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (headers[name] !== undefined) {
      // Repeated headers get comma-joined per RFC 7230 §3.2.2.
      headers[name] = `${headers[name]}, ${value}`;
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

function parseContentLength(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// ─── Body framing ──────────────────────────────────────────────────

/**
 * RFC 7230 §4.1 chunked Transfer-Encoding decoder.
 *
 *   chunk          = chunk-size [chunk-ext] CRLF chunk-data CRLF
 *   chunk-size     = 1*HEXDIG
 *   last-chunk     = 1*("0") [chunk-ext] CRLF
 *   trailer-part   = *( header-field CRLF )
 *
 * Returns the concatenated chunk bodies and the total number of
 * bytes consumed (including the trailer-part and final CRLF). Returns
 * null if the buffer is incomplete.
 */
function decodeChunked(bytes: Buffer): { body: Buffer; consumed: number } | null {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const crlf = bytes.indexOf(CRLF, offset);
    if (crlf === -1) return null;
    const sizeLine = bytes.subarray(offset, crlf).toString('ascii');
    // Strip any chunk extensions after `;`
    const semi = sizeLine.indexOf(';');
    const sizeHex = (semi === -1 ? sizeLine : sizeLine.slice(0, semi)).trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) return null;
    offset = crlf + CRLF.length;
    if (size === 0) {
      // Consume the trailer-part (zero or more header lines) until the
      // closing CRLF.
      for (;;) {
        const next = bytes.indexOf(CRLF, offset);
        if (next === -1) return null;
        if (next === offset) {
          // empty line — end of trailer
          return { body: Buffer.concat(parts), consumed: offset + CRLF.length };
        }
        offset = next + CRLF.length;
      }
    }
    if (bytes.length < offset + size + CRLF.length) return null;
    parts.push(bytes.subarray(offset, offset + size));
    offset += size;
    // Trailing CRLF after each chunk
    if (bytes.slice(offset, offset + CRLF.length).compare(CRLF) !== 0) return null;
    offset += CRLF.length;
  }
}

// ─── Content-Encoding decoding ─────────────────────────────────────

function decodeBody(body: Buffer, encoding: string): Buffer {
  if (body.length === 0 || encoding === '' || encoding === 'identity') return body;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(body);
    if (encoding === 'deflate') return inflateSync(body);
    if (encoding === 'br') return brotliDecompressSync(body);
  } catch {
    // Failed to decode — return raw bytes. Downstream can still
    // render whatever is there even if it looks garbled.
  }
  return body;
}
