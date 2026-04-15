/**
 * Component-level tests for the Phase 5 shell: Transcript, Sidebar,
 * Composer, and a minimal Shell mount path. We stub `globalThis.fetch`
 * so the real SDK client runs end-to-end (response validation + URL
 * construction are part of the coverage).
 *
 * We do NOT stub `EventSource` globally — tests that would need a live
 * SSE stream just assert on the signal-driven view and let the
 * `startSubscribe` effect fail its own fetch silently.
 */

import type { Message } from '@control17/sdk/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetComposerForTests, Composer } from '../src/components/Composer.js';
import { RosterPanel } from '../src/components/RosterPanel.js';
import { Sidebar } from '../src/components/Sidebar.js';
import { Transcript } from '../src/components/Transcript.js';
import { __resetBriefingForTests, briefing } from '../src/lib/briefing.js';
import { __resetClientForTests } from '../src/lib/client.js';
import { __resetMessagesForTests, appendMessages } from '../src/lib/messages.js';
import { __resetRosterForTests, roster } from '../src/lib/roster.js';
import { session } from '../src/lib/session.js';
import { __resetSseForTests } from '../src/lib/sse.js';
import { __resetViewForTests, currentView, selectThread } from '../src/lib/view.js';

const originalFetch = globalThis.fetch;

// Mock EventSource so Transcript/Shell effects that open it don't
// throw in happy-dom. happy-dom provides a basic implementation but
// we want tests to be insensitive to its details.
class MockEventSource {
  url: string;
  withCredentials: boolean;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
  }
  addEventListener(_type: string, _listener: EventListener): void {}
  removeEventListener(_type: string, _listener: EventListener): void {}
  close(): void {}
  dispatchEvent(_event: Event): boolean {
    return true;
  }
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;
  readyState = 0 as const;
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;
}
// biome-ignore lint/suspicious/noExplicitAny: happy-dom EventSource shim for tests
(globalThis as any).EventSource = MockEventSource;

beforeEach(() => {
  session.value = {
    status: 'authenticated',
    slot: 'ACTUAL',
    role: 'operator',
    authority: 'commander',
    expiresAt: 9_999_999_999_999,
  };
  __resetMessagesForTests();
  __resetBriefingForTests();
  __resetRosterForTests();
  __resetSseForTests();
  __resetViewForTests();
  __resetClientForTests();
  __resetComposerForTests();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function stubFetch(
  routes: Record<string, (init: RequestInit) => { status: number; body: unknown }>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.includes(suffix)) {
        const { status, body } = handler(init);
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
    }
    return Promise.resolve(new Response('no route', { status: 500 }));
  }) as typeof fetch;
}

function mkMsg(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    ts: 1_700_000_000_000,
    agentId: null,
    from: 'build-bot',
    title: null,
    body: 'hello',
    level: 'info',
    data: {},
    ...overrides,
  };
}

