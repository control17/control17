/**
 * TracePanel render tests.
 *
 * We render the component with a stubbed client that returns
 * canned agent-activity rows, then assert:
 *
 *   - LLM exchanges surface model, token counts, text blocks,
 *     and tool_use blocks
 *   - Empty result shows the "no exchanges" placeholder
 *   - Fetch errors render an error banner, not a crash
 *
 * The commander gate is enforced one level up in ObjectiveDetail
 * (client) and at the GET /agents/:callsign/activity server
 * endpoint. The server endpoint test in
 * apps/server/test/agent-activity.test.ts is the source of truth
 * for the gate.
 */

import type { AgentActivityRow, ListAgentActivityResponse, Objective } from '@control17/sdk/types';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TracePanel } from '../src/components/TracePanel.js';
import { __resetClientForTests } from '../src/lib/client.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetClientForTests();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function stubActivity(
  body: ListAgentActivityResponse | Record<string, unknown>,
  status = 200,
): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
}

const objective: Objective = {
  id: 'obj-1',
  title: 'Ship the feature',
  body: '',
  outcome: 'Feature shipped',
  status: 'active',
  assignee: 'ALPHA-1',
  originator: 'ACTUAL',
  watchers: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  completedAt: null,
  result: null,
  blockReason: null,
};

const llmRow: AgentActivityRow = {
  id: 1,
  slotCallsign: 'ALPHA-1',
  createdAt: 1_700_000_000_500,
  event: {
    kind: 'llm_exchange',
    ts: 1_700_000_000_000,
    duration: 200,
    entry: {
      kind: 'anthropic_messages',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_200,
      request: {
        model: 'claude-sonnet-4-6',
        maxTokens: 2048,
        temperature: null,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
        tools: null,
      },
      response: {
        stopReason: 'end_turn',
        stopSequence: null,
        status: 200,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'general kenobi' },
              { type: 'tool_use', id: 'tu_1', name: 'get_time', input: { tz: 'UTC' } },
            ],
          },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: 5,
        },
      },
    },
  },
};

describe('TracePanel', () => {
  it('renders llm exchanges with model + usage + messages', async () => {
    stubActivity({ activity: [llmRow] });
    render(<TracePanel objective={objective} />);

    await waitFor(() => expect(screen.getByText(/LLM exchanges \(1\)/)).toBeTruthy());
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy();
    expect(screen.getByText(/in=10/)).toBeTruthy();
    expect(screen.getByText(/out=4/)).toBeTruthy();
    expect(screen.getByText(/cache_hit=5/)).toBeTruthy();
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(screen.getByText('general kenobi')).toBeTruthy();
    expect(screen.getByText('get_time')).toBeTruthy();
  });

  it('renders the no-exchanges placeholder when the list is empty', async () => {
    stubActivity({ activity: [] });
    render(<TracePanel objective={objective} />);

    await waitFor(() => expect(screen.getByText(/no llm exchanges captured/i)).toBeTruthy());
  });

  it('renders an error banner on fetch failure', async () => {
    stubActivity({ error: 'server on fire' }, 500);
    render(<TracePanel objective={objective} />);

    await waitFor(() => {
      const banner = screen.queryByText(/server on fire|HTTP 500|500/);
      expect(banner).toBeTruthy();
    });
  });
});
