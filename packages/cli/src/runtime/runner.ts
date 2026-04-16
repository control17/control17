/**
 * The c17 runner — the parent process that owns a c17 session.
 *
 * The runner holds all the heavyweight state for a single agent run:
 *
 *   - the broker `Client` (authenticated to the c17 server)
 *   - the cached `BriefingResponse` (callsign, role, authority, squadron,
 *     mission, initial open objectives)
 *   - the live SSE forwarder (chat + objective events from the broker)
 *   - the objectives tracker (keeps the "open objectives" list fresh so
 *     tool descriptions can refresh via `tools/list_changed`)
 *   - the IPC server that the MCP bridge (a stdio MCP server spawned
 *     by the agent) connects to over a Unix domain socket
 *
 * The runner speaks the IPC protocol defined in `ipc.ts`. When a
 * bridge connects, the runner waits for `mcp_request` frames and
 * dispatches them to the existing tool handlers (`handleToolCall` +
 * `defineTools`), then replies with `mcp_response` frames. Inbound
 * SSE events from the broker are pushed out to the connected bridge
 * as `mcp_notification` frames, and `tools/list_changed` fires are
 * emitted the same way.
 *
 * Runners are single-bridge. If a second bridge connects while one
 * is already attached, the newer connection wins and the older one
 * is dropped with a `shutdown` frame. This matches the "one agent
 * per runner" constraint for v1 — multiple agents = multiple runner
 * processes.
 *
 * Lifecycle:
 *   startRunner()      → fetches briefing, binds the IPC socket,
 *                        starts the forwarder, returns a handle
 *   handle.waitClosed  → resolves when the runner has fully torn down
 *   handle.shutdown()  → graceful shutdown (abort forwarder, drop
 *                        bridge connection, close the IPC server,
 *                        unlink the socket)
 *
 * This module is deliberately transport-agnostic about MCP: we do
 * NOT import `StdioServerTransport` or construct an MCP `Server`
 * here. That lives in `bridge.ts`. The runner just dispatches tool
 * requests and forwards channel events — the actual JSON-RPC envelope
 * handling happens at the bridge process.
 */

import { unlinkSync } from 'node:fs';
import type { Socket } from 'node:net';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { createInterface } from 'node:readline';
import { Client as BrokerClient } from '@control17/sdk/client';
import type { BriefingResponse, Objective } from '@control17/sdk/types';
import { CLI_VERSION } from '../version.js';
import { type ForwarderNotificationSink, runForwarder } from './forwarder.js';
import {
  defaultSocketPath,
  encodeFrame,
  type IpcFrame,
  type IpcMcpNotification,
  type IpcMcpResponse,
  parseFrame,
} from './ipc.js';
import { createObjectivesTracker } from './objectives-tracker.js';
import { defineTools, handleToolCall } from './tools.js';
import { startTraceHost, type TraceHost } from './trace/host.js';

export class RunnerStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerStartupError';
  }
}

export interface RunnerOptions {
  url: string;
  token: string;
  /**
   * Where the runner binds its IPC socket. Defaults to a pid-scoped
   * path under `$TMPDIR`. Override for tests that want a predictable
   * location or for running multiple runners with deterministic paths.
   */
  socketPath?: string;
  /**
   * Optional logger override. Defaults to structured JSON lines on
   * stderr. The runner does NOT write to stdout — stdout is reserved
   * for the bridge process to speak MCP cleanly.
   */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Controls how the runner behaves when a second bridge connects
   * while one is already attached. Default: drop the older and
   * attach the newer. Tests that want to observe the old connection
   * being dropped can use this; production always uses the default.
   */
  onSecondBridge?: 'displace-old' | 'reject-new';
  /**
   * Disable the trace host entirely — no SOCKS relay, no keylog, no
   * span buffering. The returned `RunnerHandle.traceHost` will be
   * `null`. Default: tracing enabled. `c17 claude-code --no-trace`
   * sets this to `true`.
   */
  noTrace?: boolean;
}

export interface RunnerHandle {
  /** The path the IPC socket is bound at. */
  readonly socketPath: string;
  /** The briefing fetched at startup. Frozen. */
  readonly briefing: BriefingResponse;
  /**
   * The live trace host owning the SOCKS relay + keylog + span
   * buffer. `null` when the runner was started with `noTrace: true`.
   * `c17 claude-code` reads this to know whether to bake `ALL_PROXY`
   * and friends into the agent child's environment.
   */
  readonly traceHost: TraceHost | null;
  /**
   * Graceful shutdown. Aborts the SSE forwarder, closes the active
   * bridge connection (if any), closes the IPC server, and unlinks
   * the socket. Idempotent — calling twice is safe. Awaiting on
   * `waitClosed` after this resolves when teardown is done.
   */
  shutdown(reason?: string): Promise<void>;
  /** Resolves when the runner has fully torn down. */
  readonly waitClosed: Promise<void>;
}

