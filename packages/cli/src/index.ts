/**
 * `c17` — operator CLI for control17.
 *
 * Subcommands:
 *   c17 push    — push an event to an agent or broadcast
 *   c17 agents  — list connected agents
 *   c17 serve   — run a local broker (optional peer: @control17/server)
 *   c17 link    — run the stdio MCP channel link (optional peer: @control17/link)
 *
 * Global env vars (defaults):
 *   C17_URL       = http://127.0.0.1:8717
 *   C17_TOKEN     (required for push/agents)
 *   C17_AGENT_ID  (required for link)
 */

import { Client } from '@control17/sdk/client';
import { DEFAULT_PORT, ENV } from '@control17/sdk/protocol';
import { parseDataFlag, parseSubcommandArgs } from './args.js';
import { runAgentsCommand } from './commands/agents.js';
import { runLinkCommand } from './commands/link.js';
import { type PushCommandInput, runPushCommand, UsageError } from './commands/push.js';
import { runServeCommand } from './commands/serve.js';
import { CLI_VERSION } from './version.js';

const USAGE = `control17 cli v${CLI_VERSION}

usage:
  c17 connect                   interactive TUI — join the squadron net
  c17 push    --body <text> (--agent <id> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]...
  c17 agents
  c17 serve   [--config-path <path>] [--port <n>] [--host <h>] [--db <path>]
  c17 link    (configured via C17_URL / C17_TOKEN env vars)

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
    case 'connect':
      await handleConnect(rest);
      return;
    case 'push':
      await handlePush(rest);
      return;
    case 'agents':
      await handleAgents(rest);
      return;
    case 'serve':
      await handleServe(rest);
      return;
    case 'link':
      await handleLink(rest);
      return;
    default:
      process.stderr.write(USAGE);
      fail(`unknown subcommand: ${subcommand}`);
  }
}

async function handleConnect(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const url =
    getString(values, 'url') ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const token = getString(values, 'token') ?? process.env[ENV.token];
  if (!token) {
    fail(`connect: --token or ${ENV.token} is required`);
  }

  try {
    const { runConnectCommand } = await import('./commands/connect.js');
    await runConnectCommand({ url, token });
  } catch (err) {
    if (err instanceof (await import('./commands/connect.js')).UsageError) {
      fail(err.message, 2);
    }
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

async function handleAgents(args: string[]): Promise<void> {
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
    const output = await runAgentsCommand(client);
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
    if (err instanceof (await import('./commands/serve.js')).UsageError) {
      fail(err.message, 2);
    }
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

async function handleLink(args: string[]): Promise<void> {
  // The link has no CLI flags of its own — it reads env vars directly.
  // Parse the rest so `-h/--help` works, but no other options are accepted.
  const { values } = parseSubcommandArgs(args, {
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    await runLinkCommand();
  } catch (err) {
    if (err instanceof (await import('./commands/link.js')).UsageError) {
      fail(err.message, 2);
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
