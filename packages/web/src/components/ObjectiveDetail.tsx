/**
 * Objective detail view — full state, action buttons, inline
 * discussion thread, and the lifecycle event log.
 *
 * Layout (top to bottom):
 *   1. Header: id, status pill, title, assignee/originator
 *   2. Outcome block (always shown — the contract)
 *   3. Body block (if present)
 *   4. Block reason / result block (contextual)
 *   5. Actions (gated by authority + assignee)
 *   6. Inline discussion thread + composer
 *   7. Lifecycle event log (audit trail, collapsible would be nice later)
 *
 * Discussion posts flow through `discussObjective()` which hits the
 * server's `/objectives/:id/discuss` endpoint. The server fans out
 * to every thread member (originator + assignee + commanders) via
 * `broker.push`, and each recipient's SSE stream delivers the message
 * back. The web client's `appendMessages` picks up the explicit
 * `data.thread = 'obj:<id>'` key and files the post into the right
 * thread bucket — `threadMessages('obj:<id>')` then feeds this view.
 */

import type { Message, Objective, ObjectiveEvent } from '@control17/sdk/types';
import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { messagesByThread, objectiveThreadKey, threadMessages } from '../lib/messages.js';
import {
  cancelObjective,
  completeObjective,
  discussObjective,
  fetchObjectiveDetail,
  loadObjectives,
  reassignObjective,
  updateObjective,
  updateObjectiveWatchers,
} from '../lib/objectives.js';
import { roster } from '../lib/roster.js';
import { selectAgentDetail, selectObjectivesList } from '../lib/view.js';
import { MessageLine } from './MessageLine.js';
import { TracePanel } from './TracePanel.js';

export interface ObjectiveDetailProps {
  id: string;
  viewer: string;
}

const detailLoading = signal(true);
const detailError = signal<string | null>(null);
const detailObjective = signal<Objective | null>(null);
const detailEvents = signal<ObjectiveEvent[]>([]);

const actionResult = signal('');
const actionBlockReason = signal('');
const actionReassignTo = signal('');
const actionCancelReason = signal('');
const actionWatcherAdd = signal('');
const actionBusy = signal(false);
const actionError = signal<string | null>(null);

const discussDraft = signal('');
const discussSending = signal(false);
const discussError = signal<string | null>(null);

async function loadDetail(id: string): Promise<void> {
  detailLoading.value = true;
  detailError.value = null;
  try {
    const { objective, events } = await fetchObjectiveDetail(id);
    detailObjective.value = objective;
    detailEvents.value = events;
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err);
  } finally {
    detailLoading.value = false;
  }
}

function resetInputs(): void {
  actionResult.value = '';
  actionBlockReason.value = '';
  actionReassignTo.value = '';
  actionCancelReason.value = '';
  actionWatcherAdd.value = '';
  actionError.value = null;
  discussDraft.value = '';
  discussError.value = null;
  discussSending.value = false;
}

