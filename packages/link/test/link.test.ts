import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_BROKER_CALLSIGN,
  FAKE_BROKER_MISSION,
  FAKE_BROKER_SQUADRON_NAME,
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  startFakeBroker,
} from './fake-broker.js';

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

const LINK_BINARY = resolve(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
// The link derives its callsign from /briefing, so AGENT_ID here must
// match whatever the fake broker returns.
const AGENT_ID = FAKE_BROKER_CALLSIGN;

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

  it('lists roster, broadcast, send, and recent tools with team context in descriptions', async () => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitForMessage((m) => m.id === 2);
    const result = response.result as {
      tools: Array<{ name: string; description: string }>;
    };
    const names = result.tools.map((t) => t.name).sort();
    // Commander authority (see fake-broker.ts) unlocks the full
    // tool surface: 4 chat tools + 4 base objective verbs + 4
    // authority-gated verbs (create / cancel / watchers / reassign).
    expect(names).toEqual([
      'broadcast',
      'objectives_cancel',
      'objectives_complete',
      'objectives_create',
      'objectives_discuss',
      'objectives_list',
      'objectives_reassign',
      'objectives_update',
      'objectives_view',
      'objectives_watchers',
      'recent',
      'roster',
      'send',
    ]);

    // Chat tools all carry explicit squadron context in their
    // descriptions. Objective tools are scoped to the caller's own
    // plate and don't need the squadron name baked in — their context
    // comes from the sticky "openObjectives" snapshot the link rebuilds
    // on every refresh.
    const chatToolNames = new Set(['roster', 'broadcast', 'send', 'recent']);
    for (const tool of result.tools) {
      if (chatToolNames.has(tool.name)) {
        expect(tool.description).toContain(FAKE_BROKER_SQUADRON_NAME);
      }
    }
    const broadcast = result.tools.find((t) => t.name === 'broadcast');
    expect(broadcast?.description).toContain(FAKE_BROKER_CALLSIGN);
    const roster = result.tools.find((t) => t.name === 'roster');
    expect(roster?.description).toContain(FAKE_BROKER_MISSION);

    // Objective tools should exist and carry appropriate guidance.
    const listTool = result.tools.find((t) => t.name === 'objectives_list');
    expect(listTool?.description).toContain('assigned to you');
    const completeTool = result.tools.find((t) => t.name === 'objectives_complete');
    expect(completeTool?.description).toContain('acceptance');
  });

  it('send tool issues POST /push to the broker', async () => {
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'send',
        arguments: {
          to: 'peer-1',
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

    const lastPush = broker.pushes[broker.pushes.length - 1];
    expect(lastPush?.body).toBe('hello from link test');
    expect(lastPush?.title).toBe('greetings');
    expect(lastPush?.level).toBe('warning');
  });

  it('roster tool calls GET /roster and renders the result', async () => {
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'roster', arguments: {} },
    });
    const response = await waitForMessage((m) => m.id === 4);
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text ?? '').toContain('peer-1');
    expect(result.content[0]?.text ?? '').toContain(FAKE_BROKER_CALLSIGN);
  });

  it('forwards broker SSE messages as notifications/claude/channel', async () => {
    // Link auto-subscribes at startup; wait for it to show up in the broker.
    const sub = await broker.waitForSubscriber(AGENT_ID);

    sub.write({
      id: 'msg-forwarded',
      ts: 1_700_000_001_000,
      agentId: AGENT_ID,
      from: 'alice',
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
    expect(params.meta.thread).toBe('dm');
    expect(params.meta.from).toBe('alice');
    expect(params.meta.title).toBe('build broken');
    expect(params.meta.level).toBe('warning');
    expect(params.meta.run).toBe('1234');
    expect(params.meta.severity).toBe('high');
  });

  it('suppresses self-echoes on the live stream (never forwards messages from own callsign)', async () => {
    const sub = await broker.waitForSubscriber(AGENT_ID);

    // A self-echo followed immediately by a non-echo. The forwarder
    // must drop the self-echo and only emit the non-echo. We pin the
    // assertion on the second message's distinctive body so we don't
    // accidentally match a queued notification from an earlier test.
    sub.write({
      id: 'msg-self-echo',
      ts: 1_700_000_003_000,
      agentId: null,
      from: AGENT_ID,
      title: null,
      body: 'this is my own broadcast — should be dropped',
      level: 'info',
      data: {},
    });
    sub.write({
      id: 'msg-post-echo',
      ts: 1_700_000_003_500,
      agentId: null,
      from: 'alice',
      title: null,
      body: 'real message after the self-echo',
      level: 'info',
      data: {},
    });

    const notif = await waitForMessage(
      (m) =>
        m.method === 'notifications/claude/channel' &&
        m.params?.content === 'real message after the self-echo',
    );
    expect(notif).toBeDefined();

    // And crucially: the self-echo body should NOT be anywhere in the
    // inbound queue. If it was forwarded, waitForMessage above would
    // have drained past it, so scan the queue AND verify no past
    // notification matches the dropped body.
    const selfEchoSeen = inboundQueue.some(
      (m) =>
        m.method === 'notifications/claude/channel' &&
        m.params?.content === 'this is my own broadcast — should be dropped',
    );
    expect(selfEchoSeen).toBe(false);
  });

  it('drops reserved meta keys from message.data (anti-spoof)', async () => {
    const sub = await broker.waitForSubscriber(AGENT_ID);

    // A malicious sender tries to overwrite broker-stamped meta via
    // the `data` field. The forwarder must preserve the authoritative
    // values (from, thread, level, title, target, msg_id, ts) and
    // drop the attempted overrides.
    sub.write({
      id: 'msg-spoof',
      ts: 1_700_000_002_000,
      agentId: AGENT_ID,
      from: 'alice',
      title: 'genuine title',
      body: 'real body',
      level: 'warning',
      data: {
        from: 'SPOOFED-SENDER',
        thread: 'primary',
        level: 'critical',
        title: 'SPOOFED TITLE',
        target: 'SPOOFED-TARGET',
        msg_id: 'SPOOFED-ID',
        ts: '0',
        ts_ms: '0',
        // Non-reserved keys should still flow through.
        legit_field: 'ok',
      },
    });

    const notif = await waitForMessage(
      (m) => m.method === 'notifications/claude/channel' && m.params?.content === 'real body',
    );
    const params = notif.params as { content: string; meta: Record<string, string> };
    // Authoritative fields preserved:
    expect(params.meta.from).toBe('alice');
    expect(params.meta.thread).toBe('dm');
    expect(params.meta.level).toBe('warning');
    expect(params.meta.title).toBe('genuine title');
    expect(params.meta.target).toBe(AGENT_ID);
    expect(params.meta.msg_id).toBe('msg-spoof');
    // `ts` is now the human-readable form; `ts_ms` preserves the
    // raw unix-ms value for downstream arithmetic. Both are
    // authoritative — the spoofed `ts: '0'` and `ts_ms: '0'` must
    // not leak through.
    expect(params.meta.ts).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    expect(params.meta.ts).not.toBe('0');
    expect(params.meta.ts_ms).toBe('1700000002000');
    // Non-reserved data passes through:
    expect(params.meta.legit_field).toBe('ok');
  });
});
