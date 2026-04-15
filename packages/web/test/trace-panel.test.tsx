/**
 * TracePanel render tests.
 *
 * We render the component in isolation with a stubbed client that
 * returns canned trace payloads, then assert:
 *
 *   - Anthropic entries surface model, token counts, text blocks,
 *     and tool_use / tool_result blocks
 *   - Opaque HTTP entries surface method/host/url/status
 *   - Empty list shows the no-traces-yet placeholder
 *   - Fetch errors render an error banner, not a crash
 *
 * We don't test the commander gate here — that's enforced one level
 * up in ObjectiveDetail, which passes or skips the component based
 * on `briefing.authority === 'commander'`. A dedicated rendering of
 * ObjectiveDetail under different authorities would cover it; for
 * now the server endpoint test in apps/server/test/traces.test.ts
 * is the source of truth for the gate.
 */

import type { ObjectiveTrace } from '@control17/sdk/types';
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

function stubTraces(body: { traces: ObjectiveTrace[] } | null, status = 200): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
}

const anthropicTrace: ObjectiveTrace = {
  id: 1,
  objectiveId: 'obj-1',
  spanStart: 1_700_000_000_000,
  spanEnd: 1_700_000_000_500,
  provider: 'anthropic',
  truncated: false,
  createdAt: 1_700_000_000_500,
  entries: [
    {
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
  ],
};

const opaqueTrace: ObjectiveTrace = {
  id: 2,
  objectiveId: 'obj-1',
  spanStart: 1_700_000_001_000,
  spanEnd: 1_700_000_001_500,
  provider: 'anthropic',
  truncated: true,
  createdAt: 1_700_000_001_500,
  entries: [
    {
      kind: 'opaque_http',
      startedAt: 1_700_000_001_000,
      endedAt: 1_700_000_001_200,
      host: 'api.example.com',
      method: 'GET',
      url: '/v1/status',
      status: 204,
      requestHeaders: {},
      responseHeaders: {},
      requestBodyPreview: null,
      responseBodyPreview: null,
    },
  ],
};

describe('TracePanel', () => {
  it('renders anthropic entries with model + usage + messages', async () => {
    stubTraces({ traces: [anthropicTrace] });
    render(<TracePanel objectiveId="obj-1" />);

    await waitFor(() => expect(screen.getByText(/Captured traces \(1\)/)).toBeTruthy());
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy();
    // usage: in=10 out=4
    expect(screen.getByText(/in=10/)).toBeTruthy();
    expect(screen.getByText(/out=4/)).toBeTruthy();
    expect(screen.getByText(/cache_hit=5/)).toBeTruthy();
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(screen.getByText('general kenobi')).toBeTruthy();
    expect(screen.getByText('get_time')).toBeTruthy();
  });

  it('renders opaque HTTP entries with method + host + url + status', async () => {
    stubTraces({ traces: [opaqueTrace] });
    const { container } = render(<TracePanel objectiveId="obj-1" />);

    // TRUNCATED badge only appears once the trace has loaded, so
    // gate on that before reading container text. Per the brand
    // guide, the label is prefixed with a ◆ warning glyph and
    // uppercased; match loosely to survive minor copy tweaks.
    await waitFor(() => expect(screen.getByText(/TRUNCATED/)).toBeTruthy());
    const text = container.textContent ?? '';
    expect(text).toContain('GET');
    expect(text).toContain('api.example.com');
    expect(text).toContain('/v1/status');
    expect(text).toContain('204');
  });

  it('renders the no-traces placeholder when the list is empty', async () => {
    stubTraces({ traces: [] });
    render(<TracePanel objectiveId="obj-1" />);

    await waitFor(() =>
      expect(screen.getByText(/no traces captured for this objective/i)).toBeTruthy(),
    );
  });

  it('renders an error banner on fetch failure', async () => {
    stubTraces({ error: 'server on fire' } as unknown as { traces: ObjectiveTrace[] }, 500);
    render(<TracePanel objectiveId="obj-1" />);

    await waitFor(() => {
      const banner = screen.queryByText(/server on fire|HTTP 500|500/);
      expect(banner).toBeTruthy();
    });
  });
});
