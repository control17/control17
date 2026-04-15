/**
 * Claude Code framework adapter.
 *
 * The adapter knows three things about an agent framework that the
 * generic runner doesn't:
 *
 *   1. Where to find the binary (`findClaudeBinary`)
 *   2. How to configure it to spawn our MCP bridge as an MCP server
 *      (`prepareMcpConfig` — writes a per-run `.mcp.json`)
 *   3. How to spawn it with the right env vars (`spawnAgent`)
 *
 * The only knob the runner cares about on the return side is
 * `McpConfigHandle.restore()`, which the runner calls on every exit
 * path (normal, SIGINT, SIGTERM, uncaughtException, unhandledRejection)
 * to make sure the operator's `.mcp.json` is never left in a modified
 * state.
 *
 * Safety invariants:
 *
 *   - If `.mcp.json` exists but is not valid JSON, we throw WITHOUT
 *     modifying the file. The operator gets a clear error and their
 *     existing file is preserved.
 *   - If the backup write fails, we throw WITHOUT modifying the file.
 *     Same invariant: never write the target until the backup is safe
 *     on disk.
 *   - Atomic write via temp + rename, in the same directory as the
 *     target, so the rename stays on one filesystem.
 *   - `restore()` is idempotent — calling it twice is a no-op on the
 *     second call.
 *   - `restore()` is best-effort in the sense that IO failures are
 *     swallowed with a stderr warning rather than throwing. The
 *     backup file stays on disk in that case so the operator can
 *     manually recover.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as FS,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RUNNER_SOCKET_ENV } from '../ipc.js';

export class ClaudeCodeAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCodeAdapterError';
  }
}

/**
 * Locate the `claude` binary. Checks `$CLAUDE_PATH` first (for
 * developers who built from source or installed to a non-default
 * location), then falls back to `which claude`.
 */
export function findClaudeBinary(): string {
  const fromEnv = process.env.CLAUDE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    if (!existsSync(fromEnv)) {
      throw new ClaudeCodeAdapterError(`CLAUDE_PATH points at ${fromEnv} but no file exists there`);
    }
    return fromEnv;
  }
  try {
    const out = execFileSync('which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out.length === 0) {
      throw new ClaudeCodeAdapterError('which found no claude binary');
    }
    return out;
  } catch (err) {
    throw new ClaudeCodeAdapterError(
      `failed to locate claude binary: ${err instanceof Error ? err.message : String(err)}\n` +
        '  Install claude-code and make sure it is on PATH, or set CLAUDE_PATH explicitly.',
    );
  }
}

/**
 * Shape of a project-level `.mcp.json`. We don't try to model the
 * whole schema — just `mcpServers` as an open record because that's
 * the only key we touch. Any other top-level keys the operator had
 * (e.g. hooks, permissions, etc.) pass through unchanged.
 */
interface McpProjectConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}

export interface PrepareMcpConfigOptions {
  /** Directory in which to read/write the project `.mcp.json`. */
  cwd: string;
  /** Path to the runner's IPC socket to bake into the env block. */
  runnerSocketPath: string;
  /**
   * Name of the `c17` CLI binary the bridge entry should invoke.
   * Defaults to `c17`. Tests override this to point at the built
   * cli's dist/index.js so the bridge subprocess is reachable
   * without requiring `c17` to be globally installed.
   */
  bridgeCommand?: string;
  /** Args to pass to the bridge command. Defaults to `['mcp-bridge']`. */
  bridgeArgs?: string[];
  /**
   * Additional env vars to inject into the `control17` mcp-server
   * entry. Trace-host variables (`ALL_PROXY`, `SSLKEYLOGFILE`,
   * `NODE_OPTIONS`) land here when tracing is enabled — Phase 5.
   */
  extraEnv?: Record<string, string>;
}

export interface McpConfigHandle {
  /**
   * The path of the `.mcp.json` file the adapter is managing. Useful
   * for tests that want to inspect the modified file mid-run.
   */
  readonly path: string;
  /**
   * Restore the operator's `.mcp.json` to its pre-run state. If the
   * file didn't exist before we touched it, delete it. If it did,
   * write the original contents back. Idempotent — safe to call
   * from multiple signal handlers concurrently.
   */
  restore(): void;
}

/**
 * Write our `control17` entry into the project `.mcp.json`, backing
 * up the pre-existing contents first. Returns a handle whose
 * `.restore()` method undoes the modification.
 *
 * Failure modes that leave the original file UNTOUCHED:
 *   - existing `.mcp.json` is not valid JSON
 *   - backup write fails
 *   - staging temp file write fails (before rename)
 */
