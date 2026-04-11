/**
 * `@control17/server` library entry.
 *
 * Exposes `runServer()` so the CLI can start the broker in-process
 * without spawning a subprocess. Keeps side effects minimal; the
 * caller owns signal handling and process.exit semantics.
 */

import { Broker } from '@control17/core';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import { SqliteEventLog } from './sqlite-event-log.js';
import { SERVER_VERSION } from './version.js';

export { SERVER_VERSION };

export interface RunServerOptions {
  token: string;
  port: number;
  host?: string;
  dbPath?: string;
  logger?: Logger;
  /** Optional callback once the HTTP listener is bound. */
  onListen?: (info: { address: string; port: number }) => void;
}

export interface RunningServer {
  stop: () => Promise<void>;
  port: number;
  host: string;
}

export async function runServer(options: RunServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const dbPath = options.dbPath ?? ':memory:';
  const log = options.logger ?? defaultLogger;

  const eventLog = new SqliteEventLog(dbPath);
  const broker = new Broker({
    eventLog,
    logger: {
      warn: (msg, ctx) => log.warn(msg, ctx),
      error: (msg, ctx) => log.error(msg, ctx),
    },
  });
  const app = createApp({
    broker,
    token: options.token,
    version: SERVER_VERSION,
    logger: log,
  });

  return new Promise<RunningServer>((resolve) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: host }, (info) => {
      options.onListen?.(info);
      resolve({
        port: info.port,
        host: info.address,
        stop: () =>
          new Promise<void>((stopResolve) => {
            server.close(() => {
              void eventLog.close().finally(() => stopResolve());
            });
          }),
      });
    });
  });
}
