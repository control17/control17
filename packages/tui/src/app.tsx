/**
 * Squadron radio net TUI — the main Ink application for `c17 connect`.
 *
 * Layout:
 *   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 *   ┃ C17  OPERATOR (human)           ◈ ON NET  2 STNS  ┃
 *   ┃  PRIMARY  │ ALPHA │ BRAVO 2                        ┃
 *   ┃─────────────────────────────────────────────────── ┃
 *   ┃                                                    ┃
 *   ┃ 14:32  OPERATOR                                    ┃
 *   ┃        hey squadron, status check                  ┃
 *   ┃                                                    ┃
 *   ┃ 14:33  ALPHA                                       ┃
 *   ┃        all green on my end                         ┃
 *   ┃        ready for deploy                            ┃
 *   ┃                                                    ┃
 *   ┃─────────────────────────────────────────────────── ┃
 *   ┃ > _                                                ┃
 *   ┃ PRIMARY  TAB switch  ENTER send  CTRL-C off net    ┃
 *   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 */

import type { Client } from '@control17/sdk/client';
import type { Agent, BriefingResponse, Message } from '@control17/sdk/types';
import { Box, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { renderToLines } from './render-lines.js';
import { PRIMARY } from './theme.js';

// ── Types ────────────────────────────────────────────────────────────

interface Props {
  client: Client;
  briefing: BriefingResponse;
}

type ThreadKey = string | null;

interface ThreadState {
  messages: Message[];
  unread: number;
}

interface State {
  threads: Map<ThreadKey, ThreadState>;
  agents: Agent[];
  currentThread: ThreadKey;
  composerText: string;
  /** Lines scrolled up from the bottom. 0 = pinned to latest. */
  scrollOffset: number;
  connected: boolean;
  error: string | null;
}

type Action =
  | { type: 'SET_AGENTS'; agents: Agent[] }
  | { type: 'ADD_MESSAGES'; messages: Message[]; viewer: string }
  | { type: 'RECEIVE_MESSAGE'; message: Message; viewer: string }
  | { type: 'SWITCH_THREAD'; key: ThreadKey }
  | { type: 'SET_COMPOSER'; text: string }
  | { type: 'SCROLL'; delta: number; maxLines: number; viewportLines: number }
  | { type: 'SET_CONNECTED'; value: boolean }
  | { type: 'SET_ERROR'; error: string | null };

// ── State helpers ────────────────────────────────────────────────────

function threadKeyForMessage(msg: Message, viewer: string): ThreadKey {
  if (msg.agentId === null) return null;
  return msg.from === viewer ? msg.agentId : (msg.from ?? msg.agentId);
}

function getThread(threads: Map<ThreadKey, ThreadState>, key: ThreadKey): ThreadState {
  return threads.get(key) ?? { messages: [], unread: 0 };
}

function setThread(
  threads: Map<ThreadKey, ThreadState>,
  key: ThreadKey,
  ts: ThreadState,
): Map<ThreadKey, ThreadState> {
  const next = new Map(threads);
  next.set(key, ts);
  return next;
}

// ── Reducer ──────────────────────────────────────────────────────────

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_AGENTS':
      return { ...state, agents: action.agents };

    case 'ADD_MESSAGES': {
      let { threads } = state;
      for (const msg of action.messages) {
        const key = threadKeyForMessage(msg, action.viewer);
        const ts = getThread(threads, key);
        if (!ts.messages.some((m) => m.id === msg.id)) {
          threads = setThread(threads, key, {
            messages: [...ts.messages, msg].sort((a, b) => a.ts - b.ts),
            unread: ts.unread,
          });
        }
      }
      return { ...state, threads };
    }

    case 'RECEIVE_MESSAGE': {
      const key = threadKeyForMessage(action.message, action.viewer);
      const ts = getThread(state.threads, key);
      if (ts.messages.some((m) => m.id === action.message.id)) return state;
      const isActive = key === state.currentThread;
      return {
        ...state,
        // Auto-scroll to bottom when a new message arrives on the active thread
        scrollOffset: isActive ? 0 : state.scrollOffset,
        threads: setThread(state.threads, key, {
          messages: [...ts.messages, action.message],
          unread: isActive ? ts.unread : ts.unread + 1,
        }),
      };
    }

    case 'SWITCH_THREAD': {
      const ts = getThread(state.threads, action.key);
      return {
        ...state,
        currentThread: action.key,
        scrollOffset: 0,
        threads: setThread(state.threads, action.key, { ...ts, unread: 0 }),
      };
    }

    case 'SET_COMPOSER':
      return { ...state, composerText: action.text };

    case 'SCROLL': {
      // Clamp so the viewport never scrolls past the first line.
      const max = Math.max(0, action.maxLines - action.viewportLines);
      const next = Math.max(0, Math.min(max, state.scrollOffset + action.delta));
      return { ...state, scrollOffset: next };
    }
    case 'SET_CONNECTED':
      return { ...state, connected: action.value };
    case 'SET_ERROR':
      return { ...state, error: action.error };
  }
}

