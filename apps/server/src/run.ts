/**
 * `@control17/server` library entry.
 *
 * Exposes `runServer()` so the CLI can start the broker in-process
 * without spawning a subprocess. Keeps side effects minimal; the
 * caller owns signal handling and process.exit semantics.
 *
 * HTTPS modes:
 *   - off          → plain HTTP on `bindHttp` (default; localhost)
 *   - self-signed  → HTTP/2+TLS on `bindHttps` with a cert stored
 *                    under `<configDir>/certs/`. Optional HTTP→HTTPS
 *                    308 redirect listener on `bindHttp`.
 *   - custom       → HTTP/2+TLS with user-supplied cert/key paths
 *
 * HTTP/2 is the chosen transport because SSE over HTTP/1.1 is capped
 * at 6 connections per browser origin — multi-tab users would lock up
 * the 7th tab. HTTP/2 multiplexes streams over one connection.
 * `allowHTTP1: true` keeps non-HTTP/2 clients working via ALPN.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Broker } from '@control17/core';
import type { Role, Squadron } from '@control17/sdk/types';
import { serve } from '@hono/node-server';
import { type AgentActivityStore, createSqliteAgentActivityStore } from './agent-activity.js';
import { createApp } from './app.js';
import { type DatabaseSyncInstance, openDatabase } from './db.js';
import { createHttp2ServerFactory } from './https/server.js';
import {
  HttpsConfigError,
  type LoadedCert,
  loadCustomCert,
  loadOrGenerateSelfSigned,
} from './https/store.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import { createSqliteObjectivesStore } from './objectives.js';
import { dispatchPush } from './push/dispatch.js';
import { PushSubscriptionStore } from './push/store.js';
import { configureVapid, generateVapidKeys } from './push/vapid.js';
import { SessionStore } from './sessions.js';
import {
  defaultHttpsConfig,
  type HttpsConfig,
  type SlotStore,
  type WebPushConfig,
  writeWebPushConfig,
} from './slots.js';
import { SqliteEventLog } from './sqlite-event-log.js';
import { SERVER_VERSION } from './version.js';

export {
  type AgentActivityStore,
  createSqliteAgentActivityStore,
} from './agent-activity.js';
export { composeBriefing } from './briefing.js';
export { HttpsConfigError, type LoadedCert } from './https/store.js';
export {
  createSqliteObjectivesStore,
  ObjectivesError,
  type ObjectivesStore,
} from './objectives.js';
export { SESSION_COOKIE_NAME, SESSION_TTL_MS, SessionStore } from './sessions.js';
export {
  CONFIG_FILE_COMMENT,
  ConfigNotFoundError,
  createSlotStore,
  defaultConfigPath,
  defaultHttpsConfig,
  enrollSlotTotp,
  exampleConfig,
  type HttpsConfig,
  hashToken,
  type LoadedSlot,
  loadSquadronConfigFromFile,
  SlotLoadError,
  type SlotStore,
  type SquadronConfig,
  teammatesFromStore,
  writeSquadronConfig,
} from './slots.js';
export {
  currentCode as currentTotpCode,
  generateSecret as generateTotpSecret,
  otpauthUri,
  verifyCode as verifyTotpCode,
} from './totp.js';
export {
  createTtyWizardIO,
  type RunWizardOptions,
  runFirstRunWizard,
  type WizardIO,
} from './wizard.js';
export { SERVER_VERSION };

export interface RunServerOptions {
  /** Fully-loaded slot store — the caller is responsible for building this. */
  slots: SlotStore;
  /** Squadron config (name, mission, brief). */
  squadron: Squadron;
  /** Role definitions keyed by role name. */
  roles: Record<string, Role>;
  /**
   * HTTPS configuration. Omit or pass a mode:'off' config to run
   * plain HTTP. For self-signed mode the caller must also pass
   * `configDir` so we know where to persist the cert.
   */
  https?: HttpsConfig;
  /**
   * Existing VAPID credentials from the squadron config file. When
   * `null` or omitted AND `configPath` is set, runServer() will
   * auto-generate a fresh keypair and persist it back to the
   * config file. Set explicitly to skip Web Push entirely.
   */
  webPush?: WebPushConfig | null;
  /**
   * Path to the squadron config file — required only when auto-generating
   * VAPID keys on first boot, since we need to know where to write
   * the new `webPush` block. Loaders (`loadSquadronConfigFromFile` +
   * the CLI entry) already know this path; lib consumers that
   * construct RunServerOptions by hand can pass it explicitly.
   */
  configPath?: string;
  /**
   * Directory to store cert files in when `https.mode === 'self-signed'`.
   * Required for self-signed mode, ignored otherwise. Typically
   * `dirname(configPath)` so certs sit next to the squadron config.
   */
  configDir?: string;
  /**
   * Absolute path to the built `@control17/web` bundle to serve as
   * the SPA. Defaults to `<dist>/../public` — i.e., `apps/server/public`
   * relative to the built `run.js`. Pass `null` to disable SPA
   * serving entirely (useful for tests and machine-only deployments).
   */
  publicRoot?: string | null;
  /**
   * Convenience override for the HTTP listener port. When provided
   * and `https.mode === 'off'`, this wins over `https.bindHttp`.
   * Ignored when HTTPS is active (configure ports via `https.bindHttp`
   * and `https.bindHttps` directly in that case). Primarily for
   * tests and the existing CLI env-var path.
   */
  port?: number;
  host?: string;
  dbPath?: string;
  logger?: Logger;
  /**
   * Optional callback once all listeners are bound. Fires once per
   * run with info about the primary (HTTPS if enabled, else HTTP)
   * listener.
   */
  onListen?: (info: ListenInfo) => void;
}