export function ObjectiveDetail({ id, viewer }: ObjectiveDetailProps) {
  const b = briefing.value;
  const current = detailObjective.value;
  const events = detailEvents.value;
  const loading = detailLoading.value;
  const err = detailError.value;

  useEffect(() => {
    resetInputs();
    void loadDetail(id);
  }, [id]);

  if (loading) {
    return (
      <div class="flex-1 flex items-center justify-center text-brand-muted text-sm">
        loading objective…
      </div>
    );
  }
  if (err !== null) {
    return (
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        <BackButton />
        <div class="c17-label !text-brand-err border border-brand-err/40 bg-brand-err/10 rounded-sm px-4 py-3">
          ◆ {err}
        </div>
      </div>
    );
  }
  if (!current || !b) {
    return (
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        <BackButton />
        <div class="c17-label text-brand-subtle">◇ Objective not found</div>
      </div>
    );
  }

  const isAssignee = current.assignee === viewer;
  const isOriginator = current.originator === viewer;
  const isCommander = b.authority === 'commander';
  const isLieutenant = b.authority === 'lieutenant';
  const isWatching = current.watchers.includes(viewer);
  const isTerminal = current.status === 'done' || current.status === 'cancelled';
  const canUpdateStatus = !isTerminal && (isAssignee || isCommander);
  const canComplete = !isTerminal && isAssignee;
  const canCancel = !isTerminal && (isCommander || (isLieutenant && isOriginator));
  const canReassign = !isTerminal && isCommander;
  // Watcher management mirrors the server: commander or originating
  // lieutenant. Watchers can be added/removed on terminal objectives
  // too (maybe a reviewer wants to read the result).
  const canManageWatchers = isCommander || (isLieutenant && isOriginator);
  // Discussion membership: originator + assignee + explicit watchers
  // + all commanders. Operators who aren't any of these can't fetch
  // the objective anyway (the GET endpoint 403s them), so this gate
  // is mostly a visual lock for commanders viewing someone else's
  // objective — they can still post.
  const canDiscuss = isAssignee || isOriginator || isCommander || isWatching;

  const teammates = roster.value?.teammates ?? [];

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    actionBusy.value = true;
    actionError.value = null;
    try {
      const r = await fn();
      await loadDetail(id);
      await loadObjectives();
      return r;
    } catch (e) {
      actionError.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      actionBusy.value = false;
    }
  }

  return (
    <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
      <BackButton />

      <div>
        <div class="flex items-center gap-3 flex-wrap">
          <span class="c17-label text-brand-subtle">{current.id}</span>
          <StatusPill status={current.status} />
        </div>
        <h1 class="c17-panel-title !text-2xl mt-2">{current.title}</h1>
        <div class="text-sm text-brand-muted mt-2 font-medium">
          assignee: <CallsignRef callsign={current.assignee} isCommander={isCommander} /> ·
          originator: <CallsignRef callsign={current.originator} isCommander={isCommander} />
        </div>
      </div>

      <section class="border border-brand-border-subtle rounded-sm p-4 bg-brand-surface/40">
        <div class="c17-label text-brand-primary mb-2">━━ Outcome</div>
        <div class="text-sm text-brand-text whitespace-pre-wrap font-medium leading-relaxed">
          {current.outcome}
        </div>
      </section>

      {current.body && (
        <section class="border border-brand-border-subtle rounded-sm p-4">
          <div class="c17-label text-brand-subtle mb-2">━━ Body</div>
          <div class="text-sm text-brand-text whitespace-pre-wrap font-medium leading-relaxed">
            {current.body}
          </div>
        </section>
      )}

      {current.blockReason && (
        <section class="border border-brand-warn/40 rounded-sm p-4 bg-brand-warn/10">
          <div class="c17-label text-brand-warn mb-2">◆ Blocked</div>
          <div class="text-sm text-brand-coyote-bright whitespace-pre-wrap font-medium leading-relaxed">
            {current.blockReason}
          </div>
        </section>
      )}

      {current.result && (
        <section class="border border-brand-primary-dim rounded-sm p-4 bg-brand-primary-faint">
          <div class="c17-label text-brand-primary mb-2">● Result</div>
          <div class="text-sm text-brand-text whitespace-pre-wrap font-medium leading-relaxed">
            {current.result}
          </div>
        </section>
      )}

      {/* ── Watchers ── */}
      <WatchersSection
        objectiveId={id}
        watchers={current.watchers}
        canManage={canManageWatchers}
        run={run}
      />

      {/* ── Status + completion actions ── */}
      {(canUpdateStatus || canComplete || canCancel || canReassign) && (
        <section class="border-t border-brand-border-subtle pt-5 space-y-4">
          <div class="c17-label text-brand-primary">━━ Actions</div>

          {actionError.value && (
            <div class="c17-label !text-brand-err border border-brand-err/40 bg-brand-err/10 rounded-sm px-3 py-2">
              ◆ {actionError.value}
            </div>
          )}

          {canUpdateStatus && (
            <div class="flex flex-wrap gap-2 items-center">
              {current.status === 'active' && (
                <>
                  <input
                    type="text"
                    value={actionBlockReason.value}
                    onInput={(e) => {
                      actionBlockReason.value = (e.currentTarget as HTMLInputElement).value;
                    }}
                    placeholder="block reason"
                    class="c17-input flex-1 min-w-0 !py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={actionBusy.value || actionBlockReason.value.trim().length === 0}
                    onClick={() =>
                      void run(() =>
                        updateObjective(id, {
                          status: 'blocked',
                          blockReason: actionBlockReason.value.trim(),
                        }),
                      )
                    }
                    class="c17-btn-sm-warn"
                  >
                    ◆ Mark blocked
                  </button>
                </>
              )}
              {current.status === 'blocked' && (
                <button
                  type="button"
                  disabled={actionBusy.value}
                  onClick={() => void run(() => updateObjective(id, { status: 'active' }))}
                  class="c17-btn-sm-ghost"
                >
                  ● Unblock
                </button>
              )}
            </div>
          )}

          {canComplete && (
            <div class="space-y-2">
              <textarea
                rows={3}
                value={actionResult.value}
                onInput={(e) => {
                  actionResult.value = (e.currentTarget as HTMLTextAreaElement).value;
                }}
                placeholder="result — how was the outcome met? (required)"
                class="c17-input !py-2 text-sm"
              />
              <button
                type="button"
                disabled={actionBusy.value || actionResult.value.trim().length === 0}
                onClick={() => void run(() => completeObjective(id, actionResult.value.trim()))}
                class="c17-btn-sm-primary"
              >
                ● Mark complete
              </button>
            </div>
          )}

          {canReassign && (
            <div class="flex flex-wrap gap-2 items-center">
              <select
                value={actionReassignTo.value}
                onChange={(e) => {
                  actionReassignTo.value = (e.currentTarget as HTMLSelectElement).value;
                }}
                class="c17-input !py-1.5 text-sm flex-1 min-w-0"
              >
                <option value="">Reassign to…</option>
                {teammates
                  .filter((t) => t.callsign !== current.assignee)
                  .map((t) => (
                    <option key={t.callsign} value={t.callsign}>
                      {t.callsign} ({t.role})
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={actionBusy.value || actionReassignTo.value.length === 0}
                onClick={() =>
                  void run(() =>
                    reassignObjective(id, {
                      to: actionReassignTo.value,
                    }),
                  )
                }
                class="c17-btn-sm-ghost"
              >
                → Reassign
              </button>
            </div>
          )}

          {canCancel && (
            <div class="flex flex-wrap gap-2 items-center">
              <input
                type="text"
                value={actionCancelReason.value}
                onInput={(e) => {
                  actionCancelReason.value = (e.currentTarget as HTMLInputElement).value;
                }}
                placeholder="cancel reason (optional)"
                class="c17-input flex-1 min-w-0 !py-1.5 text-sm"
              />
              <button
                type="button"
                disabled={actionBusy.value}
                onClick={() =>
                  void run(() =>
                    cancelObjective(id, {
                      ...(actionCancelReason.value.trim()
                        ? { reason: actionCancelReason.value.trim() }
                        : {}),
                    }),
                  )
                }
                class="c17-btn-sm-danger"
              >
                ◇ Cancel objective
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── Discussion thread ── */}
      <DiscussionThread id={id} viewer={viewer} canPost={canDiscuss} terminal={isTerminal} />

      {/* ── Captured LLM traces (commander-only) ── */}
      {isCommander && <TracePanel objective={current} />}

      {/* ── Lifecycle event log ── */}
      <section class="border-t border-brand-border-subtle pt-5">
        <div class="c17-label text-brand-primary mb-3">━━ Lifecycle log</div>
        {events.length === 0 ? (
          <div class="text-xs text-brand-subtle font-medium">(no events)</div>
        ) : (
          <ol class="space-y-1">
            {events.map((ev, i) => (
              <li
                key={`${ev.ts}-${i}`}
                class="text-xs font-mono font-medium text-brand-muted border-l-2 border-brand-border-subtle hover:border-brand-primary-dim pl-3 py-1 transition-colors"
              >
                <span class="text-brand-text-muted">
                  {new Date(ev.ts).toISOString().replace('T', ' ').slice(0, 19)}
                </span>{' '}
                <span class="text-brand-primary-bright font-semibold">{ev.actor}</span>{' '}
                <span class="text-brand-primary">{ev.kind}</span>{' '}
                {Object.keys(ev.payload).length > 0 && (
                  <span class="text-brand-subtle">{JSON.stringify(ev.payload)}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/**
 * Inline objective discussion thread — mini-Transcript + composer
 * bound to the `obj:<id>` thread key. Subscribes to the global
 * messagesByThread signal so any discussion post (whether from this
 * user, another thread member, or a teammate agent) flows in live.
 */
function DiscussionThread({
  id,
  viewer,
  canPost,
  terminal,
}: {
  id: string;
  viewer: string;
  canPost: boolean;
  terminal: boolean;
}) {
  const threadKey = objectiveThreadKey(id);
  // Subscribe to the signal by reading it.
  const _map = messagesByThread.value;
  void _map;
  const messages = threadMessages(threadKey);

  const stickyRef = useRef(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = gap < 80;
  };

  useEffect(() => {
    if (!stickyRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, threadKey]);

  const onInput = (event: JSX.TargetedInputEvent<HTMLTextAreaElement>) => {
    discussDraft.value = event.currentTarget.value;
  };

  const send = async () => {
    const body = discussDraft.value.trim();
    if (!body || discussSending.value) return;
    discussSending.value = true;
    discussError.value = null;
    try {
      await discussObjective(id, { body });
      discussDraft.value = '';
    } catch (err) {
      discussError.value = err instanceof Error ? err.message : String(err);
    } finally {
      discussSending.value = false;
    }
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <section class="border-t border-brand-border-subtle pt-5">
      <div class="c17-label text-brand-primary mb-3">━━ Discussion</div>
      <div
        ref={containerRef}
        onScroll={onScroll}
        class="border border-brand-border-subtle rounded-sm bg-brand-bg-inset max-h-80 overflow-y-auto px-3 py-2 space-y-0.5"
      >
        {messages.length === 0 ? (
          <div class="c17-label text-brand-subtle py-5 text-center">
            ◇ No discussion yet — the objective thread is quiet
          </div>
        ) : (
          messages.map((m: Message, i: number) => (
            <MessageLine
              key={m.id}
              message={m}
              viewer={viewer}
              {...(i > 0 && messages[i - 1] ? { previousMessage: messages[i - 1] } : {})}
            />
          ))
        )}
      </div>

      {canPost && !terminal && (
        <div class="mt-3">
          {discussError.value && (
            <div class="c17-label !text-brand-err mb-2">◆ {discussError.value}</div>
          )}
          <div class="flex items-end gap-2">
            <textarea
              rows={2}
              value={discussDraft.value}
              onInput={onInput}
              onKeyDown={onKeyDown}
              placeholder={`message the obj-${id.replace(/^obj-/, '')} thread — enter to send, shift+enter for newline`}
              class="c17-input flex-1 resize-none !py-2"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={discussSending.value || discussDraft.value.trim().length === 0}
              class="c17-btn-sm-primary flex-shrink-0"
            >
              {discussSending.value ? '…' : 'Send →'}
            </button>
          </div>
        </div>
      )}
      {canPost && terminal && (
        <div class="mt-3 c17-label text-brand-subtle">
          ◇ Discussion closed — objective is {detailObjective.value?.status}
        </div>
      )}
    </section>
  );
}

/**
 * Watchers panel — shows the explicit watcher list with chips, and
 * when the viewer has manage permission, a dropdown to add more +
 * an × on each chip to remove. Commanders are implicit members and
 * never appear here; only explicit non-commander watchers.
 */
function WatchersSection({
  objectiveId,
  watchers,
  canManage,
  run,
}: {
  objectiveId: string;
  watchers: string[];
  canManage: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  const r = roster.value;
  const teammates = r?.teammates ?? [];
  // Candidates for the add dropdown: every teammate who isn't already
  // a watcher. (The server also filters assignee/originator, but
  // we don't know them here — the store silently no-ops those too.)
  const candidates = teammates.filter((t) => !watchers.includes(t.callsign));

  return (
    <section class="border border-brand-border-subtle rounded-sm p-4">
      <div class="c17-label text-brand-subtle mb-3">━━ Watchers</div>
      {watchers.length === 0 ? (
        <div class="text-xs text-brand-subtle font-medium">
          No explicit watchers{' '}
          <span class="text-brand-faint">(commanders see everything automatically)</span>
        </div>
      ) : (
        <div class="flex flex-wrap gap-1.5">
          {watchers.map((w) => (
            <span
              key={w}
              class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs font-display font-semibold uppercase tracking-wide bg-brand-primary-faint border border-brand-primary-dim text-brand-primary-bright"
            >
              <span>{w}</span>
              {canManage && (
                <button
                  type="button"
                  onClick={() =>
                    void run(() => updateObjectiveWatchers(objectiveId, { remove: [w] }))
                  }
                  class="text-brand-primary-dim hover:text-brand-err text-sm leading-none -mr-0.5"
                  aria-label={`Remove watcher ${w}`}
                  title={`Remove ${w}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {canManage && candidates.length > 0 && (
        <div class="mt-3 flex items-center gap-2">
          <select
            value={actionWatcherAdd.value}
            onChange={(e) => {
              actionWatcherAdd.value = (e.currentTarget as HTMLSelectElement).value;
            }}
            class="c17-input !py-1.5 text-xs flex-1"
          >
            <option value="">Add watcher…</option>
            {candidates.map((t) => (
              <option key={t.callsign} value={t.callsign}>
                {t.callsign} ({t.role})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={actionBusy.value || actionWatcherAdd.value.length === 0}
            onClick={() => {
              const cs = actionWatcherAdd.value;
              if (!cs) return;
              void run(async () => {
                const r = await updateObjectiveWatchers(objectiveId, { add: [cs] });
                actionWatcherAdd.value = '';
                return r;
              });
            }}
            class="c17-btn-sm-ghost"
          >
            + Add
          </button>
        </div>
      )}
    </section>
  );
}

function BackButton() {
  return (
    <button
      type="button"
      onClick={selectObjectivesList}
      class="c17-label text-brand-subtle hover:text-brand-text mb-3"
    >
      ← Back to objectives
    </button>
  );
}

/**
 * Render a callsign inline — as a plain span for non-commanders,
 * or as a button that navigates to the agent detail page for
 * commanders.
 */
function CallsignRef({ callsign, isCommander }: { callsign: string; isCommander: boolean }) {
  if (!isCommander) {
    return <span class="text-brand-primary-bright font-semibold">{callsign}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => selectAgentDetail(callsign)}
      class="text-brand-primary-bright font-semibold hover:underline underline-offset-2"
    >
      {callsign}
    </button>
  );
}

function StatusPill({ status }: { status: Objective['status'] }) {
  const styles: Record<Objective['status'], string> = {
    active: 'bg-brand-primary-faint text-brand-primary-bright border-brand-primary-dim',
    blocked: 'bg-brand-warn/10 text-brand-warn border-brand-warn/40',
    done: 'bg-brand-surface text-brand-muted border-brand-border',
    cancelled: 'bg-brand-surface text-brand-subtle border-brand-border line-through',
  };
  return (
    <span
      class={`font-display font-semibold uppercase tracking-widest text-xs px-2.5 py-1 rounded-sm border leading-none ${styles[status]}`}
    >
      {status}
    </span>
  );
}

export function __resetObjectiveDetailForTests(): void {
  detailLoading.value = true;
  detailError.value = null;
  detailObjective.value = null;
  detailEvents.value = [];
  resetInputs();
  actionBusy.value = false;
}
