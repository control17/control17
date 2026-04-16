/**
 * `c17` — operator CLI for control17.
 *
 * Subcommands:
 *   c17 setup       — first-run wizard: create team config + enroll TOTP
 *   c17 enroll      — (re-)enroll a slot for web UI login (TOTP)
 *   c17 claude-code — spawn claude-code wrapped in a c17 runner
 *   c17 push        — push an event to a teammate or broadcast
 *   c17 roster      — list slots and connection state
 *   c17 objectives  — list / view / mutate squadron objectives
 *   c17 serve       — run a local broker (optional peer: @control17/server)
 *
 * The internal `c17 mcp-bridge` verb is hidden from the top-level
 * help; agents spawn it via `.mcp.json` and it connects back to the
 * runner over UDS.
 *
 * Global env vars (defaults):
 *   C17_URL       = http://127.0.0.1:8717
 *   C17_TOKEN     (required for claude-code / push / roster / objectives)
 */

import { Client } from '@control17/sdk/client';
import { DEFAULT_PORT, ENV } from '@control17/sdk/protocol';
import { parseDataFlag, parseSubcommandArgs } from './args.js';
import { runClaudeCodeCommand } from './commands/claude-code.js';
import { formatReport, runDoctor } from './commands/doctor.js';
import { runEnrollCommand } from './commands/enroll.js';
import { UsageError } from './commands/errors.js';
import { runObjectivesCommand } from './commands/objectives.js';
import { type PushCommandInput, runPushCommand } from './commands/push.js';
import { QuickstartError, runQuickstartCommand } from './commands/quickstart.js';
import { runRosterCommand } from './commands/roster.js';
import { runServeCommand } from './commands/serve.js';
import { runSetupCommand } from './commands/setup.js';
import { CLI_VERSION } from './version.js';

const USAGE = `control17 cli v${CLI_VERSION}

usage:
  c17 setup       [--config-path <path>]            first-run wizard (squadron + slots + TOTP)
  c17 enroll      --slot <callsign> [--config-path <path>]   (re-)enroll a slot for web UI login
  c17 quickstart  [--skip-browser] [--assignee <callsign>]   seed a demo objective + open the web UI
  c17 claude-code [--no-trace] [--doctor] [--skip-doctor] [-- <claude args>...]   spawn claude-code wrapped in a c17 runner
  c17 push        --body <text> (--agent <id> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]...
  c17 roster                        list slots, authority, and connection state
  c17 objectives  list|view|create|update|complete|cancel|reassign   squadron objectives
  c17 serve       [--config-path <path>] [--port <n>] [--host <h>] [--db <path>]

global options (or via env):
  --url <url>       broker base URL (env: ${ENV.url}, default: http://127.0.0.1:${DEFAULT_PORT})
  --token <secret>  broker bearer token (env: ${ENV.token})
  -h, --help        print this message
  -v, --version     print the installed CLI version and exit
`;

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`c17: ${message}\n`);
  process.exit(code);
}

function getString(values: Record<string, unknown>, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

function getBoolean(values: Record<string, unknown>, key: string): boolean {
  return values[key] === true;
}

function makeClient(values: Record<string, unknown>): Client {
  const url =
    getString(values, 'url') ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const token = getString(values, 'token') ?? process.env[ENV.token];
  if (!token) {
    fail(`--token or ${ENV.token} is required`);
  }
  return new Client({ url, token });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`c17 ${CLI_VERSION}\n`);
    return;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  switch (subcommand) {
    case 'setup':
      await handleSetup(rest);
      return;
    case 'enroll':
      await handleEnroll(rest);
      return;
    case 'quickstart':
      await handleQuickstart(rest);
      return;
    case 'push':
      await handlePush(rest);
      return;
    case 'roster':
      await handleRoster(rest);
      return;
    case 'objectives':
      await handleObjectives(rest);
      return;
    case 'serve':
      await handleServe(rest);
      return;
    case 'mcp-bridge':
      await handleMcpBridge(rest);
      return;
    case 'claude-code':
      await handleClaudeCode(rest);
      return;
    default:
      process.stderr.write(USAGE);
      fail(`unknown subcommand: ${subcommand}`);
  }
}