function defaultLog(msg: string, ctx: Record<string, unknown> = {}): void {
  const record = { ts: new Date().toISOString(), component: 'runner', msg, ...ctx };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * Start the runner: fetch briefing, bind the IPC socket, start the
 * SSE forwarder. Returns a handle the caller can use to wait for
 * completion or trigger a graceful shutdown. Throws
 * `RunnerStartupError` if required inputs are missing or the broker
 * briefing call fails.
 */
export async function startRunner(options: RunnerOptions): Promise<RunnerHandle> {
  const log = options.log ?? defaultLog;
  if (!options.url || options.url.length === 0) {
    throw new RunnerStartupError('url is required');
  }
  if (!options.token || options.token.length === 0) {
    throw new RunnerStartupError('token is required');
  }

  const brokerClient = new BrokerClient({ url: options.url, token: options.token });

  let briefing: BriefingResponse;
  try {
    briefing = await brokerClient.briefing();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // When the failure looks like a connection problem (broker unreachable)
    // we surface a plain-English hint pointing at the most common cause —
    // `c17 serve` isn't running, or `--url` is pointing somewhere else.
    // Token/auth failures surface a different shape (4xx from the HTTP
    // layer) and fall through to the original message so we don't
    // mislead the operator with a "start your broker" hint when the
    // broker is actually up and rejecting them.
    const looksLikeConnectFailure =
      /ECONNREFUSED|fetch failed|socket hang up|ENOTFOUND|getaddrinfo|ETIMEDOUT/i.test(errMsg);
    const hint = looksLikeConnectFailure
      ? `\n  hint: is \`c17 serve\` running at ${options.url}? ` +
        `(start it, or pass --url to point elsewhere)`
      : '';
    throw new RunnerStartupError(
      `briefing failed against ${options.url}: ${errMsg}${hint}`,
    );
  }

  // Live open-objectives snapshot — mutated as the objectives tracker
  // refreshes from SSE events, read on every `defineTools` invocation
  // so tool descriptions reflect the current plate.
  let openObjectives: Objective[] = briefing.openObjectives;

  // At most one active bridge connection at a time. When a second
  // bridge connects, the older one gets dropped (default) or the
  // new one is refused (test-only).
  let activeBridge: BridgeConnection | null = null;
  const secondBridgePolicy = options.onSecondBridge ?? 'displace-old';

  const abortController = new AbortController();
  const socketPath = options.socketPath ?? defaultSocketPath();

  // Optional trace host: MITM TLS proxy + per-session CA + streaming
  // activity uploader. Skipped entirely when `noTrace` is set — tests
  // and CI use this to avoid binding ephemeral ports and writing tmp
  // files.
  let traceHost: TraceHost | null = null;
  if (!options.noTrace) {
    try {
      traceHost = await startTraceHost({
        brokerClient,
        callsign: briefing.callsign,
        log,
      });
    } catch (err) {
      log('runner: trace host failed to start — continuing without tracing', {
        error: err instanceof Error ? err.message : String(err),
      });
      traceHost = null;
    }
  }

  // Pre-emptively remove any stale socket from a previous crashed
  // runner at the same path. Unix domain sockets are files; a stale
  // one at the bind target causes EADDRINUSE on listen().
  try {
    unlinkSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('runner: stale socket cleanup failed', {
        socketPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ipcServer: NetServer = createNetServer((socket) => {
    log('runner: bridge connecting');

    if (activeBridge !== null) {
      if (secondBridgePolicy === 'reject-new') {
        log('runner: rejecting second bridge (policy: reject-new)');
        socket.write(encodeFrame({ kind: 'error', message: 'runner already attached' }));
        socket.end();
        return;
      }
      log('runner: displacing previous bridge (policy: displace-old)');
      activeBridge.close('displaced-by-new-bridge');
    }

    const conn = createBridgeConnection(socket, {
      handleRequest: async (frame) => {
        return handleMcpRequest(frame, briefing, () => openObjectives, brokerClient);
      },
      onClose: () => {
        if (activeBridge === conn) activeBridge = null;
        log('runner: bridge disconnected');
      },
      log,
    });
    activeBridge = conn;
    log('runner: bridge attached');
  });

  const listening = new Promise<void>((resolve, reject) => {
    ipcServer.once('listening', () => resolve());
    ipcServer.once('error', (err) => reject(err));
  });
  ipcServer.listen(socketPath);
  try {
    await listening;
  } catch (err) {
    throw new RunnerStartupError(
      `runner: failed to bind IPC socket at ${socketPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  log('runner: IPC socket bound', {
    socketPath,
    callsign: briefing.callsign,
    role: briefing.role,
    authority: briefing.authority,
    openObjectives: briefing.openObjectives.length,
    version: CLI_VERSION,
  });

  // Objectives tracker: refresh the open set when SSE objective
  // events arrive. On every diff, emit objective_open/close
  // events into the agent's activity stream so the server can
  // slice traces by time range later. Also emit
  // `tools/list_changed` out to any connected bridge so the MCP
  // client re-reads tool descriptions.
  const tracker = createObjectivesTracker({
    brokerClient,
    callsign: briefing.callsign,
    log,
    onRefresh: (next) => {
      if (traceHost !== null) {
        const prevIds = new Set(openObjectives.map((o) => o.id));
        const nextIds = new Set(next.map((o) => o.id));
        for (const id of nextIds) {
          if (!prevIds.has(id)) {
            traceHost.noteObjectiveOpen(id);
            log('runner: objective open recorded', { objectiveId: id });
          }
        }
        for (const id of prevIds) {
          if (!nextIds.has(id)) {
            // We can't tell done vs cancelled vs reassigned from
            // the tracker alone — the objective is just "no longer
            // open." The server has the terminal state in its
            // audit log, so consumers that care can join on
            // objective id. Stamp `done` as the default — it's
            // the most common outcome and it's a hint, not a
            // source of truth.
            traceHost.noteObjectiveClose(id, 'done');
            log('runner: objective close recorded', { objectiveId: id });
          }
        }
      }
      openObjectives = next;
      if (activeBridge !== null) {
        activeBridge.sendNotification({
          kind: 'mcp_notification',
          method: 'notifications/tools/list_changed',
          params: undefined,
        });
      }
    },
  });

  // Record open markers for whatever the slot already had at
  // startup, so in-flight objectives get bracketed in the activity
  // stream from the first uploaded event.
  if (traceHost !== null) {
    for (const obj of briefing.openObjectives) {
      traceHost.noteObjectiveOpen(obj.id);
    }
  }

  // SSE forwarder: subscribe to the broker for this slot's callsign,
  // wrap inbound messages as `notifications/claude/channel`
  // notifications, and send them to the bridge over IPC. This is the
  // substitute for the MCP `Server.notification()` call that used to
  // live inside the link — the bridge side converts incoming
  // notification frames into real MCP notifications on the agent's
  // stdio transport.
  const forwarderPromise = runForwarder({
    server: forwarderShim((method, params) => {
      if (activeBridge === null) {
        // No bridge attached — drop. Messages still land in server
        // history; agent reads them via `recent` when it reconnects.
        return;
      }
      activeBridge.sendNotification({ kind: 'mcp_notification', method, params });
    }),
    brokerClient,
    callsign: briefing.callsign,
    signal: abortController.signal,
    log,
    onObjectiveEvent: (message) => {
      tracker.refresh(message);
    },
  });
  // Forwarder never throws outward — it catches its own errors and
  // just logs them. Attach a tail-catch anyway in case a refactor
  // breaks that invariant.
  forwarderPromise.catch((err) => {
    log('runner: forwarder loop crashed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  let closed = false;
  let resolveClosed: () => void = () => {};
  const waitClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = async (reason?: string): Promise<void> => {
    if (closed) return;
    closed = true;
    log('runner: shutdown requested', reason ? { reason } : {});
    abortController.abort();
    if (activeBridge !== null) {
      activeBridge.close(reason ?? 'runner-shutdown');
      activeBridge = null;
    }
    await new Promise<void>((resolve) => {
      ipcServer.close(() => resolve());
    });
    try {
      unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
    // Let the forwarder finish its wind-down (abort already fired).
    await forwarderPromise.catch((err) => {
      log('runner: forwarder wind-down failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    if (traceHost !== null) {
      await traceHost.close().catch((err) => {
        log('runner: trace host close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    resolveClosed();
  };

  return {
    socketPath,
    briefing,
    traceHost,
    shutdown,
    waitClosed,
  };
}

/**
 * Dispatch a single `mcp_request` frame to the tool handlers. Returns
 * the response frame the runner should send back.
 *
 * We support two MCP methods here, mirroring what the old link
 * handled: `tools/list` and `tools/call`. Any other method comes
 * back as an error frame. The MCP SDK's type system is irrelevant
 * on this side of the IPC — we're looking at raw JSON.
 */
async function handleMcpRequest(
  frame: { id: number; method: string; params: Record<string, unknown> | undefined },
  briefing: BriefingResponse,
  getOpenObjectives: () => Objective[],
  brokerClient: BrokerClient,
): Promise<IpcMcpResponse> {
  try {
    if (frame.method === 'tools/list') {
      const tools = defineTools(briefing, getOpenObjectives());
      return { kind: 'mcp_response', id: frame.id, result: { tools } };
    }
    if (frame.method === 'tools/call') {
      const params = frame.params as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof params?.name === 'string' ? params.name : '';
      const args =
        params?.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : undefined;
      const result = await handleToolCall(name, args, brokerClient, briefing);
      return { kind: 'mcp_response', id: frame.id, result };
    }
    return {
      kind: 'mcp_response',
      id: frame.id,
      error: { code: -32601, message: `method not found: ${frame.method}` },
    };
  } catch (err) {
    return {
      kind: 'mcp_response',
      id: frame.id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Bridge connection wrapper ─────────────────────────────────────

interface BridgeConnection {
  sendNotification(frame: IpcMcpNotification): void;
  close(reason?: string): void;
}

interface BridgeConnectionDeps {
  handleRequest: (frame: {
    id: number;
    method: string;
    params: Record<string, unknown> | undefined;
  }) => Promise<IpcMcpResponse>;
  onClose: () => void;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Wrap a raw IPC socket into the runner's bridge-facing API. Handles
 * line-delimited framing on the receive side, serializes outbound
 * frames on the send side, and routes inbound `mcp_request` frames to
 * `deps.handleRequest`.
 */
function createBridgeConnection(socket: Socket, deps: BridgeConnectionDeps): BridgeConnection {
  let closed = false;
  const rl = createInterface({ input: socket, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const frame = parseFrame(line);
    if (frame === null) {
      deps.log('runner: dropped malformed IPC frame', { lineLength: line.length });
      return;
    }
    if (frame.kind === 'mcp_request') {
      void deps
        .handleRequest({
          id: frame.id,
          method: frame.method,
          params: frame.params,
        })
        .then((response) => {
          send(response);
        })
        .catch((err) => {
          deps.log('runner: handler rejected', {
            error: err instanceof Error ? err.message : String(err),
          });
          send({
            kind: 'mcp_response',
            id: frame.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        });
      return;
    }
    if (frame.kind === 'shutdown') {
      deps.log('runner: bridge sent shutdown', { reason: frame.reason });
      cleanup();
      return;
    }
    if (frame.kind === 'error') {
      deps.log('runner: bridge reported error', { message: frame.message });
      return;
    }
    // Responses and notifications from the bridge side aren't
    // expected on the runner side of the protocol for v1.
    deps.log('runner: unexpected frame kind from bridge', { kind: frame.kind });
  });

  const send = (frame: IpcFrame): void => {
    if (closed) return;
    try {
      socket.write(encodeFrame(frame));
    } catch (err) {
      deps.log('runner: write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      cleanup();
    }
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    try {
      rl.close();
    } catch {
      /* ignore */
    }
    try {
      socket.end();
      socket.destroy();
    } catch {
      /* ignore */
    }
    deps.onClose();
  };

  socket.on('close', cleanup);
  socket.on('error', (err) => {
    deps.log('runner: socket error', {
      error: err instanceof Error ? err.message : String(err),
    });
    cleanup();
  });

  return {
    sendNotification(frame) {
      send(frame);
    },
    close(reason) {
      if (closed) return;
      send({ kind: 'shutdown', reason });
      cleanup();
    },
  };
}

// ─── Forwarder shim ─────────────────────────────────────────────────

/**
 * The existing `runForwarder` (in `forwarder.ts`) expects an MCP
 * `Server` with a `notification(args)` method. When the runner
 * doesn't own a real MCP server (it delegates that to the bridge),
 * we stub one out: a plain object whose `notification` implementation
 * translates the MCP-style call into an IPC `mcp_notification` frame
 * via a callback.
 *
 * We keep the forwarder's interface unchanged so Phase 5 (trace
 * capture) can reuse it verbatim — the trace layer wraps the forwarder
 * and doesn't care whether its server is real MCP or a runner shim.
 */
function forwarderShim(
  send: (method: string, params: Record<string, unknown>) => void,
): ForwarderNotificationSink {
  return {
    notification: async (args) => {
      send(args.method, args.params);
    },
  };
}
