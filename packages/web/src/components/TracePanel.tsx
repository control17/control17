/**
 * TracePanel — commander-only view of captured LLM traces for an
 * objective.
 *
 * In the activity-stream architecture, an "objective trace" is a
 * **time-range slice** of the assignee's agent activity stream
 * rather than a separately-stored table. We query
 * `GET /agents/<assignee>/activity` with:
 *
 *   - `from = objective.createdAt`
 *   - `to   = objective.completedAt ?? now`
 *   - `kind = llm_exchange`
 *
 * and render the resulting LLM exchanges.
 *
 * Authority gate is enforced in two places:
 *   - Client: the parent `ObjectiveDetail` only mounts us when
 *     `briefing.authority === 'commander'`.
 *   - Server: `GET /agents/:callsign/activity` returns 403 to any
 *     non-commander reading another slot.
 *
 * The trace content is already redacted at runner upload time.
 */

import type {
  AgentActivityLlmExchange,
  AnthropicContentBlock,
  AnthropicMessagesEntry,
  Objective,
} from '@control17/sdk/types';
import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { highlightXmlTags } from '../lib/channel-highlight.js';
import { getClient } from '../lib/client.js';

const exchanges = signal<AgentActivityLlmExchange[]>([]);
const loading = signal(false);
const loadError = signal<string | null>(null);
const expanded = signal(true);

async function loadExchanges(objective: Objective): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    // `completedAt` is set iff status === 'done'. For cancelled or
    // still-active objectives we widen the upper bound to "now"
    // so recent activity lands in the view.
    const to = objective.completedAt ?? Date.now();
    const rows = await getClient().listAgentActivity(objective.assignee, {
      from: objective.createdAt,
      to,
      kind: 'llm_exchange',
      limit: 500,
    });
    // The server returns newest-first; we want to render
    // oldest-first so the conversation reads top-down.
    const ordered = [...rows].reverse();
    exchanges.value = ordered
      .map((row) => row.event)
      .filter((ev): ev is AgentActivityLlmExchange => ev.kind === 'llm_exchange');
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

export interface TracePanelProps {
  objective: Objective;
}

export function TracePanel({ objective }: TracePanelProps): JSX.Element {
  const list = exchanges.value;
  const isLoading = loading.value;
  const err = loadError.value;
  const isOpen = expanded.value;

  useEffect(() => {
    void loadExchanges(objective);
  }, [objective.id, objective.completedAt]);

  const header = (
    <button
      type="button"
      onClick={() => {
        expanded.value = !expanded.value;
      }}
      class="w-full flex items-center justify-between c17-label text-brand-primary hover:text-brand-primary-bright"
    >
      <span>━━ LLM exchanges ({list.length})</span>
      <span class="text-base">{isOpen ? '−' : '+'}</span>
    </button>
  );

  return (
    <section class="border-t border-brand-border-subtle pt-5 space-y-3">
      {header}
      {isOpen && (
        <div class="space-y-2">
          {isLoading && <div class="c17-label text-brand-subtle">━━ Loading exchanges…</div>}
          {err !== null && (
            <div class="c17-label !text-brand-err border border-brand-err/40 bg-brand-err/10 rounded-sm px-3 py-2">
              ◆ {err}
            </div>
          )}
          {!isLoading && err === null && list.length === 0 && (
            <div class="text-xs text-brand-subtle font-medium italic">
              No LLM exchanges captured during this objective
            </div>
          )}
          {list.map((exchange, i) => (
            <ExchangeRow key={`${exchange.ts}-${i}`} exchange={exchange} />
          ))}
        </div>
      )}
    </section>
  );
}

function ExchangeRow({ exchange }: { exchange: AgentActivityLlmExchange }): JSX.Element {
  return (
    <div class="border border-brand-border-subtle rounded-sm bg-brand-surface/40 p-3">
      <div class="flex items-center justify-between text-xs font-mono font-medium text-brand-muted">
        <span>
          {new Date(exchange.ts).toISOString().replace('T', ' ').slice(0, 19)} · {exchange.duration}
          ms
        </span>
      </div>
      <div class="mt-2">
        <AnthropicEntryView entry={exchange.entry} />
      </div>
    </div>
  );
}

function AnthropicEntryView({ entry }: { entry: AnthropicMessagesEntry }): JSX.Element {
  const usage = entry.response?.usage;
  return (
    <div class="border-l-2 border-brand-primary pl-2">
      <div class="text-xs text-brand-muted">
        <span class="text-brand-text font-semibold">{entry.request.model ?? '?'}</span>
        {usage && (
          <span class="ml-2">
            in={usage.inputTokens ?? '?'} out={usage.outputTokens ?? '?'}
            {usage.cacheReadInputTokens !== null && usage.cacheReadInputTokens > 0 && (
              <span> cache_hit={usage.cacheReadInputTokens}</span>
            )}
          </span>
        )}
        {entry.response?.stopReason && <span class="ml-2">stop={entry.response.stopReason}</span>}
      </div>
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
      <details class="mt-1" open>
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

function MessageBlock({
  role,
  content,
}: {
  role: string;
  content: AnthropicContentBlock[];
}): JSX.Element {
  return (
    <div class="text-xs border-l border-brand-border-subtle pl-3">
      <div class="c17-label text-brand-subtle">{role}</div>
      {content.map((block, i) => (
        <ContentBlock key={i} block={block} />
      ))}
    </div>
  );
}

function ContentBlock({ block }: { block: AnthropicContentBlock }): JSX.Element {
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
