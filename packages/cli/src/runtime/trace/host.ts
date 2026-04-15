/**
 * TraceHost — ties the HTTP CONNECT proxy relay, the keylog tailer,
 * and the per-span trace buffer into one handle the runner owns.
 *
 * The runner constructs a `TraceHost` at startup when tracing is
 * enabled, bakes its `envVars()` into the agent child's environment,
 * and calls `openSpan()` / `closeSpan()` from the objectives tracker
 * when SSE objective events arrive. The decrypt layer consumes the
 * returned SpanSnapshots before uploading them to the broker.
 *
 * Everything is loopback-only and scoped to the runner's lifetime.
 * On `close()` the proxy relay is torn down and the keylog file is
 * deleted — we don't want TLS key material lingering on disk after
 * the agent exits.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type SpanSnapshot, TraceBuffer } from './buffer.js';
import { type KeylogTailer, startKeylogTailer } from './keylog.js';
import { type ProxyRelay, startProxyRelay } from './proxy.js';

/**
 * Preload shim written to a temp file at trace-host startup and
 * injected into the agent child via `NODE_OPTIONS="--require=<path>"`.
 * The shim hooks `tls.connect` and wires a `'keylog'` event handler
 * on every socket that writes NSS-format keylog lines to the file
 * at `$SSLKEYLOGFILE`.
 *
 * Why we ship this in addition to `--tls-keylog=<path>`:
 *   Node's `--tls-keylog` flag is the canonical way to do this, but
 *   some packaged-binary distributions of node-based tools (pkg,
 *   bun build --compile, yao-pkg) either ignore `NODE_OPTIONS`
 *   entirely or strip CLI flags from it. The require-shim runs at
 *   user-code load time, so it survives anything short of the child
 *   actively rewriting `tls.connect` itself.
 *
 * The shim is CommonJS because `--require` only loads CJS modules.
 * It's written fresh to a pid-scoped tmp dir per runner session so
 * we don't have to ship it as a build artifact or worry about
 * stale copies from prior runs.
 */
const TLS_KEYLOG_SHIM_CODE = `'use strict';
// c17 trace-host TLS keylog shim — see trace/host.ts for context.
const tls = require('tls');
const fs = require('fs');
const path = process.env.SSLKEYLOGFILE;
if (path) {
  let stream = null;
  const ensureStream = () => {
    if (stream === null) {
      try {
        stream = fs.createWriteStream(path, { flags: 'a', mode: 0o600 });
      } catch (_err) {
        stream = false; // sentinel: couldn't open, give up quietly
      }
    }
    return stream;
  };
  const attachKeylog = (socket) => {
    if (!socket || typeof socket.on !== 'function') return;
    socket.on('keylog', (line) => {
      const s = ensureStream();
      if (!s) return;
      s.write(line);
      // NSS keylog lines already end in \\n in Node's emission, but
      // add one defensively if the runtime version differs.
      const last = line[line.length - 1];
      if (last !== 0x0a) s.write('\\n');
    });
  };
  const origConnect = tls.connect;
  tls.connect = function patchedTlsConnect() {
    const socket = origConnect.apply(this, arguments);
    attachKeylog(socket);
    return socket;
  };
}
`;

export interface TraceHostOptions {
  /**
   * Where the keylog file lives. Defaults to a pid-scoped path under
   * `$TMPDIR`. Tests override this to isolate from real traffic.
   */
  keylogPath?: string;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Soft byte cap per span. Forwarded to the TraceBuffer. */
  byteSoftCapPerSpan?: number;
}

export interface TraceHost {
  readonly proxy: ProxyRelay;
  readonly keylog: KeylogTailer;
  readonly buffer: TraceBuffer;
  readonly keylogPath: string;
  /** Absolute path to the preload shim the runner injects via `--require`. */
  readonly shimPath: string;
  /**
   * Env vars to merge into the agent child's environment. Contains
   * `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` pointing at the loopback
   * HTTP CONNECT relay, `SSLKEYLOGFILE` + both `--tls-keylog` and
   * `--require=<shim>` appended into `NODE_OPTIONS`, and
   * `NODE_USE_ENV_PROXY=1` so modern Node versions auto-wire undici's
   * global dispatcher through the proxy. The caller is responsible
   * for merging — this function returns a delta, not a full
   * replacement.
   */
  envVars(existingEnv?: NodeJS.ProcessEnv): Record<string, string>;
  openSpan(objectiveId: string): void;
  closeSpan(objectiveId: string): SpanSnapshot | null;
  hasOpenSpan(objectiveId: string): boolean;
  /** Tear down proxy + keylog and delete the keylog file. Idempotent. */
  close(): Promise<void>;
}

