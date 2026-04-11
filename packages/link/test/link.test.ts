import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_BROKER_TOKEN, type FakeBroker, startFakeBroker } from './fake-broker.js';

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

const LINK_BINARY = resolve(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
const AGENT_ID = 'link-test-agent';

describe('link binary (spawned subprocess)', () => {
  let broker: FakeBroker;
  let proc: ChildProcessWithoutNullStreams;
  let stdoutBuffer = '';
  const inboundQueue: JsonRpcMessage[] = [];

  beforeAll(async () => {
    broker = await startFakeBroker();
    proc = spawn(process.execPath, [LINK_BINARY], {
      env: {
        ...process.env,
        C17_URL: broker.url,
        C17_TOKEN: FAKE_BROKER_TOKEN,
        C17_AGENT_ID: AGENT_ID,
      },
      stdio: 'pipe',
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let idx = stdoutBuffer.indexOf('\n');
      while (idx !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            inboundQueue.push(JSON.parse(line) as JsonRpcMessage);
          } catch {
            // Ignore non-JSON lines — the link should never emit those but
            // if it does we capture stderr separately.
          }
        }
        idx = stdoutBuffer.indexOf('\n');
      }
    });

    proc.stderr.on('data', () => {
      // Link logs to stderr; swallow here so vitest output stays clean.
      // Uncomment when debugging:
      // process.stderr.write(`[link stderr] ${chunk.toString('utf8')}`);
    });
  });

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise<void>((r) => proc.once('exit', () => r()));
    }
    await broker.close();
  });

  function send(msg: JsonRpcMessage): void {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  async function waitForMessage(
    predicate: (msg: JsonRpcMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = 0; i < inboundQueue.length; i++) {
        const msg = inboundQueue[i];
        if (msg && predicate(msg)) {
          inboundQueue.splice(i, 1);
          return msg;
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for matching JSON-RPC message');
  }

  it('completes MCP initialize handshake and declares claude/channel capability', async () => {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.1' },
      },
    });
    const response = await waitForMessage((m) => m.id === 1);
    expect(response.result).toBeDefined();
    const result = response.result as {
      capabilities: {
        experimental?: Record<string, unknown>;
        tools?: Record<string, unknown>;
      };
      serverInfo: { name: string };
    };
    expect(result.capabilities.experimental).toHaveProperty('claude/channel');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('control17');

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });

  it('lists send, list_agents, and register tools', async () => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitForMessage((m) => m.id === 2);
    const result = response.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['list_agents', 'register', 'send']);
  });

  it('send tool issues POST /push to the broker', async () => {
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'send',
        arguments: {
          targetAgentId: 'peer-1',
          body: 'hello from link test',
          title: 'greetings',
          level: 'warning',
        },
      },
    });
    const response = await waitForMessage((m) => m.id === 3);
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text ?? '').toContain('delivered to peer-1');

    // Verify the broker actually received the push
    const lastPush = broker.pushes[broker.pushes.length - 1];
    expect(lastPush?.body).toBe('hello from link test');
    expect(lastPush?.title).toBe('greetings');
    expect(lastPush?.level).toBe('warning');
    expect(lastPush?.data).toEqual({ from: AGENT_ID });
  });

  it('list_agents tool calls GET /agents and renders the result', async () => {
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_agents', arguments: {} },
    });
    const response = await waitForMessage((m) => m.id === 4);
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text ?? '').toContain('peer-1');
  });

  it('forwards broker SSE messages as notifications/claude/channel', async () => {
    // Link auto-subscribes at startup; wait for it to show up in the broker.
    const sub = await broker.waitForSubscriber(AGENT_ID);

    sub.write({
      id: 'msg-forwarded',
      ts: 1_700_000_001_000,
      agentId: AGENT_ID,
      title: 'build broken',
      body: 'ci failed on main',
      level: 'warning',
      data: { run: '1234', severity: 'high' },
    });

    const notif = await waitForMessage((m) => m.method === 'notifications/claude/channel');
    const params = notif.params as {
      content: string;
      meta: Record<string, string>;
    };
    expect(params.content).toBe('ci failed on main');
    expect(params.meta.title).toBe('build broken');
    expect(params.meta.level).toBe('warning');
    expect(params.meta.run).toBe('1234');
    expect(params.meta.severity).toBe('high');
  });
});