describe('<Transcript />', () => {
  it('renders the empty-state placeholder when a thread has no messages', () => {
    render(<Transcript viewer="ACTUAL" />);
    expect(screen.getByText(/net is quiet/i)).toBeTruthy();
  });

  it('renders messages from the current thread', () => {
    appendMessages('ACTUAL', [
      mkMsg({ id: 'a', ts: 1_700_000_000_000, body: 'first' }),
      mkMsg({ id: 'b', ts: 1_700_000_000_500, body: 'second' }),
    ]);
    render(<Transcript viewer="ACTUAL" />);
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('switches threads when the currentView signal changes', async () => {
    appendMessages('ACTUAL', [
      mkMsg({ id: 'p', ts: 1, body: 'primary msg' }),
      mkMsg({ id: 'd', ts: 2, agentId: 'build-bot', from: 'ACTUAL', body: 'dm msg' }),
    ]);
    const { rerender } = render(<Transcript viewer="ACTUAL" />);
    expect(screen.getByText('primary msg')).toBeTruthy();

    selectThread('dm:build-bot');
    rerender(<Transcript viewer="ACTUAL" />);
    await waitFor(() => {
      expect(screen.getByText('dm msg')).toBeTruthy();
    });
  });
});

describe('<Sidebar />', () => {
  function setRoster(connected: Record<string, number> = {}) {
    roster.value = {
      teammates: [
        { callsign: 'ACTUAL', role: 'operator', authority: 'commander' },
        { callsign: 'build-bot', role: 'implementer', authority: 'operator' },
        { callsign: 'test-agent-1', role: 'watcher', authority: 'operator' },
      ],
      connected: Object.entries(connected).map(([agentId, count]) => ({
        agentId,
        connected: count,
        createdAt: 0,
        lastSeen: 0,
        role: null,
        authority: 'operator' as const,
      })),
    };
  }

  it('shows Team Chat even when roster is still loading', () => {
    render(<Sidebar viewer="ACTUAL" />);
    expect(screen.getByText('Team Chat')).toBeTruthy();
  });

  it('lists every teammate from the roster (excluding the viewer)', () => {
    setRoster();
    render(<Sidebar viewer="ACTUAL" />);
    expect(screen.getByText('build-bot')).toBeTruthy();
    expect(screen.getByText('test-agent-1')).toBeTruthy();
    // Self is filtered out.
    expect(screen.queryByText('ACTUAL')).toBeNull();
  });

  it('does NOT use @ prefix on teammate rows', () => {
    setRoster();
    render(<Sidebar viewer="ACTUAL" />);
    expect(screen.queryByText('@build-bot')).toBeNull();
    expect(screen.getByText('build-bot')).toBeTruthy();
  });

  it('clicking a teammate opens a DM thread', async () => {
    setRoster();
    render(<Sidebar viewer="ACTUAL" />);
    fireEvent.click(screen.getByText('build-bot'));
    await waitFor(() => {
      expect(currentView.value).toEqual({ kind: 'thread', key: 'dm:build-bot' });
    });
  });

  it('clicking Team Chat selects the primary thread', async () => {
    setRoster();
    currentView.value = { kind: 'thread', key: 'dm:build-bot' };
    render(<Sidebar viewer="ACTUAL" />);
    fireEvent.click(screen.getByText('Team Chat'));
    await waitFor(() => {
      expect(currentView.value).toEqual({ kind: 'thread', key: 'primary' });
    });
  });

  it('active teammate row gets the primary-color left border', () => {
    setRoster();
    currentView.value = { kind: 'thread', key: 'dm:build-bot' };
    render(<Sidebar viewer="ACTUAL" />);
    const btn = screen.getByText('build-bot').closest('button');
    expect(btn?.className).toMatch(/border-brand-primary/);
  });

  it('renders online dot for connected teammates and muted dot for offline', () => {
    setRoster({ 'build-bot': 2 });
    render(<Sidebar viewer="ACTUAL" />);
    const onlineBtn = screen.getByLabelText(/Message build-bot \(online\)/i);
    const offlineBtn = screen.getByLabelText(/Message test-agent-1 \(offline\)/i);
    expect(onlineBtn).toBeTruthy();
    expect(offlineBtn).toBeTruthy();
  });

  it('online indicator is a filled circle, offline is an empty ring', () => {
    setRoster({ 'build-bot': 1 });
    render(<Sidebar viewer="ACTUAL" />);
    // Dot span is the first child of each teammate button, title=online/offline.
    const onlineDot = screen.getByTitle('online');
    const offlineDot = screen.getByTitle('offline');
    // Filled circle: has the primary background.
    expect(onlineDot.className).toMatch(/\bbg-brand-primary\b/);
    // Empty ring: transparent background + muted border, NOT filled.
    expect(offlineDot.className).toMatch(/\bbg-transparent\b/);
    expect(offlineDot.className).toMatch(/\bborder-brand-muted\b/);
    expect(offlineDot.className).not.toMatch(/\bbg-brand-muted\b/);
  });

  it('falls back to briefing teammates when roster is still null (cold start)', () => {
    briefing.value = {
      callsign: 'ACTUAL',
      role: 'operator',
      authority: 'commander',
      squadron: { name: 'alpha', mission: 'ship', brief: '' },
      teammates: [
        { callsign: 'ACTUAL', role: 'operator', authority: 'commander' },
        { callsign: 'build-bot', role: 'implementer', authority: 'operator' },
      ],
      openObjectives: [],
      instructions: '',
    };
    // roster.value stays null from beforeEach reset.
    render(<Sidebar viewer="ACTUAL" />);
    expect(screen.getByText('build-bot')).toBeTruthy();
    // With roster null, build-bot is shown as offline (we don't know yet).
    expect(screen.getByLabelText(/Message build-bot \(offline\)/i)).toBeTruthy();
  });
});

describe('<Composer />', () => {
  it('sends a broadcast on Enter when the primary thread is active', async () => {
    stubFetch({
      '/push': () => ({
        status: 200,
        body: {
          delivery: { sse: 0, targets: 0 },
          message: {
            id: 'echo',
            ts: 1,
            agentId: null,
            from: 'ACTUAL',
            title: null,
            body: 'ping',
            level: 'info',
            data: {},
          },
        },
      }),
    });
    render(<Composer viewer="ACTUAL" />);
    const textarea = screen.getByPlaceholderText(/broadcast/i) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'ping' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(textarea.value).toBe('');
    });
  });

  it('disables send when draft is empty', () => {
    render(<Composer viewer="ACTUAL" />);
    const button = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('sends a DM to the selected counterparty when in a dm thread', async () => {
    const seen: RequestInit[] = [];
    stubFetch({
      '/push': (init) => {
        seen.push(init);
        return {
          status: 200,
          body: {
            delivery: { sse: 0, targets: 0 },
            message: {
              id: 'echo',
              ts: 1,
              agentId: 'build-bot',
              from: 'ACTUAL',
              title: null,
              body: 'hey',
              level: 'info',
              data: {},
            },
          },
        };
      },
    });
    selectThread('dm:build-bot');
    render(<Composer viewer="ACTUAL" />);
    const textarea = screen.getByPlaceholderText(/message build-bot/i) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'hey' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    const body = JSON.parse(seen[0]?.body as string) as { agentId?: string; body: string };
    expect(body.agentId).toBe('build-bot');
    expect(body.body).toBe('hey');
  });
});

describe('<RosterPanel />', () => {
  it('shows loading state until roster populated', () => {
    render(<RosterPanel viewer="ACTUAL" />);
    expect(screen.getByText(/loading roster/i)).toBeTruthy();
  });

  it('marks teammates as online when connected count > 0', async () => {
    roster.value = {
      teammates: [
        { callsign: 'ACTUAL', role: 'operator', authority: 'commander' },
        { callsign: 'build-bot', role: 'implementer', authority: 'operator' },
      ],
      connected: [
        {
          agentId: 'build-bot',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: 'implementer',
          authority: 'operator',
        },
      ],
    };
    render(<RosterPanel viewer="ACTUAL" />);
    await waitFor(() => {
      // Per brand guide: status labels use stenciled "ON NET" / "OFF NET"
      // instead of lowercase "online" / "offline".
      expect(screen.getByText(/ON NET/)).toBeTruthy();
      expect(screen.getByText(/OFF NET/)).toBeTruthy();
    });
  });

  it('clicking a teammate opens a DM thread via currentView', async () => {
    roster.value = {
      teammates: [
        { callsign: 'ACTUAL', role: 'operator', authority: 'commander' },
        { callsign: 'build-bot', role: 'implementer', authority: 'operator' },
      ],
      connected: [],
    };
    render(<RosterPanel viewer="ACTUAL" />);
    const button = screen.getByRole('button', { name: /message build-bot/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(currentView.value).toEqual({ kind: 'thread', key: 'dm:build-bot' });
    });
  });

  it('self-row is NOT clickable (no DM-yourself button)', () => {
    roster.value = {
      teammates: [
        { callsign: 'ACTUAL', role: 'operator', authority: 'commander' },
        { callsign: 'build-bot', role: 'implementer', authority: 'operator' },
      ],
      connected: [],
    };
    render(<RosterPanel viewer="ACTUAL" />);
    // Only one button — for build-bot. The ACTUAL row is a plain <li>.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('aria-label')).toMatch(/build-bot/);
  });
});

describe('<Transcript /> empty state', () => {
  it('shows "net is quiet" for an empty primary thread', () => {
    selectThread('primary');
    render(<Transcript viewer="ACTUAL" />);
    expect(screen.getByText(/net is quiet/i)).toBeTruthy();
  });

  it('shows a DM-specific empty state for a fresh DM thread', () => {
    selectThread('dm:build-bot');
    render(<Transcript viewer="ACTUAL" />);
    expect(screen.getByText(/no messages yet with/i)).toBeTruthy();
    expect(screen.getByText('@build-bot')).toBeTruthy();
  });
});

describe('briefing bootstrap', () => {
  it('reflects briefing in Header via signal update', async () => {
    const { Header } = await import('../src/components/Header.js');
    briefing.value = {
      callsign: 'ACTUAL',
      role: 'operator',
      authority: 'commander',
      squadron: { name: 'alpha-squadron', mission: 'ship', brief: '' },
      teammates: [{ callsign: 'ACTUAL', role: 'operator', authority: 'commander' }],
      openObjectives: [],
      instructions: '',
    };
    render(<Header />);
    expect(screen.getByText('ACTUAL')).toBeTruthy();
    // Header now surfaces rank (authority) next to the callsign —
    // commander was stamped on the session in beforeEach.
    expect(screen.getByText('commander')).toBeTruthy();
    expect(screen.getByText(/alpha-squadron/)).toBeTruthy();
  });
});

describe('<Sidebar /> overview button', () => {
  it('renders a single Overview button above the threads section', () => {
    render(<Sidebar viewer="ACTUAL" />);
    const btn = screen.getByRole('button', { name: /open team overview/i });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Overview/);
  });

  it('clicking the overview button flips currentView to overview', async () => {
    render(<Sidebar viewer="ACTUAL" />);
    fireEvent.click(screen.getByRole('button', { name: /open team overview/i }));
    await waitFor(() => {
      expect(currentView.value).toEqual({ kind: 'overview' });
    });
  });

  it('overview button highlights when view is overview', () => {
    currentView.value = { kind: 'overview' };
    render(<Sidebar viewer="ACTUAL" />);
    const btn = screen.getByRole('button', { name: /open team overview/i });
    expect(btn.className).toMatch(/border-brand-primary/);
  });

  it('does NOT render team name or mission in the sidebar (those live in the Overview panel)', () => {
    briefing.value = {
      callsign: 'ACTUAL',
      role: 'operator',
      authority: 'commander',
      squadron: {
        name: 'alpha-squadron',
        mission: 'Ship the payment service.',
        brief: '',
      },
      teammates: [{ callsign: 'ACTUAL', role: 'operator', authority: 'commander' }],
      openObjectives: [],
      instructions: '',
    };
    render(<Sidebar viewer="ACTUAL" />);
    // Sidebar should not leak team name or mission into its chrome.
    expect(screen.queryByText('alpha-squadron')).toBeNull();
    expect(screen.queryByText(/Ship the payment service/)).toBeNull();
  });
});

describe('<RosterPanel /> mission header', () => {
  it('renders team name and mission at the top when briefing is set', () => {
    briefing.value = {
      callsign: 'ACTUAL',
      role: 'operator',
      authority: 'commander',
      squadron: {
        name: 'alpha-squadron',
        mission: 'Ship the payment service.',
        brief: 'Longer context about the operating window.',
      },
      teammates: [{ callsign: 'ACTUAL', role: 'operator', authority: 'commander' }],
      openObjectives: [],
      instructions: '',
    };
    roster.value = {
      teammates: [{ callsign: 'ACTUAL', role: 'operator', authority: 'commander' }],
      connected: [],
    };
    render(<RosterPanel viewer="ACTUAL" />);
    expect(screen.getByText('alpha-squadron')).toBeTruthy();
    expect(screen.getByText('Ship the payment service.')).toBeTruthy();
    expect(screen.getByText(/operating window/)).toBeTruthy();
  });

  it('omits the mission header when briefing is null', () => {
    roster.value = {
      teammates: [{ callsign: 'ACTUAL', role: 'operator', authority: 'commander' }],
      connected: [],
    };
    render(<RosterPanel viewer="ACTUAL" />);
    // Still renders the roster itself.
    expect(screen.getByText(/click a teammate/i)).toBeTruthy();
  });
});

// Keep vi imported so we don't lose the "import vi" line if we add
// spies later — prevents a lint warning drifting in during Phase 6.
void vi;
