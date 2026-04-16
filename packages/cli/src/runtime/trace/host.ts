/**
 * TraceHost — ties the MITM TLS proxy relay, the local CA, and the
 * streaming activity uploader into one handle the runner owns.
 *
 * The runner constructs a `TraceHost` at startup when tracing is
 * enabled, bakes its `envVars()` into the agent child's environment,
 * and calls `noteObjective{Open,Close}()` from the objectives
 * tracker when SSE objective events arrive. Every HTTPS flow the
 * agent makes is decrypted transparently via the MITM proxy;
 * completed HTTP/1.1 exchanges stream up to the broker via the
 * activity uploader in real time, not at span close.
 *
 * There's no TraceBuffer, no span boundary, no per-objective
 * copying. The agent's activity log is the source of truth; per-
 * objective views are just time-range queries.
 *
 * Everything is loopback-only and scoped to the runner's lifetime.
 * On `close()` the uploader drains (best-effort), the proxy relay
 * is torn down, and the CA cert file is deleted.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client as BrokerClient } from '@control17/sdk/client';
import type { AgentActivityEvent, TraceEntry } from '@control17/sdk/types';
import { ActivityUploader } from './activity-uploader.js';
import { extractEntries, type HttpExchange } from './anthropic.js';
import { type Http1Exchange, Http1Reassembler } from './http1-reassembler.js';
import { type CertPool, createCertPool, createTraceCa, type TraceCa } from './mitm/ca.js';
import { type ProxyRelay, startProxyRelay } from './proxy.js';

export interface TraceHostOptions {
  brokerClient: BrokerClient;
  callsign: string;
  /**
   * Where the CA cert PEM lives on disk. Defaults to a pid-scoped
   * path under `$TMPDIR`. Tests override this to isolate from real
   * runs.
   */
  caCertPath?: string;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface TraceHost {
  readonly proxy: ProxyRelay;
  readonly ca: TraceCa;
  readonly certPool: CertPool;
  /** Path on disk where the CA cert PEM is written, for NODE_EXTRA_CA_CERTS. */
  readonly caCertPath: string;
  /**
   * Env vars to merge into the agent child's environment (see the
   * comment on the implementation for the full list). Returns a
   * delta, not a full replacement.
   */
  envVars(existingEnv?: NodeJS.ProcessEnv): Record<string, string>;
  /** Record an objective_open event in the agent's activity stream. */
  noteObjectiveOpen(objectiveId: string): void;
  /** Record an objective_close event. */
  noteObjectiveClose(
    objectiveId: string,
    result: 'done' | 'cancelled' | 'reassigned' | 'runner_shutdown',
  ): void;
  /** Flush the activity uploader + tear down the proxy + delete the CA cert file. */
  close(): Promise<void>;
}

export async function startTraceHost(options: TraceHostOptions): Promise<TraceHost> {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'trace-host', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });

  const caCertPath =
    options.caCertPath ??
    join(tmpdir(), `c17-trace-ca-${process.pid}-${randomBytes(4).toString('hex')}.pem`);

  // Generate a fresh per-session CA + shared leaf keypair. The CA
  // cert (public) goes to disk so the agent can pick it up via
  // `NODE_EXTRA_CA_CERTS`. Private keys never touch disk.
  const ca = createTraceCa();
  await fs.writeFile(caCertPath, ca.caCertPem, { mode: 0o600 });
  const certPool = createCertPool(ca);

  // Streaming activity uploader — batches events, ships to broker.
  const uploader = new ActivityUploader({
    brokerClient: options.brokerClient,
    callsign: options.callsign,
    log,
  });

  // Incremental HTTP/1.1 reassembler — turns plaintext proxy
  // chunks into completed request/response exchanges. Each
  // exchange is translated to an activity event and handed to
  // the uploader.
  const reassembler = new Http1Reassembler({
    log,
    onExchange: (exchange) => {
      const event = exchangeToActivity(exchange);
      if (event) uploader.enqueue(event);
    },
  });

  const proxy = await startProxyRelay({
    log,
    certPool,
    onChunk: (chunk) => reassembler.ingest(chunk),
    onSessionEnd: (session) => reassembler.closeSession(session.id),
  });

  log('trace-host: started', {
    proxyUrl: proxy.proxyUrl,
    caCertPath,
    callsign: options.callsign,
  });

  let closed = false;

  return {
    proxy,
    ca,
    certPool,
    caCertPath,
    envVars(existingEnv: NodeJS.ProcessEnv = {}): Record<string, string> {
      const existingNoProxy = existingEnv.NO_PROXY ?? existingEnv.no_proxy ?? '';
      const noProxyHosts = ['localhost', '127.0.0.1', '::1'];
      const mergedNoProxy = existingNoProxy
        ? `${existingNoProxy},${noProxyHosts.join(',')}`
        : noProxyHosts.join(',');
      return {
        HTTPS_PROXY: proxy.proxyUrl,
        HTTP_PROXY: proxy.proxyUrl,
        ALL_PROXY: proxy.proxyUrl,
        NO_PROXY: mergedNoProxy,
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: caCertPath,
        // Packaged-binary Node distributions (pkg, sea, yao-pkg)
        // sometimes ship their own bundled cert store that
        // NODE_EXTRA_CA_CERTS can't extend. Disabling cert
        // validation in the child is the failsafe — scoped to
        // this loopback runner session only.
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      };
    },
    noteObjectiveOpen(objectiveId) {
      uploader.enqueue({
        kind: 'objective_open',
        ts: Date.now(),
        objectiveId,
      });
    },
    noteObjectiveClose(objectiveId, result) {
      uploader.enqueue({
        kind: 'objective_close',
        ts: Date.now(),
        objectiveId,
        result,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      reassembler.closeAll();
      await uploader.close().catch((err: unknown) => {
        log('trace-host: uploader close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await proxy.close().catch((err: unknown) => {
        log('trace-host: proxy close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      try {
        await fs.unlink(caCertPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('trace-host: ca cert unlink failed', {
            path: caCertPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      log('trace-host: closed');
    },
  };
}

/**
 * Turn a raw HTTP/1.1 exchange from the reassembler into an
 * `AgentActivityEvent` the uploader can ship. This runs the
 * existing anthropic extractor + redaction pipeline on each
 * exchange individually, so secrets are scrubbed before any bytes
 * leave the runner process.
 */
function exchangeToActivity(exchange: Http1Exchange): AgentActivityEvent | null {
  const httpExchange: HttpExchange = {
    request: {
      method: exchange.request.method,
      url: exchange.request.target,
      host: exchange.request.headers.host ?? exchange.upstream.host,
      headers: exchange.request.headers,
      body: decodeBodyForExchange(exchange.request.decodedBody),
    },
    response: exchange.response
      ? {
          status: exchange.response.status,
          headers: exchange.response.headers,
          body: decodeBodyForExchange(exchange.response.decodedBody),
        }
      : null,
    startedAt: exchange.startedAt,
    endedAt: exchange.endedAt,
  };
  const entries: TraceEntry[] = extractEntries([httpExchange]);
  const entry = entries[0];
  if (!entry) return null;
  const duration = Math.max(0, exchange.endedAt - exchange.startedAt);
  if (entry.kind === 'anthropic_messages') {
    return {
      kind: 'llm_exchange',
      ts: exchange.startedAt,
      duration,
      entry,
    };
  }
  return {
    kind: 'opaque_http',
    ts: exchange.startedAt,
    duration,
    entry,
  };
}

function decodeBodyForExchange(body: Buffer): unknown {
  if (body.length === 0) return null;
  const text = body.toString('utf8');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
  }
  return text;
}