async function handleSetup(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    'config-path': { type: 'string' },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    await runSetupCommand(
      {
        configPath: getString(values, 'config-path') ?? getString(values, 'config'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleEnroll(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    slot: { type: 'string', short: 's' },
    'config-path': { type: 'string' },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    await runEnrollCommand(
      {
        slot: getString(values, 'slot'),
        configPath: getString(values, 'config-path') ?? getString(values, 'config'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handlePush(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    agent: { type: 'string', short: 'a' },
    body: { type: 'string', short: 'b' },
    title: { type: 'string', short: 't' },
    level: { type: 'string', short: 'l' },
    broadcast: { type: 'boolean' },
    data: { type: 'string', multiple: true },
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const dataRaw = values.data as string[] | undefined;
  let data: Record<string, unknown> | undefined;
  try {
    data = parseDataFlag(dataRaw);
  } catch (err) {
    fail((err as Error).message);
  }

  const input: PushCommandInput = {
    agentId: getString(values, 'agent'),
    body: getString(values, 'body') ?? '',
    title: getString(values, 'title'),
    level: getString(values, 'level'),
    broadcast: getBoolean(values, 'broadcast'),
    data,
  };

  try {
    const client = makeClient(values);
    const output = await runPushCommand(input, client);
    log(output);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleQuickstart(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    token: { type: 'string' },
    'skip-browser': { type: 'boolean' },
    assignee: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const client = makeClient(values);
    const url =
      getString(values, 'url') ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
    const token = getString(values, 'token') ?? process.env[ENV.token] ?? '';
    await runQuickstartCommand(
      {
        url,
        token,
        skipBrowser: getBoolean(values, 'skip-browser'),
        assignee: getString(values, 'assignee'),
      },
      client,
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof QuickstartError) fail(err.message);
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleRoster(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    const client = makeClient(values);
    const output = await runRosterCommand(client);
    log(output);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleServe(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    'config-path': { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const portStr = getString(values, 'port');
  let port: number | undefined;
  if (portStr !== undefined) {
    const parsed = Number(portStr);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65_535) {
      fail(`invalid --port: ${portStr}`, 2);
    }
    port = parsed;
  }

  let running: Awaited<ReturnType<typeof runServeCommand>> | null = null;
  try {
    running = await runServeCommand(
      {
        configPath: getString(values, 'config-path') ?? getString(values, 'config'),
        port,
        host: getString(values, 'host'),
        dbPath: getString(values, 'db'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    process.stderr.write(`\nc17 serve: stopping (${signal})...\n`);
    await running?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function handleObjectives(args: string[]): Promise<void> {
  // Objectives has its own internal subcommand routing that parses
  // flags per-subcommand. We still pull `--url` / `--token` out of
  // argv here so `c17 objectives list --url http://...` works the
  // same way the other subcommands do.
  //
  // Strategy: extract --url and --token pairs from argv, passing the
  // rest through to runObjectivesCommand. parseArgs would reject
  // unknown options, so we do this by hand with a tight loop.
  const clientOpts: Record<string, string> = {};
  const passthrough: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return;
    }
    if (arg === '--url' || arg === '--token') {
      const next = args[i + 1];
      if (next === undefined) {
        fail(`${arg} requires a value`, 2);
      }
      clientOpts[arg.slice(2)] = next as string;
      i++;
      continue;
    }
    if (arg === undefined) continue;
    passthrough.push(arg);
  }

  try {
    const client = makeClient(clientOpts);
    const output = await runObjectivesCommand(client, passthrough);
    log(output);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `c17 claude-code` — spawn claude-code as a child of a c17 runner.
 *
 * Arg handling is a little custom: we accept `--url` and `--token` as
 * c17 knobs (with env fallback), then everything after a literal `--`
 * is forwarded verbatim to claude. Without a `--`, any unrecognized
 * args also flow through to claude, so `c17 claude-code --model opus`
 * works the same as `c17 claude-code -- --model opus`.
 */
async function handleClaudeCode(args: string[]): Promise<void> {
  let url: string | undefined;
  let token: string | undefined;
  let noTrace = false;
  let doctor = false;
  let skipDoctor = false;
  const claudeArgs: string[] = [];
  let seenDashDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (seenDashDash) {
      claudeArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      seenDashDash = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return;
    }
    if (arg === '--no-trace') {
      noTrace = true;
      continue;
    }
    if (arg === '--doctor') {
      doctor = true;
      continue;
    }
    if (arg === '--skip-doctor') {
      skipDoctor = true;
      continue;
    }
    if (arg === '--url' || arg === '--token') {
      const next = args[i + 1];
      if (next === undefined) {
        fail(`${arg} requires a value`, 2);
      }
      if (arg === '--url') url = next as string;
      else token = next as string;
      i++;
      continue;
    }
    // Anything else we don't recognize flows to claude. This lets
    // `c17 claude-code --model opus` work the same as with a `--`.
    claudeArgs.push(arg);
  }

  // Explicit `--doctor` is the "run doctor, print the full report, exit"
  // mode. Unchanged.
  if (doctor) {
    const report = await runDoctor();
    log(formatReport(report));
    process.exit(report.anyFail ? 1 : 0);
  }

  // Default preflight: run doctor silently before spawning claude so a
  // broken environment surfaces as a readable report instead of a
  // cryptic runtime error three seconds into the session. `--skip-doctor`
  // opts out for operators who know the environment is fine (CI,
  // scripted reruns, etc.). WARNs are advisory — we proceed. Only FAILs
  // abort, and when they do we dump the full report so the operator can
  // see which check tripped.
  if (!skipDoctor) {
    const report = await runDoctor();
    if (report.anyFail) {
      process.stderr.write(formatReport(report));
      process.stderr.write(
        `\nc17 claude-code: preflight FAILED — fix the above or pass --skip-doctor to bypass\n`,
      );
      process.exit(1);
    }
  }

  try {
    const code = await runClaudeCodeCommand({ url, token, claudeArgs, noTrace });
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `c17 mcp-bridge` — internal verb spawned by agents via `.mcp.json`.
 *
 * Hidden from the top-level `--help` usage because operators never
 * invoke it directly; the `c17 claude-code` runner generates the
 * `.mcp.json` entry that points here. If an operator does run it by
 * hand, the bridge will immediately error out with "C17_RUNNER_SOCKET
 * is required" which is the closest thing we can give them to a
 * useful message.
 */
async function handleMcpBridge(_args: string[]): Promise<void> {
  // The bridge ignores args entirely — it reads config only from
  // env vars (`C17_RUNNER_SOCKET`) and stdio. The `_args` param is
  // kept to match the subcommand handler shape.
  const bridgeModule = await import('./runtime/bridge.js');
  try {
    await bridgeModule.runBridge();
  } catch (err) {
    if (err instanceof bridgeModule.BridgeStartupError) {
      process.stderr.write(`c17 mcp-bridge: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
