/**
 * Decrypt a captured span into structured HTTP exchanges.
 *
 * Pipeline:
 *   1. Write captured SOCKS chunks to a pcap file (pcap.ts)
 *   2. Write captured keylog entries to a sidecar file
 *   3. Invoke `tshark -r <pcap> -o tls.keylog_file:<keys> -T json
 *      -2 -Y http` and capture stdout
 *   4. Parse tshark's per-packet JSON into request/response exchanges
 *      by correlating tcp.stream ids and http direction
 *   5. Run each exchange through the Anthropic extractor to produce
 *      structured TraceEntries
 *
 * If tshark is missing, errors out, or returns no records, we return a
 * fallback snapshot that includes the raw byte counts + key counts so
 * the operator can see "trace was captured but we couldn't decode it"
 * in the UI. The upload layer sends either shape — the server schema
 * tolerates both decoded entries and fallback metadata.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as FS, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extractEntries, type HttpExchange, type TraceEntry } from './anthropic.js';
import type { SpanSnapshot } from './buffer.js';
import { writePcap } from './pcap.js';

const execFileAsync = promisify(execFile);

/**
 * Decoded trace payload produced by running tshark over a span.
 *
 * The `status` field tells the upload layer which path was taken:
 *   - `decoded`: tshark ran, at least one HTTP record was extracted
 *   - `tshark_missing`: tshark isn't on PATH; we still have raw
 *     capture counts so the operator knows something was recorded
 *   - `tshark_failed`: tshark ran but exited non-zero, or returned
 *     non-parsable output; error is in `error`
 *   - `no_records`: tshark ran cleanly but didn't find any HTTP
 *     records — means the bytes weren't HTTPS, or the keys didn't
 *     match, or the flow was too short to decrypt
 *   - `empty`: no chunks in the span, nothing to decode
 */
export interface DecodedSpan {
  status: 'decoded' | 'tshark_missing' | 'tshark_failed' | 'no_records' | 'empty';
  entries: TraceEntry[];
  bytesRecorded: number;
  chunkCount: number;
  keyCount: number;
  truncated: boolean;
  error?: string;
}

export interface DecryptOptions {
  /** Override the tshark binary path. Default: `tshark` on PATH. */
  tsharkBinary?: string;
  /**
   * Working directory for temp files (pcap, keylog sidecar). Default:
   * `$TMPDIR`. Tests pin this to isolate from real paths.
   */
  workDir?: string;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Timeout for tshark invocation, default 15s. */
  timeoutMs?: number;
}