export interface ListenInfo {
  address: string;
  port: number;
  /** `http` or `https` — drives how the banner formats the URL. */
  protocol: 'http' | 'https';
  /** Populated for https modes. */
  cert?: LoadedCert;
  /** Port of the parallel HTTP→HTTPS redirect listener, if any. */
  redirectHttpPort?: number;
}

export interface RunningServer {
  stop: () => Promise<void>;
  /** Primary listener port — HTTPS when enabled, else HTTP. */
  port: number;
  host: string;
  protocol: 'http' | 'https';
}

/**
 * Resolve the default public dir. When `run.ts` is bundled to
 * `apps/server/dist/run.js`, `../public` points at `apps/server/public`
 * — the directory Vite builds the web package into. In dev (not
 * bundled) the same relative path resolves under `apps/server/src/`
 * which won't exist, and the static middleware will simply not
 * register its routes. That's the desired behavior: use Vite's dev
 * server on :5173 and proxy to the API instead.
 */
function defaultPublicRoot(): string {
  return pathResolve(dirname(fileURLToPath(import.meta.url)), '../public');
}

export async function runServer(options: RunServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const dbPath = options.dbPath ?? ':memory:';
  const log = options.logger ?? defaultLogger;
  // If the caller passed a top-level `port` and HTTPS is off, fold it
  // into the https block as bindHttp. Keeps the existing CLI + test
  // entry points working without threading a full https config.
  const httpsInput: HttpsConfig = options.https ?? defaultHttpsConfig();
  const https: HttpsConfig =
    options.port !== undefined && httpsInput.mode === 'off'
      ? { ...httpsInput, bindHttp: options.port }
      : httpsInput;

  // Open the DB once and share it across modules. `node:sqlite` is
  // single-connection-per-process; each helper gets a handle into the
  // same underlying Database, not a new connection.
  const db: DatabaseSyncInstance = openDatabase(dbPath);
  const eventLog = new SqliteEventLog(db);
  const sessions = new SessionStore(db);
  const pushStore = new PushSubscriptionStore(db);
  const objectivesStore = createSqliteObjectivesStore(db);
  const agentActivityStore: AgentActivityStore = createSqliteAgentActivityStore(db);
  sessions.purgeExpired();

  // VAPID lifecycle: either the caller provided keys (from the
  // squadron config file), or we generate a fresh set and persist them
  // back to disk so subsequent restarts reuse the same credentials.
  // Skipping entirely is possible by passing webPush: null AND
  // omitting configPath — tests do this.
  let webPush: WebPushConfig | null = options.webPush ?? null;
  if (webPush === null && options.configPath) {
    webPush = generateVapidKeys();
    try {
      writeWebPushConfig(options.configPath, webPush);
      log.info('VAPID keys generated and persisted', {
        path: options.configPath,
      });
    } catch (err) {
      log.warn('failed to persist generated VAPID keys', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through — keys stay in memory for this run; next restart
      // regenerates. Degrades gracefully rather than erroring out.
    }
  }
  if (webPush !== null) {
    configureVapid(webPush);
  }

  const broker = new Broker({
    eventLog,
    logger: {
      warn: (msg, ctx) => log.warn(msg, ctx),
      error: (msg, ctx) => log.error(msg, ctx),
    },
  });
  broker.seedSlots(options.slots.slots());

  // Shutdown fan-out: when stop() is called, abort this controller;
  // every open SSE stream listens and tears down. Without this, idle
  // streams pin the HTTP server open and Node's server.close() waits
  // indefinitely.
  const shutdownController = new AbortController();

  // Load (or generate) TLS material up front so we can fail boot
  // early if the cert is unreadable.
  let cert: LoadedCert | null = null;
  if (https.mode === 'self-signed') {
    if (!options.configDir) {
      throw new HttpsConfigError(
        'runServer: https.mode = self-signed requires options.configDir to persist the cert',
      );
    }
    cert = await loadOrGenerateSelfSigned({
      configDir: options.configDir,
      lanIp: https.selfSigned.lanIp,
      validityDays: https.selfSigned.validityDays,
      regenerateIfExpiringWithin: https.selfSigned.regenerateIfExpiringWithin,
    });
  } else if (https.mode === 'custom') {
    if (!https.custom.certPath || !https.custom.keyPath) {
      throw new HttpsConfigError(
        'runServer: https.mode = custom requires both https.custom.certPath and https.custom.keyPath',
      );
    }
    cert = loadCustomCert({
      certPath: https.custom.certPath,
      keyPath: https.custom.keyPath,
    });
  }

  const secureCookies = https.mode !== 'off';
  // Explicit null = opt out. Undefined = use the computed default.
  const publicRoot =
    options.publicRoot === null ? undefined : (options.publicRoot ?? defaultPublicRoot());

  /**
   * Liveness lookup for the push policy — a callsign is "live" if
   * the broker registry reports at least one connected subscriber.
   * `broker.listAgents()` is a cheap snapshot; we call it once per
   * push dispatch (not per recipient) in practice, since dispatch
   * builds its own view.
   */
  const isLive = (callsign: string): boolean => {
    const agents = broker.listAgents();
    for (const a of agents) {
      if (a.agentId === callsign) return a.connected > 0;
    }
    return false;
  };

  // Push fanout hook: called by app.ts after every successful push,
  // runs the policy + dispatch path in the background. We use
  // `queueMicrotask` in app.ts, so this is already off the hot path
  // — just keep the handler itself cheap and catch errors.
  const onPushed = webPush
    ? (message: import('@control17/sdk/types').Message) => {
        void dispatchPush(message, {
          sessions: pushStore,
          slots: options.slots,
          logger: log,
          isLive,
        }).catch((err) => {
          log.warn('push dispatch crashed', {
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    : undefined;

  const app = createApp({
    broker,
    slots: options.slots,
    sessions,
    squadron: options.squadron,
    roles: options.roles,
    objectives: objectivesStore,
    agentActivity: agentActivityStore,
    version: SERVER_VERSION,
    logger: log,
    secureCookies,
    shutdownSignal: shutdownController.signal,
    ...(publicRoot !== undefined ? { publicRoot } : {}),
    ...(webPush !== null
      ? {
          pushStore,
          vapidPublicKey: webPush.vapidPublicKey,
        }
      : {}),
    ...(onPushed !== undefined ? { onPushed } : {}),
  });

  // Optional HTTP→HTTPS redirect listener. Only spun up when HTTPS
  // is active AND the user hasn't disabled it. Kept deliberately tiny
  // — no Hono, no middleware, just a 308 to the canonical https URL.
  let redirectServer: HttpServer | null = null;
  if (cert !== null && https.redirectHttpToHttps) {
    redirectServer = createHttpServer((req, res) => {
      const hostHeader = (req.headers.host ?? host).replace(/:\d+$/, '');
      const target = `https://${hostHeader}:${https.bindHttps}${req.url ?? '/'}`;
      res.writeHead(308, { Location: target });
      res.end();
    });
    // bind synchronously — a failure here is a hard config error (port in use)
    await new Promise<void>((resolve, reject) => {
      redirectServer?.once('error', reject);
      redirectServer?.listen(https.bindHttp, host, () => resolve());
    });
  }

  return new Promise<RunningServer>((resolve) => {
    const serveOptions: Parameters<typeof serve>[0] = {
      fetch: app.fetch,
      port: cert !== null ? https.bindHttps : https.bindHttp,
      hostname: host,
    };
    if (cert !== null) {
      const factory = createHttp2ServerFactory({ cert: cert.cert, key: cert.key });
      // @hono/node-server accepts `createServer` + `serverOptions`.
      // Type cast needed because ServeOptions is a union whose HTTP/2
      // branch isn't surfaced in the public type yet.
      (serveOptions as unknown as Record<string, unknown>).createServer = factory.createServer;
      (serveOptions as unknown as Record<string, unknown>).serverOptions = factory.serverOptions;
    }

    const server = serve(serveOptions, (info) => {
      const protocol: 'http' | 'https' = cert !== null ? 'https' : 'http';
      const listenInfo: ListenInfo = {
        address: info.address,
        port: info.port,
        protocol,
      };
      if (cert !== null) listenInfo.cert = cert;
      if (redirectServer !== null) {
        listenInfo.redirectHttpPort = https.bindHttp;
      }
      options.onListen?.(listenInfo);
      resolve({
        port: info.port,
        host: info.address,
        protocol,
        stop: () =>
          new Promise<void>((stopResolve) => {
            // Abort all live SSE streams first so close() can complete.
            shutdownController.abort();
            const closeRedirect = () =>
              new Promise<void>((r) => {
                if (redirectServer === null) return r();
                redirectServer.close(() => r());
              });
            server.close(() => {
              void closeRedirect().finally(() => {
                void eventLog.close().finally(() => {
                  try {
                    db.close();
                  } catch (err) {
                    log.warn('db close failed', {
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                  stopResolve();
                });
              });
            });
            // Best-effort: forcibly drop any remaining open sockets
            // after a short grace period in case a stream's cleanup
            // is slow. Node's `Server.closeAllConnections` is an
            // escape hatch; both main + redirect servers support it.
            setTimeout(() => {
              const maybeCloseAll = (server as unknown as { closeAllConnections?: () => void })
                .closeAllConnections;
              maybeCloseAll?.call(server);
              redirectServer?.closeAllConnections();
            }, 500).unref();
          }),
      });
    });
  });
}
