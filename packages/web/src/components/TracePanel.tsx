/**
 * TracePanel — commander-only view of captured LLM traces for an
 * objective.
 *
 * Renders as a collapsible section on the ObjectiveDetail screen.
 * Fetches `GET /objectives/:id/traces` on mount, then walks each
 * trace's `entries` array and displays:
 *
 *   - Anthropic messages entries: model, token usage, expandable
 *     message list with text / tool_use / tool_result blocks
 *   - Opaque HTTP entries: host + method + URL + status + header /
 *     body previews
 *
 * Authority gate is checked in the parent — this component only
 * renders when `briefing.authority === 'commander'`. A double-gate
 * is fine; the server is the real boundary. Ajax errors surface as
 * inline error banners, not thrown.
 *
 * The trace content is already redacted server-side (the runner
 * scrubs secrets at upload time), so we render strings verbatim.
 */

import type {
  AnthropicContentBlock,
  AnthropicMessagesEntry,
  ObjectiveTrace,
  OpaqueHttpEntry,
  TraceEntry,
} from '@control17/sdk/types';
import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { getClient } from '../lib/client.js';

const traces = signal<ObjectiveTrace[]>([]);
const loading = signal(false);
const loadError = signal<string | null>(null);
const expanded = signal(true);

async function loadTraces(id: string): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    traces.value = await getClient().listObjectiveTraces(id);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

export function TracePanel({ objectiveId }: { objectiveId: string }): JSX.Element {
  const list = traces.value;
  const isLoading = loading.value;
  const err = loadError.value;
  const isOpen = expanded.value;

  useEffect(() => {
    void loadTraces(objectiveId);
  }, [objectiveId]);

  const header = (
    <button
      type="button"
      onClick={() => {
        expanded.value = !expanded.value;
      }}
      class="w-full flex items-center justify-between c17-label text-brand-primary hover:text-brand-primary-bright"
    >
      <span>━━ Captured traces ({list.length})</span>
      <span class="text-base">{isOpen ? '−' : '+'}</span>
    </button>
  );

  return (
    <section class="border-t border-brand-border-subtle pt-5 space-y-3">
      {header}
      {isOpen && (
        <div class="space-y-2">
          {isLoading && <div class="c17-label text-brand-subtle">━━ Loading traces…</div>}
          {err !== null && (
            <div class="c17-label !text-brand-err border border-brand-err/40 bg-brand-err/10 rounded-sm px-3 py-2">
              ◆ {err}
            </div>
          )}
          {!isLoading && err === null && list.length === 0 && (
            <div class="text-xs text-brand-subtle font-medium italic">
              No traces captured for this objective
            </div>
          )}
          {list.map((trace) => (
            <TraceRow key={trace.id} trace={trace} />
          ))}
        </div>
      )}
    </section>
  );
}

function TraceRow({ trace }: { trace: ObjectiveTrace }): JSX.Element {
  const duration = trace.spanEnd - trace.spanStart;
  return (
    <div class="border border-brand-border-subtle rounded-sm bg-brand-surface/40 p-3">
      <div class="flex items-center justify-between text-xs font-mono font-medium text-brand-muted">
        <span>
          trace #{trace.id} · {trace.provider} · {duration}ms · {trace.entries.length} entries
        </span>
        {trace.truncated && <span class="c17-label text-brand-warn">◆ TRUNCATED</span>}
      </div>
      <div class="mt-2 space-y-2">
        {trace.entries.map((entry, i) => (
          <EntryRow key={`${trace.id}-${i}`} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function EntryRow({ entry }: { entry: TraceEntry }): JSX.Element {
  if (entry.kind === 'anthropic_messages') {
    return <AnthropicEntry entry={entry} />;
  }
  return <OpaqueEntry entry={entry} />;
}

function AnthropicEntry({ entry }: { entry: AnthropicMessagesEntry }): JSX.Element {
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

function OpaqueEntry({ entry }: { entry: OpaqueHttpEntry }): JSX.Element {
  return (
    <div class="border-l-2 border-brand-muted pl-2">
      <div class="text-xs font-mono">
        <span class="text-brand-text">{entry.method}</span>{' '}
        <span class="text-brand-muted">{entry.host}</span>
        <span class="text-brand-text">{entry.url}</span>
        {entry.status !== null && <span class="ml-2 text-brand-primary">{entry.status}</span>}
      </div>
      {entry.requestBodyPreview && (
        <details class="mt-1">
          <summary class="text-xs text-brand-subtle font-medium cursor-pointer">
            request body
          </summary>
          <pre class="text-xs text-brand-muted whitespace-pre-wrap font-mono font-medium mt-1">
            {entry.requestBodyPreview}
          </pre>
        </details>
      )}
      {entry.responseBodyPreview && (
        <details class="mt-1">
          <summary class="text-xs text-brand-subtle font-medium cursor-pointer">
            response body
          </summary>
          <pre class="text-xs text-brand-muted whitespace-pre-wrap font-mono font-medium mt-1">
            {entry.responseBodyPreview}
          </pre>
        </details>
      )}
    </div>
  );
}
