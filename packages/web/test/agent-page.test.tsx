/**
 * AgentPage + AgentTimeline render tests.
 *
 * Covers:
 *   - Non-commander sees a permission-denied banner
 *   - Commander sees the full page (header, metadata, activity)
 *   - AgentTimeline renders each event kind correctly
 *   - Filter bar toggles hide/show per-kind rows
 *   - Empty state shows the "no activity" placeholder
 *
 * Real-SSE behavior (connect / reconnect / dedup) is covered at
 * the lib level rather than through a rendered component; trying
 * to drive EventSource in jsdom is flaky.
 */

import type {
  AgentActivityRow,
  BriefingResponse,
  Objective,
  RosterResponse,
} from '@control17/sdk/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentPage } from '../src/components/AgentPage.js';
import { __resetAgentTimelineForTests, AgentTimeline } from '../src/components/AgentTimeline.js';
import {
  __resetAgentActivityForTests,
  agentActivityCallsign,
  agentActivityLoading,
  agentActivityRows,
} from '../src/lib/agent-activity.js';
import { briefing } from '../src/lib/briefing.js';
import { __resetClientForTests } from '../src/lib/client.js';
import { objectives as objectivesSignal } from '../src/lib/objectives.js';
import { roster } from '../src/lib/roster.js';

const originalFetch = globalThis.fetch;

const COMMANDER_BRIEFING: BriefingResponse = {
  callsign: 'ACTUAL',
  role: 'operator',
  authority: 'commander',
  squadron: { name: 'alpha-squadron', mission: 'Ship it', brief: '' },
  teammates: [
    { callsign: 'ACTUAL', role: 'operator', authority: 'commander' },
    { callsign: 'ALPHA-1', role: 'implementer', authority: 'operator' },
  ],
  openObjectives: [],
  instructions: 'Lead the squadron.',
};

const OPERATOR_BRIEFING: BriefingResponse = {
  ...COMMANDER_BRIEFING,
  callsign: 'ALPHA-1',
  role: 'implementer',
  authority: 'operator',
};

const ROSTER: RosterResponse = {
  teammates: [
    { callsign: 'ACTUAL', role: 'operator', authority: 'commander' },
    { callsign: 'ALPHA-1', role: 'implementer', authority: 'operator' },
  ],
  connected: [
    {
      agentId: 'ALPHA-1',
      connected: 1,
      createdAt: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      role: 'implementer',
      authority: 'operator',
    },
  ],
};

const OBJECTIVE: Objective = {
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

const LLM_ROW: AgentActivityRow = {
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
        maxTokens: 1024,
        temperature: null,
        system: null,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: null,
      },
      response: {
        stopReason: 'end_turn',
        stopSequence: null,
        status: 200,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'pong' }] }],
        usage: {
          inputTokens: 3,
          outputTokens: 1,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
      },
    },
  },
};

const OPAQUE_ROW: AgentActivityRow = {
  id: 2,
  slotCallsign: 'ALPHA-1',
  createdAt: 1_700_000_001_000,
  event: {
    kind: 'opaque_http',
    ts: 1_700_000_000_500,
    duration: 10,
    entry: {
      kind: 'opaque_http',
      startedAt: 1_700_000_000_500,
      endedAt: 1_700_000_000_510,
      host: 'telemetry.example.com',
      method: 'POST',
      url: '/ping',
      status: 204,
      requestHeaders: {},
      responseHeaders: {},
      requestBodyPreview: null,
      responseBodyPreview: null,
    },
  },
};

const OPEN_ROW: AgentActivityRow = {
  id: 3,
  slotCallsign: 'ALPHA-1',
  createdAt: 1_700_000_002_000,
  event: { kind: 'objective_open', ts: 1_700_000_001_000, objectiveId: 'obj-1' },
};

const CLOSE_ROW: AgentActivityRow = {
  id: 4,
  slotCallsign: 'ALPHA-1',
  createdAt: 1_700_000_003_000,
  event: {
    kind: 'objective_close',
    ts: 1_700_000_002_000,
    objectiveId: 'obj-1',
    result: 'done',
  },
};

/**
 * Minimal EventSource stub — jsdom doesn't ship one, and the
 * lib's `startAgentActivitySubscribe` needs to construct one.
 * The stub records all constructions so tests can verify the
 * URL, but it never fires real events.
 */
