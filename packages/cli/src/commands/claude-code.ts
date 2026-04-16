/**
 * `c17 claude-code` — wrap a Claude Code session in a c17 runner.
 *
 * The runner is the parent process that owns all the heavyweight
 * state: the broker connection, the cached briefing, the SSE forwarder,
 * the objectives tracker, and the IPC socket that the MCP bridge
 * (spawned by claude-code as an MCP server via `.mcp.json`) connects
 * back to.
 *
 * Flow:
 *
 *   1. Validate args + locate the `claude` binary
 *   2. `startRunner()` — fetches briefing, binds the IPC socket, starts
 *      the forwarder. The socket path is passed into the .mcp.json
 *      bridge entry via the `C17_RUNNER_SOCKET` env var.
 *   3. `prepareMcpConfig()` — back up the operator's `.mcp.json` and
 *      write one with a `control17` entry that spawns `c17 mcp-bridge`
 *      (pointed at this runner's socket).
 *   4. Spawn `claude <forwarded args>` with inherited stdio so the
 *      operator interacts with it directly in this terminal.
 *   5. On any exit path (normal, signal, claude crash, ENOENT), run
 *      the teardown: restore `.mcp.json`, shut down the runner, unlink
 *      the socket. Every teardown hook is idempotent so double-firing
 *      on SIGINT → process.exit() is safe.
 *
 * The runner never writes to stdout — stdout belongs to claude. All
 * runner diagnostics go to stderr as structured JSON, which interleaves
 * cleanly with claude's own stderr output.
 *
 * This verb is the operator entry point for Milestone A. Phase 5 adds
 * `--no-trace` / `--trace` flags and wires tracing into the spawn env;
 * for now the only knobs are `--url` / `--token` (with env fallback)
 * and the passthrough args after `--`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PORT, ENV } from '@control17/sdk/protocol';
import {
  ClaudeCodeAdapterError,
  findClaudeBinary,
  type McpConfigHandle,
  prepareMcpConfig,
} from '../runtime/agents/claude-code.js';
import { type RunnerHandle, RunnerStartupError, startRunner } from '../runtime/runner.js';
import { UsageError } from './errors.js';

export { UsageError };

export interface ClaudeCodeCommandInput {
  url?: string;
  token?: string;
  /**
   * Claude args to forward. Everything after `--` on the command line
   * lands here verbatim, plus any positional args we don't recognize.
   */
  claudeArgs: string[];
  /**
   * Directory the runner runs in — this is also where the adapter
   * reads/writes `.mcp.json`. Defaults to `process.cwd()`. Tests
   * override this to isolate from the real repo.
   */
  cwd?: string;
  /** Optional logger override; defaults to stderr JSON lines. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Override the `command` + `args` written into `.mcp.json` for the
   * `control17` MCP server entry. Defaults to `c17 mcp-bridge`, which
   * assumes the `c17` CLI is on PATH in whatever environment claude
   * runs. Tests override this to point at the built dist so they
   * don't depend on a global install.
   */
  bridgeCommand?: string;
  bridgeArgs?: string[];
  /**
   * Disable trace capture. When true, the runner skips starting the
   * SOCKS relay and keylog tailer and leaves the agent's network
   * environment untouched. `c17 claude-code --no-trace` sets this.
   */
  noTrace?: boolean;
}