export async function startTraceHost(options: TraceHostOptions = {}): Promise<TraceHost> {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'trace-host', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });

  const keylogPath =
    options.keylogPath ??
    join(tmpdir(), `c17-keylog-${process.pid}-${randomBytes(4).toString('hex')}.log`);

  // Write the TLS keylog preload shim next to the keylog file so
  // both are cleaned up together at tear-down time. We use
  // `--require=<shim>` in NODE_OPTIONS as a fallback for
  // environments where Node's `--tls-keylog` flag is filtered or
  // unsupported. Shim is rewritten on every startup so a crashed
  // prior run can't leave a stale file behind.
  const shimPath = join(
    dirname(keylogPath),
    `c17-tls-keylog-shim-${process.pid}-${randomBytes(4).toString('hex')}.cjs`,
  );
  await fs.writeFile(shimPath, TLS_KEYLOG_SHIM_CODE, { mode: 0o600 });

  const buffer = new TraceBuffer({ byteSoftCapPerSpan: options.byteSoftCapPerSpan, log });

  const proxy = await startProxyRelay({
    log,
    onChunk: (chunk) => buffer.ingestChunk(chunk),
  });

  const keylog = await startKeylogTailer({
    path: keylogPath,
    log,
    onEntry: (entry) => buffer.ingestKey(entry),
  });

  log('trace-host: started', { proxyUrl: proxy.proxyUrl, keylogPath, shimPath });

  let closed = false;

  return {
    proxy,
    keylog,
    buffer,
    keylogPath,
    shimPath,
    envVars(existingEnv: NodeJS.ProcessEnv = {}): Record<string, string> {
      // Both --tls-keylog (native Node flag) and --require (our
      // fallback shim). If the child's runtime honors either one,
      // keys land in the file. If it honors both, we get duplicate
      // lines but tshark dedupes by client_random, so no harm done.
      const mergedNodeOptions = [
        existingEnv.NODE_OPTIONS,
        `--tls-keylog=${keylogPath}`,
        `--require=${shimPath}`,
      ]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join(' ');
      // Never route loopback traffic through the proxy. Local MCP
      // servers, auto-update checks, and other parent-configured
      // local endpoints fire plain-HTTP POSTs to 127.0.0.1 that
      // our CONNECT relay can't handle — and capturing them has
      // no value anyway since none of it is LLM traffic. undici,
      // curl, Python requests, and Go's http.Transport all honor
      // NO_PROXY as a comma-separated host list. If the caller
      // already has NO_PROXY set, we merge with it rather than
      // overwrite.
      const existingNoProxy = existingEnv.NO_PROXY ?? existingEnv.no_proxy ?? '';
      const noProxyHosts = ['localhost', '127.0.0.1', '::1'];
      const mergedNoProxy = existingNoProxy
        ? `${existingNoProxy},${noProxyHosts.join(',')}`
        : noProxyHosts.join(',');
      return {
        // undici (Node fetch) honors HTTPS_PROXY/HTTP_PROXY with an
        // http:// scheme and uses HTTP CONNECT to tunnel through. It
        // rejects socks5:// with "unsupported proxy" — that's the
        // whole reason this relay speaks HTTP CONNECT and not SOCKS.
        HTTPS_PROXY: proxy.proxyUrl,
        HTTP_PROXY: proxy.proxyUrl,
        // Curl + Python requests + Go http.Transport convention.
        ALL_PROXY: proxy.proxyUrl,
        // Bypass list — loopback hosts + anything the caller
        // already had configured.
        NO_PROXY: mergedNoProxy,
        // Node 24+ picks up HTTP_PROXY/HTTPS_PROXY automatically when
        // this is set. Earlier Node versions ignore it but clients
        // that read the env vars directly still honor them.
        NODE_USE_ENV_PROXY: '1',
        SSLKEYLOGFILE: keylogPath,
        NODE_OPTIONS: mergedNodeOptions,
      };
    },
    openSpan(objectiveId) {
      buffer.openSpan(objectiveId);
    },
    closeSpan(objectiveId) {
      return buffer.closeSpan(objectiveId);
    },
    hasOpenSpan(objectiveId) {
      return buffer.hasOpenSpan(objectiveId);
    },
    async close() {
      if (closed) return;
      closed = true;
      await keylog.close().catch((err) => {
        log('trace-host: keylog close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await proxy.close().catch((err) => {
        log('trace-host: proxy close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Delete the keylog file and the preload shim. Keylog
      // contains raw TLS secrets; shim is just source code but is
      // tied to the runner session. Best-effort; ENOENT is fine.
      for (const p of [keylogPath, shimPath]) {
        try {
          await fs.unlink(p);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log('trace-host: unlink failed', {
              path: p,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      log('trace-host: closed');
    },
  };
}