class StubEventSource {
  static instances: StubEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(url: string, _init?: EventSourceInit) {
    this.url = url;
    StubEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  close(): void {
    /* no-op */
  }
}

const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

beforeEach(() => {
  __resetClientForTests();
  __resetAgentActivityForTests();
  __resetAgentTimelineForTests();
  // Stub fetch so the lib's hydration call in useEffect doesn't 500
  // every test. We replay the same listAgentActivity response for
  // every call.
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ activity: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
  // Stub EventSource — jsdom doesn't have one.
  StubEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
  roster.value = ROSTER;
  objectivesSignal.value = [OBJECTIVE];
});

afterEach(() => {
  cleanup();
  briefing.value = null;
  roster.value = null;
  objectivesSignal.value = [];
  __resetAgentActivityForTests();
  __resetAgentTimelineForTests();
  globalThis.fetch = originalFetch;
  if (originalEventSource === undefined) {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  } else {
    (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  }
});

describe('AgentPage', () => {
  it('shows a permission denied banner for non-commanders', () => {
    briefing.value = OPERATOR_BRIEFING;
    render(<AgentPage callsign="ALPHA-1" viewer="ALPHA-1" />);
    expect(screen.getByText(/only commanders may view/i)).toBeTruthy();
  });

  it('shows the agent header and metadata for commanders', () => {
    briefing.value = COMMANDER_BRIEFING;
    agentActivityCallsign.value = 'ALPHA-1';
    render(<AgentPage callsign="ALPHA-1" viewer="ACTUAL" />);
    expect(screen.getByRole('heading', { name: 'ALPHA-1' })).toBeTruthy();
    // Squadron name from briefing
    expect(screen.getAllByText(/alpha-squadron/i).length).toBeGreaterThan(0);
    // Role from the roster
    expect(screen.getByText('implementer')).toBeTruthy();
    // Assigned objective appears in the metadata section
    expect(screen.getByText(/obj-1 — Ship the feature/)).toBeTruthy();
    // Online status dot (ALPHA-1 has 1 subscriber in the stub)
    expect(screen.getByText(/ON NET/i)).toBeTruthy();
  });

  it('shows the "Open DM" shortcut when viewer is not the target slot', () => {
    briefing.value = COMMANDER_BRIEFING;
    render(<AgentPage callsign="ALPHA-1" viewer="ACTUAL" />);
    expect(screen.getByText(/Open DM with ALPHA-1/)).toBeTruthy();
  });
});

describe('AgentTimeline', () => {
  it('renders each event kind with distinct affordances', () => {
    briefing.value = COMMANDER_BRIEFING;
    agentActivityRows.value = [CLOSE_ROW, OPEN_ROW, OPAQUE_ROW, LLM_ROW];
    agentActivityLoading.value = false;
    const { container } = render(<AgentTimeline />);

    // LLM exchange: model name
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy();
    // Opaque HTTP: host + url as separate spans
    const text = container.textContent ?? '';
    expect(text).toContain('telemetry.example.com');
    expect(text).toContain('/ping');
    expect(text).toContain('204');
    // Objective open marker (▼) and close marker (▲)
    expect(text).toContain('▼');
    expect(text).toContain('▲');
    expect(text).toContain('closed (done)');
  });

  it('shows the empty placeholder when no rows are loaded', () => {
    briefing.value = COMMANDER_BRIEFING;
    agentActivityRows.value = [];
    agentActivityLoading.value = false;
    render(<AgentTimeline />);
    expect(screen.getByText(/No activity yet/i)).toBeTruthy();
  });

  it('filter toggle hides the matching event kind', () => {
    briefing.value = COMMANDER_BRIEFING;
    agentActivityRows.value = [LLM_ROW, OPAQUE_ROW];
    agentActivityLoading.value = false;
    render(<AgentTimeline />);

    // Before toggle: both kinds visible.
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy();
    const beforeText = document.body.textContent ?? '';
    expect(beforeText).toContain('telemetry.example.com');

    // Click the HTTP filter button to turn it off.
    const httpButton = screen.getByRole('button', { name: /HTTP/ });
    fireEvent.click(httpButton);

    // Re-query after the state update.
    const afterText = document.body.textContent ?? '';
    expect(afterText).not.toContain('telemetry.example.com');
    // LLM row still there.
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy();
  });
});
