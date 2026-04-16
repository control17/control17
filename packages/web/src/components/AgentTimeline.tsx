/**
 * AgentTimeline — live feed of an agent's activity stream.
 *
 * Renders rows from `agentActivityRows` (newest-first) with visual
 * differentiation per event kind:
 *
 *   - `objective_open`  — green bracket marker
 *   - `objective_close` — muted bracket marker with the terminal
 *     reason (done / cancelled / reassigned / runner_shutdown)
 *   - `llm_exchange`    — expandable card with model, token
 *     usage, and the full message list (reuses the same content
 *     block renderer as TracePanel)
 *   - `opaque_http`     — one-line method / host / url / status
 *
 * The filter bar toggles kinds in the rendered output — the
 * underlying list isn't refetched, so toggling back shows
 * everything instantly without a round trip.
 *
 * "Load older" button at the bottom calls
 * `loadOlderAgentActivity()` which extends the list with a
 * time-range query against the server.
 *
 * All data comes from the `lib/agent-activity.js` signals —
 * component is dumb, just renders the current state.
 */

import type {
  AgentActivityEvent,
  AgentActivityLlmExchange,
  AgentActivityObjectiveClose,
  AgentActivityObjectiveOpen,
  AgentActivityOpaqueHttp,
  AgentActivityRow,
  AnthropicContentBlock,
  AnthropicMessagesEntry,
} from '@control17/sdk/types';
import { signal } from '@preact/signals';
import {
  agentActivityConnected,
  agentActivityExhausted,
  agentActivityLoading,
  agentActivityRows,
  loadOlderAgentActivity,
} from '../lib/agent-activity.js';
import { highlightXmlTags } from '../lib/channel-highlight.js';
import { selectObjectiveDetail } from '../lib/view.js';

type KindFilter = Record<AgentActivityEvent['kind'], boolean>;

const DEFAULT_FILTERS: KindFilter = {
  objective_open: true,
  objective_close: true,
  llm_exchange: true,
  opaque_http: true,
};

const kindFilters = signal<KindFilter>({ ...DEFAULT_FILTERS });

export function AgentTimeline() {
  const rows = agentActivityRows.value;
  const loading = agentActivityLoading.value;
  const connected = agentActivityConnected.value;
  const exhausted = agentActivityExhausted.value;
  const filters = kindFilters.value;

  const filteredRows = rows.filter((row) => filters[row.event.kind]);

  return (
    <section class="border border-brand-border-subtle rounded-sm p-4 bg-brand-surface/40 space-y-3">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <div class="c17-label text-brand-primary">
          ━━ Activity ({filteredRows.length})
          {!connected && <span class="ml-3 text-brand-warn">◆ OFFLINE</span>}
        </div>
        <FilterBar filters={filters} />
      </div>

      {rows.length === 0 && loading && (
        <div class="c17-label text-brand-subtle">━━ Loading activity…</div>
      )}
      {rows.length === 0 && !loading && (
        <div class="text-xs text-brand-subtle font-medium italic">
          No activity yet — the runner hasn't observed any traffic for this slot.
        </div>
      )}

      <ol class="space-y-2">
        {filteredRows.map((row) => (
          <li key={row.id}>
            <RowRenderer row={row} />
          </li>
        ))}
      </ol>

      {rows.length > 0 && !exhausted && (
        <div class="pt-2">
          <button
            type="button"
            onClick={() => void loadOlderAgentActivity()}
            disabled={loading}
            class="c17-label text-brand-primary hover:text-brand-primary-bright disabled:opacity-40"
          >
            {loading ? '━━ Loading…' : '↓ Load older'}
          </button>
        </div>
      )}
      {exhausted && rows.length > 0 && (
        <div class="text-xs text-brand-subtle font-medium italic pt-1">— end of activity —</div>
      )}
    </section>
  );
}