export function prepareMcpConfig(options: PrepareMcpConfigOptions): McpConfigHandle {
  const mcpConfigPath = resolve(options.cwd, '.mcp.json');
  const existedBefore = existsSync(mcpConfigPath);

  // Parse the existing file (if any) BEFORE we write anything. If
  // it's corrupt, bail out with a clear error — we'd rather the
  // operator fix their JSON than have c17 silently replace it.
  let originalBytes: string | null = null;
  let existingConfig: McpProjectConfig = {};
  if (existedBefore) {
    originalBytes = readFileSync(mcpConfigPath, 'utf8');
    try {
      const parsed = JSON.parse(originalBytes);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingConfig = parsed as McpProjectConfig;
      } else {
        throw new Error('top-level value is not an object');
      }
    } catch (err) {
      throw new ClaudeCodeAdapterError(
        `refusing to modify ${mcpConfigPath}: existing file is not a valid JSON object ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `Fix or delete the file, then re-run.`,
      );
    }
  }

  // Write backup BEFORE touching the target. Backup lives in a
  // pid-scoped tmp dir so concurrent runners don't stomp each other.
  const backupDir = mkdtempSync(join(tmpdir(), 'c17-runner-'));
  const backupPath = join(backupDir, 'mcp.json.bak');
  let backupWritten = false;
  if (existedBefore && originalBytes !== null) {
    try {
      atomicWrite(backupPath, originalBytes);
      backupWritten = true;
    } catch (err) {
      // Clean up the empty backup dir and re-throw.
      try {
        rmdirSync(backupDir);
      } catch {
        /* ignore */
      }
      throw new ClaudeCodeAdapterError(
        `failed to write backup of ${mcpConfigPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Build the merged config. Start from the existing top-level
  // (preserving any non-mcpServers keys the operator had) and
  // insert our `c17` entry into mcpServers. If there's an existing
  // `c17` entry we replace it — the runner socket path is per-run,
  // so a stale entry would be wrong anyway. The key has to be
  // exactly `c17` so `--dangerously-load-development-channels
  // server:c17` (auto-injected by the runner) matches.
  const servers: Record<string, McpServerEntry> =
    existingConfig.mcpServers && typeof existingConfig.mcpServers === 'object'
      ? { ...existingConfig.mcpServers }
      : {};

  servers.c17 = {
    command: options.bridgeCommand ?? 'c17',
    args: options.bridgeArgs ?? ['mcp-bridge'],
    env: {
      [RUNNER_SOCKET_ENV]: options.runnerSocketPath,
      ...(options.extraEnv ?? {}),
    },
  };

  const mergedConfig: McpProjectConfig = {
    ...existingConfig,
    mcpServers: servers,
  };

  // Atomic write the merged config to the target. On failure, the
  // backup is already on disk (if we wrote one) and the original
  // file is untouched (atomicWrite uses temp + rename in the same
  // directory, so a failure leaves the original in place).
  try {
    atomicWrite(mcpConfigPath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
  } catch (err) {
    // Clean up backup since we never got to the point of needing it.
    if (backupWritten) {
      try {
        unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
    }
    try {
      rmdirSync(backupDir);
    } catch {
      /* ignore */
    }
    throw new ClaudeCodeAdapterError(
      `failed to write ${mcpConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      if (existedBefore && originalBytes !== null) {
        atomicWrite(mcpConfigPath, originalBytes);
      } else {
        try {
          unlinkSync(mcpConfigPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') throw err;
        }
      }
    } catch (err) {
      // Best-effort. Backup file stays on disk for manual recovery.
      process.stderr.write(
        `c17: warning: failed to restore ${mcpConfigPath} from backup ${backupPath}: ${
          err instanceof Error ? err.message : String(err)
        }\n` + `  The backup file is still at ${backupPath} — you can copy it back manually.\n`,
      );
      return;
    }
    // Successful restore — clean up the backup.
    if (backupWritten) {
      try {
        unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
    }
    try {
      rmdirSync(backupDir);
    } catch {
      /* ignore */
    }
  };

  return { path: mcpConfigPath, restore };
}

/**
 * Atomically write `body` to `path`. Same pattern as the server's
 * slot-config writer: open a temp file in the same directory with
 * `O_CREAT|O_WRONLY|O_EXCL`, write+fsync+close, then `rename` the
 * temp over the target. Keeps `0o600` permissions on the result since
 * a `.mcp.json` can contain tokens / secrets in its env blocks.
 */
function atomicWrite(path: string, body: string): void {
  const dir = dirname(path);
  const nonce = randomBytes(6).toString('hex');
  const tmp = join(dir, `.c17-mcp-${nonce}.tmp`);
  let fd: number | null = null;
  try {
    // eslint-disable-next-line no-bitwise
    fd = openSync(tmp, FS.O_CREAT | FS.O_WRONLY | FS.O_EXCL, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort: some filesystems (FUSE, Windows layers) ignore chmod
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