export async function decryptSpan(
  snapshot: SpanSnapshot,
  options: DecryptOptions = {},
): Promise<DecodedSpan> {
  const log =
    options.log ??
    ((msg, ctx = {}) => {
      const record = { ts: new Date().toISOString(), component: 'trace-decrypt', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });

  if (snapshot.chunks.length === 0) {
    return {
      status: 'empty',
      entries: [],
      bytesRecorded: 0,
      chunkCount: 0,
      keyCount: snapshot.keys.length,
      truncated: snapshot.truncated,
    };
  }

  const workDir = options.workDir ?? tmpdir();
  const nonce = randomBytes(6).toString('hex');
  const pcapPath = join(workDir, `c17-span-${nonce}.pcap`);
  const keylogPath = join(workDir, `c17-span-${nonce}.keys`);

  try {
    writePcap(pcapPath, snapshot.chunks);
    await fs.writeFile(
      keylogPath,
      snapshot.keys.map((k) => k.rawLine).join('\n') + (snapshot.keys.length > 0 ? '\n' : ''),
      { mode: 0o600 },
    );

    const tsharkBin = options.tsharkBinary ?? 'tshark';
    const reachable = await isTsharkAvailable(tsharkBin);
    if (!reachable) {
      log('trace-decrypt: tshark not available', { tsharkBin });
      return {
        status: 'tshark_missing',
        entries: [],
        bytesRecorded: snapshot.bytesRecorded,
        chunkCount: snapshot.chunks.length,
        keyCount: snapshot.keys.length,
        truncated: snapshot.truncated,
      };
    }

    let stdout: string;
    try {
      const result = await execFileAsync(
        tsharkBin,
        ['-r', pcapPath, '-o', `tls.keylog_file:${keylogPath}`, '-2', '-Y', 'http', '-T', 'json'],
        {
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      stdout = result.stdout;
    } catch (err) {
      log('trace-decrypt: tshark invocation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: 'tshark_failed',
        entries: [],
        bytesRecorded: snapshot.bytesRecorded,
        chunkCount: snapshot.chunks.length,
        keyCount: snapshot.keys.length,
        truncated: snapshot.truncated,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const exchanges = parseTsharkJson(stdout, snapshot.startedAt, snapshot.endedAt, log);
    if (exchanges.length === 0) {
      return {
        status: 'no_records',
        entries: [],
        bytesRecorded: snapshot.bytesRecorded,
        chunkCount: snapshot.chunks.length,
        keyCount: snapshot.keys.length,
        truncated: snapshot.truncated,
      };
    }
    const entries = extractEntries(exchanges);
    return {
      status: 'decoded',
      entries,
      bytesRecorded: snapshot.bytesRecorded,
      chunkCount: snapshot.chunks.length,
      keyCount: snapshot.keys.length,
      truncated: snapshot.truncated,
    };
  } finally {
    // Scrub temp files — pcap has raw bytes, keylog has TLS secrets.
    for (const p of [pcapPath, keylogPath]) {
      try {
        await fs.unlink(p);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Quick check that tshark is invocable. Uses `--version` which is cheap. */
async function isTsharkAvailable(bin: string): Promise<boolean> {
  // If the caller passed an absolute path, just stat it.
  if (bin.startsWith('/')) {
    try {
      await fs.access(bin, FS.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  // Otherwise rely on tshark returning quickly; we bail at 2s.
  try {
    await execFileAsync(bin, ['--version'], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse tshark's `-T json` output into HttpExchange records.
 *
 * tshark emits an array of packet objects. Each HTTP packet carries
 * `_source.layers.http` with either a `http.request.line` or a
 * `http.response.line`. We correlate request/response by `tcp.stream`
 * id (tshark assigns one per TCP flow), pairing the most recent
 * outstanding request on a stream with the first incoming response.
 *
 * If tshark added fields we don't understand, we fall through to an
 * `opaque_http` record with whatever we can salvage. The anthropic
 * parser handles that case gracefully.
 */
function parseTsharkJson(
  stdout: string,
  fallbackStart: number,
  fallbackEnd: number,
  log: (msg: string, ctx?: Record<string, unknown>) => void,
): HttpExchange[] {
  if (stdout.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    log('trace-decrypt: failed to parse tshark JSON', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // Outstanding request per tcp.stream id.
  const pending = new Map<string, { record: HttpExchange; ts: number }>();
  const out: HttpExchange[] = [];

  for (const packet of parsed) {
    if (!packet || typeof packet !== 'object') continue;
    const layers = getLayers(packet);
    if (!layers) continue;
    const http = layers.http as Record<string, unknown> | undefined;
    if (!http) continue;
    const streamId = asPath(layers, ['tcp', 'tcp.stream']) ?? 'unknown';
    const ts = Math.floor(Number(asPath(layers, ['frame', 'frame.time_epoch']) ?? '0') * 1000);

    if (http['http.request'] === '1' || typeof http['http.request.method'] === 'string') {
      const method = asString(http['http.request.method']) ?? 'GET';
      const uri = asString(http['http.request.uri']) ?? '/';
      const host = asString(http['http.host']) ?? asString(http['http.request.host']) ?? 'unknown';
      const headers = collectHeaders(http);
      const body = parseBodyField(http['http.file_data']);
      pending.set(streamId, {
        ts: ts || fallbackStart,
        record: {
          request: { method, url: uri, host, headers, body },
          response: null,
          startedAt: ts || fallbackStart,
          endedAt: ts || fallbackStart,
        },
      });
    } else if (http['http.response'] === '1' || typeof http['http.response.code'] === 'string') {
      const status = Number(asString(http['http.response.code']) ?? '0');
      const headers = collectHeaders(http);
      const body = parseBodyField(http['http.file_data']);
      const entry = pending.get(streamId);
      if (entry) {
        entry.record.response = { status, headers, body };
        entry.record.endedAt = ts || entry.record.startedAt;
        out.push(entry.record);
        pending.delete(streamId);
      } else {
        // Orphan response — still surface it with a synthetic request.
        out.push({
          request: { method: 'UNKNOWN', url: '', host: 'unknown', headers: {}, body: null },
          response: { status, headers, body },
          startedAt: ts || fallbackStart,
          endedAt: ts || fallbackEnd,
        });
      }
    }
  }

  // Any requests still pending at the end (response was dropped or
  // didn't get decrypted) become request-only exchanges.
  for (const { record } of pending.values()) {
    out.push(record);
  }

  return out;
}

function getLayers(packet: object): Record<string, unknown> | null {
  const source = (packet as { _source?: { layers?: unknown } })._source;
  if (!source || typeof source !== 'object') return null;
  const layers = source.layers;
  if (!layers || typeof layers !== 'object') return null;
  return layers as Record<string, unknown>;
}

function asPath(layers: Record<string, unknown>, path: string[]): string | undefined {
  let cur: unknown = layers;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * tshark emits HTTP headers as flat keys like `http.host`, `http.user_agent`,
 * `http.request.line`, etc. We walk the http layer and pick off the ones
 * that look like header fields (everything after the dot-prefixed shape
 * that tshark uses for non-field metadata).
 */
function collectHeaders(http: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const lineField = http['http.request.line'] ?? http['http.response.line'];
  const lines = Array.isArray(lineField)
    ? lineField.filter((x): x is string => typeof x === 'string')
    : typeof lineField === 'string'
      ? [lineField]
      : [];
  for (const raw of lines) {
    const idx = raw.indexOf(':');
    if (idx <= 0) continue;
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * `http.file_data` from tshark can be a hex string, a plain string, or
 * an array. We attempt JSON parse after utf8 decode; if that fails we
 * return the text unchanged. The Anthropic parser tolerates both.
 */
function parseBodyField(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  let text: string;
  if (typeof v === 'string') {
    // tshark often returns hex when the payload was binary. Detect a
    // hex-only string of even length and decode.
    if (/^[0-9a-f]+$/i.test(v) && v.length % 2 === 0 && v.length > 0) {
      text = Buffer.from(v, 'hex').toString('utf8');
    } else {
      text = v;
    }
  } else if (Array.isArray(v)) {
    text = v.filter((s) => typeof s === 'string').join('');
  } else {
    return v;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  return text;
}

/**
 * Best-effort tshark install check — exported for `c17 claude-code
 * --doctor` in a later phase. Returns `{ present, version, error }`.
 */
export async function probeTshark(bin: string = 'tshark'): Promise<{
  present: boolean;
  version: string | null;
  error: string | null;
}> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 2_000 });
    const firstLine = stdout.split('\n')[0]?.trim() ?? null;
    return { present: true, version: firstLine, error: null };
  } catch (err) {
    return {
      present: false,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