function FilterBar({ filters }: { filters: KindFilter }) {
  const kinds: Array<{ key: AgentActivityEvent['kind']; label: string }> = [
    { key: 'llm_exchange', label: 'LLM' },
    { key: 'opaque_http', label: 'HTTP' },
    { key: 'objective_open', label: 'obj open' },
    { key: 'objective_close', label: 'obj close' },
  ];
  return (
    <div class="flex items-center gap-2 flex-wrap">
      {kinds.map(({ key, label }) => {
        const on = filters[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => {
              kindFilters.value = { ...filters, [key]: !on };
            }}
            class={
              'text-xs font-mono font-medium px-2 py-0.5 border rounded-sm ' +
              (on
                ? 'border-brand-primary-dim bg-brand-primary-faint text-brand-primary-bright'
                : 'border-brand-border-subtle text-brand-subtle hover:text-brand-text')
            }
          >
            {on ? '●' : '○'} {label}
          </button>
        );
      })}
    </div>
  );
}

function RowRenderer({ row }: { row: AgentActivityRow }) {
  const event = row.event;
  switch (event.kind) {
    case 'objective_open':
      return <ObjectiveOpenRow event={event} />;
    case 'objective_close':
      return <ObjectiveCloseRow event={event} />;
    case 'llm_exchange':
      return <LlmExchangeRow event={event} />;
    case 'opaque_http':
      return <OpaqueHttpRow event={event} />;
  }
}

function ObjectiveOpenRow({ event }: { event: AgentActivityObjectiveOpen }) {
  return (
    <div class="flex items-center gap-3 text-xs font-mono font-medium text-brand-primary-bright border-l-2 border-brand-primary pl-3 py-1">
      <span>{formatTs(event.ts)}</span>
      <span>▼</span>
      <button
        type="button"
        onClick={() => selectObjectiveDetail(event.objectiveId)}
        class="text-brand-primary-bright hover:text-brand-primary underline-offset-2 hover:underline"
      >
        {event.objectiveId}
      </button>
      <span class="text-brand-subtle">opened</span>
    </div>
  );
}

function ObjectiveCloseRow({ event }: { event: AgentActivityObjectiveClose }) {
  return (
    <div class="flex items-center gap-3 text-xs font-mono font-medium text-brand-subtle border-l-2 border-brand-border-subtle pl-3 py-1">
      <span>{formatTs(event.ts)}</span>
      <span>▲</span>
      <button
        type="button"
        onClick={() => selectObjectiveDetail(event.objectiveId)}
        class="text-brand-text hover:text-brand-primary-bright underline-offset-2 hover:underline"
      >
        {event.objectiveId}
      </button>
      <span>closed ({event.result})</span>
    </div>
  );
}

function LlmExchangeRow({ event }: { event: AgentActivityLlmExchange }) {
  const usage = event.entry.response?.usage;
  return (
    <div class="border border-brand-border-subtle rounded-sm bg-brand-bg-inset/40 p-3">
      <div class="flex items-center justify-between text-xs font-mono font-medium text-brand-muted">
        <span>
          {formatTs(event.ts)} · {event.duration}ms
        </span>
        <span>
          <span class="text-brand-text font-semibold">{event.entry.request.model ?? '?'}</span>
          {usage && (
            <span class="ml-2">
              in={usage.inputTokens ?? '?'} out={usage.outputTokens ?? '?'}
              {usage.cacheReadInputTokens !== null && usage.cacheReadInputTokens > 0 && (
                <span> cache_hit={usage.cacheReadInputTokens}</span>
              )}
            </span>
          )}
          {event.entry.response?.stopReason && (
            <span class="ml-2">stop={event.entry.response.stopReason}</span>
          )}
        </span>
      </div>
      <div class="mt-2">
        <AnthropicEntryView entry={event.entry} />
      </div>
    </div>
  );
}

