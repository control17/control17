/**
 * Claude Code adapter unit tests.
 *
 * Covers the `.mcp.json` backup/restore contract for prepareMcpConfig:
 *
 *   - Fresh creation when the file was absent
 *   - Merge into an existing file, preserving other top-level keys and
 *     other mcpServers entries
 *   - Restore paths for all three "existed before" states:
 *       (a) file didn't exist      → restore deletes it
 *       (b) file existed, no c17    → restore rewrites original bytes
 *       (c) file had a stale c17    → restore rewrites original bytes
 *   - Refusal to modify when the existing file is corrupt JSON
 *   - Restore is idempotent — calling it twice is a no-op on the second
 *
 * Every test uses a fresh tmpdir so they don't stomp each other and
 * tests never touch the repo's real `.mcp.json`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapterError, prepareMcpConfig } from '../../src/runtime/agents/claude-code.js';

describe('prepareMcpConfig', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'c17-adapter-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates a fresh .mcp.json when none existed, then restore deletes it', () => {
    const configPath = join(cwd, '.mcp.json');
    expect(existsSync(configPath)).toBe(false);

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/fake-runner.sock',
    });

    expect(handle.path).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written.mcpServers.c17).toEqual({
      command: 'c17',
      args: ['mcp-bridge'],
      env: { C17_RUNNER_SOCKET: '/tmp/fake-runner.sock' },
    });

    handle.restore();
    expect(existsSync(configPath)).toBe(false);
  });

  it('merges into an existing file and preserves other entries + top-level keys', () => {
    const configPath = join(cwd, '.mcp.json');
    const original = {
      hooks: { preToolUse: 'echo hi' },
      mcpServers: {
        other: {
          command: 'node',
          args: ['some-other-mcp.js'],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), 'utf8');

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/fake.sock',
      bridgeCommand: '/abs/path/to/cli.js',
      bridgeArgs: ['mcp-bridge', '--trace'],
      extraEnv: { ALL_PROXY: 'socks5://127.0.0.1:9050' },
    });

    const merged = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(merged.hooks).toEqual({ preToolUse: 'echo hi' });
    expect(merged.mcpServers.other).toEqual({
      command: 'node',
      args: ['some-other-mcp.js'],
    });
    expect(merged.mcpServers.c17).toEqual({
      command: '/abs/path/to/cli.js',
      args: ['mcp-bridge', '--trace'],
      env: {
        C17_RUNNER_SOCKET: '/tmp/fake.sock',
        ALL_PROXY: 'socks5://127.0.0.1:9050',
      },
    });

    handle.restore();
    const afterRestore = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(afterRestore).toEqual(original);
  });

  it('replaces a stale c17 entry and restores the original on teardown', () => {
    const configPath = join(cwd, '.mcp.json');
    const original = {
      mcpServers: {
        c17: {
          command: 'c17',
          args: ['mcp-bridge'],
          env: { C17_RUNNER_SOCKET: '/tmp/OLD.sock' },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), 'utf8');

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/NEW.sock',
    });

    const merged = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(merged.mcpServers.c17.env.C17_RUNNER_SOCKET).toBe('/tmp/NEW.sock');

    handle.restore();
    const afterRestore = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(afterRestore).toEqual(original);
  });

  it('refuses to modify a corrupt .mcp.json and leaves the file untouched', () => {
    const configPath = join(cwd, '.mcp.json');
    const corrupt = '{ "mcpServers": { not valid json';
    writeFileSync(configPath, corrupt, 'utf8');

    expect(() =>
      prepareMcpConfig({
        cwd,
        runnerSocketPath: '/tmp/x.sock',
      }),
    ).toThrow(ClaudeCodeAdapterError);

    expect(readFileSync(configPath, 'utf8')).toBe(corrupt);
  });

  it('refuses to modify when top-level is not an object (e.g. array)', () => {
    const configPath = join(cwd, '.mcp.json');
    const arrayJson = '[1, 2, 3]';
    writeFileSync(configPath, arrayJson, 'utf8');

    expect(() =>
      prepareMcpConfig({
        cwd,
        runnerSocketPath: '/tmp/x.sock',
      }),
    ).toThrow(ClaudeCodeAdapterError);

    expect(readFileSync(configPath, 'utf8')).toBe(arrayJson);
  });

  it('restore is idempotent — second call is a no-op', () => {
    const configPath = join(cwd, '.mcp.json');
    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/x.sock',
    });
    expect(existsSync(configPath)).toBe(true);

    handle.restore();
    expect(existsSync(configPath)).toBe(false);

    // Recreate a different file at the same path — restore should NOT
    // touch it, since we've already restored once.
    writeFileSync(configPath, '{"unrelated":true}', 'utf8');
    handle.restore();
    expect(readFileSync(configPath, 'utf8')).toBe('{"unrelated":true}');
  });

  it('injects default bridge command + args when options omit them', () => {
    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/defaults.sock',
    });
    const merged = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    expect(merged.mcpServers.c17.command).toBe('c17');
    expect(merged.mcpServers.c17.args).toEqual(['mcp-bridge']);
    handle.restore();
  });
});