function defaultLog(msg: string, ctx: Record<string, unknown> = {}): void {
  const record = { ts: new Date().toISOString(), component: 'claude-code', msg, ...ctx };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * Run a Claude Code session wrapped in a c17 runner. Resolves with the
 * exit code of the claude subprocess (so the CLI entry can propagate
 * it via `process.exit`). Teardown is synchronous-best-effort so even
 * a crashing claude leaves the operator's `.mcp.json` in its original
 * state.
 */
export async function runClaudeCodeCommand(input: ClaudeCodeCommandInput): Promise<number> {
  const log = input.log ?? defaultLog;
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const token = input.token ?? process.env[ENV.token];
  if (!token) {
    throw new UsageError(
      `--token or ${ENV.token} is required — run \`c17 setup\` or pass the slot token explicitly`,
    );
  }
  const cwd = input.cwd ?? process.cwd();

  // 1. Locate claude before we touch anything shared — if it's missing
  //    we want to bail without modifying `.mcp.json` or binding a socket.
  let claudeBinary: string;
  try {
    claudeBinary = findClaudeBinary();
  } catch (err) {
    if (err instanceof ClaudeCodeAdapterError) {
      throw new UsageError(err.message);
    }
    throw err;
  }

  // 2. Start the runner. If this fails we haven't touched `.mcp.json`
  //    yet either, so a failure here just propagates cleanly.
  let runner: RunnerHandle;
  try {
    runner = await startRunner({ url, token, log, noTrace: input.noTrace });
  } catch (err) {
    if (err instanceof RunnerStartupError) {
      throw new UsageError(err.message);
    }
    throw err;
  }
  log('claude-code: runner started', {
    socketPath: runner.socketPath,
    callsign: runner.briefing.callsign,
    role: runner.briefing.role,
    team: runner.briefing.squadron,
  });

  // 3. Back up `.mcp.json` and install our bridge entry. Any failure
  //    here tears down the runner before propagating so we don't leave
  //    an orphaned IPC socket.
  let mcpHandle: McpConfigHandle;
  // Auto-detect the bridge command from the currently-running cli
  // process. `process.execPath` is the node binary; `process.argv[1]`
  // is the absolute path to the cli's entry script (dist/index.js in
  // dev, the globally-installed cli in production). Baking these
  // into the `.mcp.json` entry means claude spawns the SAME cli that
  // spawned it — no PATH assumption, works identically whether the
  // operator ran `c17 claude-code` via a shell alias, a pnpm script,
  // or a global npm install. Callers may still override via
  // `input.bridgeCommand`/`bridgeArgs` for tests that want explicit
  // paths.
  const detectedBridgeCommand = input.bridgeCommand ?? process.execPath;
  const detectedBridgeArgs =
    input.bridgeArgs ?? (process.argv[1] ? [process.argv[1], 'mcp-bridge'] : ['mcp-bridge']);

  // Human-readable CWD / .mcp.json disclosure on stderr. Dan's
  // 2026-04-16 audit Part-3 DX item #3: the runner rewrites `.mcp.json`
  // in the current working directory, and operators running from the
  // wrong directory don't notice until they see their MCP servers
  // "disappear" mid-session. Printing the absolute path up-front (and
  // flagging whether we're merging into an existing file or creating a
  // fresh one) makes the surface legible on turn 1.
  const mcpTargetPath = resolve(cwd, '.mcp.json');
  const mcpExistedPriorToRun = existsSync(mcpTargetPath);
  process.stderr.write(
    `c17: runner cwd = ${cwd}\n` +
      `c17: .mcp.json = ${mcpTargetPath}${
        mcpExistedPriorToRun ? ' (found — backing up and merging c17 entry)' : ' (creating)'
      }\n`,
  );

  try {
    mcpHandle = prepareMcpConfig({
      cwd,
      runnerSocketPath: runner.socketPath,
      bridgeCommand: detectedBridgeCommand,
      bridgeArgs: detectedBridgeArgs,
    });
  } catch (err) {
    await runner.shutdown('mcp-config-failed').catch((shutdownErr) => {
      log('claude-code: runner shutdown failed during mcp-config cleanup', {
        error: shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr),
      });
    });
    if (err instanceof ClaudeCodeAdapterError) {
      throw new UsageError(err.message);
    }
    throw err;
  }
  log('claude-code: .mcp.json prepared', { path: mcpHandle.path });

  // 4. Spawn claude. Inherited stdio: the operator sees claude's TUI
  //    directly in this terminal. We also forward SIGINT/SIGTERM to
  //    claude so Ctrl+C cleanly kills the child before we tear down.
  let teardownDone = false;
  const teardown = async (reason: string): Promise<void> => {
    if (teardownDone) return;
    teardownDone = true;
    log('claude-code: tearing down', { reason });
    try {
      mcpHandle.restore();
    } catch (err) {
      log('claude-code: mcp restore threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await runner.shutdown(reason).catch((err) => {
      log('claude-code: runner shutdown threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // Merge trace host env vars (ALL_PROXY / SSLKEYLOGFILE / NODE_OPTIONS)
  // into the child's environment when tracing is on. The trace host
  // returns a delta keyed off the caller's existing env so NODE_OPTIONS
  // gets appended rather than replaced.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (runner.traceHost !== null) {
    const traceEnv = runner.traceHost.envVars(process.env);
    for (const [k, v] of Object.entries(traceEnv)) {
      childEnv[k] = v;
    }
    log('claude-code: trace host armed', {
      proxy: runner.traceHost.proxy.proxyUrl,
      caCert: runner.traceHost.caCertPath,
      warning: 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set on the child — loopback only',
    });
  }

  // Auto-inject the two `--dangerously-*` flags that c17's
  // bridge-based setup fundamentally depends on:
  //
  //   --dangerously-skip-permissions
  //     c17's MCP tools (broadcast, send, objectives_*, etc.) are
  //     supposed to be callable by the agent without a permission
  //     prompt per-call — the squadron authority model is the access
  //     control layer, not per-tool yes/no prompts. Skipping
  //     permissions is therefore a structural requirement, not a
  //     convenience.
  //
  //   --dangerously-load-development-channels server:c17
  //     Enables claude's `claude/channel` experimental capability
  //     against our bridge (keyed `c17` in the written .mcp.json).
  //     Without this, the bridge declares the capability but claude
  //     ignores it and push events never reach the agent — the
  //     whole "events arrive mid-session" value prop collapses.
  //
  // We prepend both flags unconditionally. If the caller explicitly
  // passed either flag already, we de-dup so claude doesn't see it
  // twice. User-supplied args still end up on the command line,
  // just after ours.
  const injectedArgs: string[] = [];
  const userPassedSkipPerms = input.claudeArgs.includes('--dangerously-skip-permissions');
  const userPassedDevChannels = input.claudeArgs.includes(
    '--dangerously-load-development-channels',
  );
  if (!userPassedSkipPerms) {
    injectedArgs.push('--dangerously-skip-permissions');
  }
  if (!userPassedDevChannels) {
    injectedArgs.push('--dangerously-load-development-channels', 'server:c17');
  }
  const finalClaudeArgs = [...injectedArgs, ...input.claudeArgs];

  log('claude-code: spawning claude', {
    binary: claudeBinary,
    args: finalClaudeArgs,
    injected: injectedArgs,
    cwd,
    nodeOptions: childEnv.NODE_OPTIONS,
    sslKeylogFile: childEnv.SSLKEYLOGFILE,
  });
  const child = spawn(claudeBinary, finalClaudeArgs, {
    cwd,
    stdio: 'inherit',
    env: childEnv,
  });

  // Forward signals to claude; claude exiting will trigger our
  // teardown via the 'exit' handler below.
  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    }
  };
  const onSigint = (): void => forwardSignal('SIGINT');
  const onSigterm = (): void => forwardSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  // Last-ditch teardown if the node process itself is dying — we'd
  // rather the operator's `.mcp.json` be restored on an unhandled
  // crash than leave it modified.
  const onUncaught = (err: unknown): void => {
    log('claude-code: uncaught exception', {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    // Synchronous restore is fine here because mcpHandle.restore()
    // doesn't await anything and the rest is best-effort.
    try {
      mcpHandle.restore();
    } catch {
      /* ignore */
    }
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      const resolved = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0);
      resolve(resolved);
    });
    child.on('error', (err) => {
      log('claude-code: failed to spawn claude', {
        error: err instanceof Error ? err.message : String(err),
      });
      resolve(1);
    });
  });

  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);

  await teardown(`claude-exited-${exitCode}`);
  return exitCode;
}

/**
 * Map a signal name to its conventional exit-code offset. Claude
 * dying by SIGTERM should surface as `143` (128 + 15), not `0`.
 * Keeps the offsets small and correct for the signals we actually
 * forward; unknown signals fall back to `null` and we treat the
 * exit as a plain `0` rather than guessing.
 */
function signalNumber(signal: NodeJS.Signals): number | null {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    case 'SIGHUP':
      return 1;
    case 'SIGQUIT':
      return 3;
    default:
      return null;
  }
}