const INITIAL_STATE: State = {
  threads: new Map(),
  agents: [],
  currentThread: null,
  composerText: '',
  scrollOffset: 0,
  connected: false,
  error: null,
};

// ── Component ────────────────────────────────────────────────────────

export function App({ client, briefing }: Props) {
  const selfCallsign = briefing.callsign;
  const selfRole = briefing.role;
  const teamName = briefing.squadron.name;
  const teamMission = briefing.squadron.mission;
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  // ── Bootstrap: history + roster + SSE ──
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;

    async function bootstrap() {
      // Step 1: initial history + roster. If either fails we surface
      // the error and STOP — opening a subscription on top of a
      // half-loaded state would paper over the problem.
      try {
        const [history, roster] = await Promise.all([
          client.history({ limit: 100 }),
          client.roster(),
        ]);
        if (ac.signal.aborted) return;
        dispatch({ type: 'ADD_MESSAGES', messages: history, viewer: selfCallsign });
        dispatch({ type: 'SET_AGENTS', agents: roster.connected });
      } catch (err) {
        if (ac.signal.aborted) return;
        dispatch({
          type: 'SET_ERROR',
          error: `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      // Step 2: live SSE subscription.
      dispatch({ type: 'SET_CONNECTED', value: true });
      try {
        for await (const msg of client.subscribe(selfCallsign, ac.signal)) {
          dispatch({ type: 'RECEIVE_MESSAGE', message: msg, viewer: selfCallsign });
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        dispatch({ type: 'SET_CONNECTED', value: false });
        dispatch({
          type: 'SET_ERROR',
          error: `connection lost: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    void bootstrap();
    return () => ac.abort();
  }, [client, selfCallsign]);

  // ── Periodic roster refresh ──
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const roster = await client.roster();
        dispatch({ type: 'SET_AGENTS', agents: roster.connected });
      } catch (err) {
        // Roster failures are usually transient (broker restart,
        // flaky network). We don't flip `connected` here — the SSE
        // subscription is the authoritative connection signal. But
        // we surface the error so it's visible if it persists.
        dispatch({
          type: 'SET_ERROR',
          error: `roster refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [client]);

  // ── Derived state ──
  const threadKeys: ThreadKey[] = [null];
  const seen = new Set<string>();
  for (const key of state.threads.keys()) {
    if (key !== null && !seen.has(key)) {
      seen.add(key);
      threadKeys.push(key);
    }
  }
  for (const agent of state.agents) {
    if (agent.agentId !== selfCallsign && !seen.has(agent.agentId)) {
      seen.add(agent.agentId);
      threadKeys.push(agent.agentId);
    }
  }

  const currentTs = getThread(state.threads, state.currentThread);
  const currentMessages = currentTs.messages;
  const onlineCount = state.agents.filter((a) => a.connected > 0).length;

  const threadKeysRef = useRef(threadKeys);
  threadKeysRef.current = threadKeys;

  // ── Layout + pre-rendered lines ──
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;
  const innerWidth = cols - 2;
  const transcriptLines = Math.max(rows - 8, 4);
  const bodyWidth = Math.max(20, innerWidth - 2); // -2 for paddingX

  const renderedLines = useMemo(
    () => renderToLines(currentMessages, selfCallsign, bodyWidth),
    [currentMessages, selfCallsign, bodyWidth],
  );

  const totalLines = renderedLines.length;
  const totalLinesRef = useRef(totalLines);
  totalLinesRef.current = totalLines;
  const transcriptLinesRef = useRef(transcriptLines);
  transcriptLinesRef.current = transcriptLines;

  // ── Actions ──
  const sendMessage = useCallback(
    async (text: string) => {
      try {
        if (state.currentThread === null) {
          await client.push({ body: text });
        } else {
          await client.push({ agentId: state.currentThread, body: text });
        }
      } catch (err) {
        dispatch({
          type: 'SET_ERROR',
          error: `send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [client, state.currentThread],
  );

  useInput(
    useCallback(
      (input: string, key: Record<string, boolean | undefined>) => {
        const tkeys = threadKeysRef.current;

        // Number keys 1-9 switch threads only when the composer is empty.
        // When typing a message, digits go to the composer instead.
        if (
          !key.ctrl &&
          !key.meta &&
          input >= '1' &&
          input <= '9' &&
          state.composerText.length === 0
        ) {
          const idx = Number.parseInt(input, 10) - 1;
          if (idx < tkeys.length) {
            dispatch({ type: 'SWITCH_THREAD', key: tkeys[idx] ?? null });
          }
          return;
        }

        // Scroll: arrow up/down by 1 line, pageUp/pageDown by half viewport.
        if (key.upArrow) {
          dispatch({
            type: 'SCROLL',
            delta: 1,
            maxLines: totalLinesRef.current,
            viewportLines: transcriptLinesRef.current,
          });
          return;
        }
        if (key.downArrow) {
          dispatch({
            type: 'SCROLL',
            delta: -1,
            maxLines: totalLinesRef.current,
            viewportLines: transcriptLinesRef.current,
          });
          return;
        }
        if (key.pageUp) {
          dispatch({
            type: 'SCROLL',
            delta: Math.floor(transcriptLinesRef.current / 2),
            maxLines: totalLinesRef.current,
            viewportLines: transcriptLinesRef.current,
          });
          return;
        }
        if (key.pageDown) {
          dispatch({
            type: 'SCROLL',
            delta: -Math.floor(transcriptLinesRef.current / 2),
            maxLines: totalLinesRef.current,
            viewportLines: transcriptLinesRef.current,
          });
          return;
        }

        if (key.tab) {
          const idx = tkeys.indexOf(state.currentThread);
          const next = key.shift
            ? (idx - 1 + tkeys.length) % tkeys.length
            : (idx + 1) % tkeys.length;
          dispatch({ type: 'SWITCH_THREAD', key: tkeys[next] ?? null });
          return;
        }
        if (key.return) {
          const text = state.composerText.trim();
          if (!text) return;
          dispatch({ type: 'SET_COMPOSER', text: '' });
          void sendMessage(text);
          return;
        }
        if (key.backspace || key.delete) {
          dispatch({ type: 'SET_COMPOSER', text: state.composerText.slice(0, -1) });
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          dispatch({ type: 'SET_COMPOSER', text: state.composerText + input });
        }
      },
      [state.currentThread, state.composerText, sendMessage],
    ),
  );

  const threadLabel =
    state.currentThread === null ? 'PRIMARY' : `DM ${state.currentThread.toUpperCase()}`;

  return (
    <Box flexDirection="column" height={rows} borderStyle="bold" borderColor={PRIMARY}>
      {/* ── Header ── */}
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color={PRIMARY}>
            C17
          </Text>
          <Text>{'  '}</Text>
          <Text bold>{selfCallsign.toUpperCase()}</Text>
          <Text color="gray"> · </Text>
          <Text color="gray">{selfRole}</Text>
          <Text color="gray"> · </Text>
          <Text color="gray">{teamName}</Text>
        </Box>
        <Box>
          {state.connected ? (
            <Text bold color={PRIMARY}>
              ◈ ON NET
            </Text>
          ) : (
            <Text bold color="red">
              ◇ OFF NET
            </Text>
          )}
          <Text>{'  '}</Text>
          <Text color="gray">
            {onlineCount} STN{onlineCount !== 1 ? 'S' : ''}
          </Text>
        </Box>
      </Box>

      {/* ── Tab bar ── */}
      <Box paddingX={1} minHeight={1}>
        {threadKeys.map((key, i) => {
          const active = key === state.currentThread;
          const label = key === null ? 'PRIMARY' : key.toUpperCase();
          const ts = getThread(state.threads, key);
          const hasUnread = ts.unread > 0;
          const num = i + 1;

          return (
            <Box key={key ?? '__primary'}>
              {i > 0 && <Text color="gray"> │ </Text>}
              {active ? (
                <Text bold inverse color={PRIMARY}>
                  {` ${num} ${label} `}
                </Text>
              ) : hasUnread ? (
                <Text>
                  <Text color="gray">{num} </Text>
                  <Text>{label}</Text>
                  <Text bold color="yellow">
                    {' '}
                    {ts.unread}
                  </Text>
                </Text>
              ) : (
                <Text color="gray">
                  {num} {label}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* ── Separator ── */}
      <Text color="gray">{'─'.repeat(innerWidth)}</Text>

      {/* ── Transcript ── */}
      <Box height={transcriptLines} flexDirection="column" paddingX={1} overflow="hidden">
        {currentMessages.length === 0 && !state.connected && (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text color="gray">connecting to net...</Text>
          </Box>
        )}
        {currentMessages.length === 0 && state.connected && (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text color="gray">net is quiet — {teamMission}</Text>
          </Box>
        )}
        {totalLines > 0 &&
          (() => {
            const scrollIndicator = state.scrollOffset > 0 ? 1 : 0;
            const viewport = transcriptLines - scrollIndicator;
            const end = totalLines - state.scrollOffset;
            const start = Math.max(0, end - viewport);
            const visible = renderedLines.slice(start, end);
            return (
              <>
                {scrollIndicator > 0 && (
                  <Text dimColor>{'  ▲ scrolled — ↓ or PgDn to return'}</Text>
                )}
                {visible.map((line, i) => {
                  const lineKey = `ln-${String(start + i)}`;
                  return <Text key={lineKey}>{line}</Text>;
                })}
              </>
            );
          })()}
      </Box>

      {/* ── Separator ── */}
      <Text color="gray">{'─'.repeat(innerWidth)}</Text>

      {/* ── Composer ── */}
      <Box paddingX={1}>
        <Text bold color={PRIMARY}>
          {'> '}
        </Text>
        <Text>{state.composerText}</Text>
        <Text color={PRIMARY}>_</Text>
      </Box>

      {/* ── Status bar ── */}
      <Box paddingX={1} justifyContent="space-between">
        <Text color="gray">{threadLabel}</Text>
        {state.error ? (
          <Text bold color="red">
            {state.error}
          </Text>
        ) : (
          <Text color="gray">TAB switch ENTER send CTRL-C off net</Text>
        )}
      </Box>
    </Box>
  );
}