function OpaqueHttpRow({ event }: { event: AgentActivityOpaqueHttp }) {
  const entry = event.entry;
  return (
    <div class="text-xs font-mono font-medium border-l-2 border-brand-muted pl-3 py-1">
      <span class="text-brand-subtle">{formatTs(event.ts)}</span>{' '}
      <span class="text-brand-text">{entry.method}</span>{' '}
      <span class="text-brand-muted">{entry.host}</span>
      <span class="text-brand-text">{entry.url}</span>
      {entry.status !== null && <span class="ml-2 text-brand-primary">{entry.status}</span>}
    </div>
  );
}

// ── Shared Anthropic entry renderer ──────────────────────────────
//
// Duplicated from TracePanel.tsx to keep the two components
// independent. A later refactor can hoist these into a shared
// `AnthropicEntryView` module; for now the duplication is ~80 lines
// and isn't hurting anything.

function AnthropicEntryView({ entry }: { entry: AnthropicMessagesEntry }) {
  return (
    <div class="border-l-2 border-brand-primary pl-2">
      {entry.request.system && (
        <details class="mt-1">
          <summary class="text-xs text-brand-subtle font-medium cursor-pointer hover:text-brand-text">
            system prompt
          </summary>
          <pre class="text-xs text-brand-text whitespace-pre-wrap mt-1 font-mono">
            {entry.request.system}
          </pre>
        </details>
      )}
      <details class="mt-1">
        <summary class="text-xs text-brand-subtle font-medium cursor-pointer hover:text-brand-text">
          messages ({entry.request.messages.length + (entry.response?.messages.length ?? 0)})
        </summary>
        <div class="mt-1 space-y-1">
          {entry.request.messages.map((m, i) => (
            <MessageBlock key={`req-${i}`} role={m.role} content={m.content} />
          ))}
          {entry.response?.messages.map((m, i) => (
            <MessageBlock key={`resp-${i}`} role={m.role} content={m.content} />
          ))}
        </div>
      </details>
    </div>
  );
}

function MessageBlock({ role, content }: { role: string; content: AnthropicContentBlock[] }) {
  return (
    <div class="text-xs border-l border-brand-border-subtle pl-3">
      <div class="c17-label text-brand-subtle">{role}</div>
      {content.map((block, i) => (
        <ContentBlock key={i} block={block} />
      ))}
    </div>
  );
}

function ContentBlock({ block }: { block: AnthropicContentBlock }) {
  if (block.type === 'text') {
    const highlighted = highlightXmlTags(block.text);
    if (highlighted !== null) {
      return (
        <pre
          class="text-xs text-brand-text whitespace-pre-wrap font-mono"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      );
    }
    return <pre class="text-xs text-brand-text whitespace-pre-wrap font-mono">{block.text}</pre>;
  }
  if (block.type === 'tool_use') {
    return (
      <div class="text-xs">
        <span class="text-brand-primary">tool_use</span>{' '}
        <span class="text-brand-text">{block.name}</span>{' '}
        <span class="text-brand-muted">({block.id})</span>
        <pre class="text-xs text-brand-muted whitespace-pre-wrap font-mono font-medium mt-0.5">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === 'tool_result') {
    return (
      <div class="text-xs">
        <span class={block.isError ? 'text-brand-err' : 'text-brand-primary'}>tool_result</span>{' '}
        <span class="text-brand-muted">({block.toolUseId})</span>
        <pre class="text-xs text-brand-muted whitespace-pre-wrap font-mono font-medium mt-0.5">
          {typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === 'thinking') {
    return (
      <div class="text-xs italic text-brand-muted">
        thinking: <pre class="whitespace-pre-wrap font-mono inline">{block.text}</pre>
      </div>
    );
  }
  if (block.type === 'image') {
    return (
      <div class="text-xs text-brand-muted italic">
        [image{block.mediaType ? ` ${block.mediaType}` : ''}]
      </div>
    );
  }
  return (
    <div class="text-xs text-brand-muted italic">
      [unknown block: {JSON.stringify(block.raw).slice(0, 60)}…]
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(11, 19);
}

/** Test-only reset for filters so unit tests start clean. */
export function __resetAgentTimelineForTests(): void {
  kindFilters.value = { ...DEFAULT_FILTERS };
}
