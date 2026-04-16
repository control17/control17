/**
 * AgentPage — dedicated overview of a single slot.
 *
 * Layout (top to bottom):
 *   1. Back-to-overview button
 *   2. Header: callsign · role pill · authority · team name · online dot
 *   3. Metadata card: assigned objectives + watching objectives +
 *      last-seen timestamp
 *   4. Activity timeline: live SSE tail of the agent's LLM calls,
 *      opaque HTTP, and objective lifecycle markers
 *
 * Commander-gated. Non-commanders who navigate here see a
 * permission-denied inline error + a back link. Commanders see the
 * full page; a separate `403` from the server on hydration also
 * surfaces the same banner (no crash, no blank page).
 *
 * Entry points: RosterPanel row link, DM thread header link,
 * ObjectiveDetail assignee link.
 */

import type { Objective, Teammate } from '@control17/sdk/types';
import { useEffect } from 'preact/hooks';
import { agentActivityError, startAgentActivitySubscribe } from '../lib/agent-activity.js';
import { briefing } from '../lib/briefing.js';
import { objectives as objectivesSignal } from '../lib/objectives.js';
import { roster as rosterSignal } from '../lib/roster.js';
import { selectDmWith, selectObjectiveDetail, selectOverview } from '../lib/view.js';
import { AgentTimeline } from './AgentTimeline.js';

export interface AgentPageProps {
  callsign: string;
  viewer: string;
}

export function AgentPage({ callsign, viewer }: AgentPageProps) {
  const b = briefing.value;
  const rosterResp = rosterSignal.value;
  const objectives = objectivesSignal.value;
  const errorMessage = agentActivityError.value;

  // Authority gate — commander only. We also show a gentle message
  // if the page was somehow reached by a non-commander (direct nav
  // would normally be impossible since no entry points render it,
  // but defensive belt + suspenders).
  const isCommander = b?.authority === 'commander';

  useEffect(() => {
    if (!isCommander) return;
    // Open the SSE subscription for this agent. Teardown on unmount.
    const teardown = startAgentActivitySubscribe({ callsign });
    return () => teardown();
  }, [callsign, isCommander]);

  if (!b) {
    return (
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        <div class="c17-label text-brand-subtle">━━ Loading briefing…</div>
      </div>
    );
  }

  if (!isCommander) {
    return (
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
        <BackButton />
        <div class="c17-label !text-brand-err border border-brand-err/40 bg-brand-err/10 rounded-sm px-4 py-3">
          ◆ Only commanders may view another slot's activity timeline.
        </div>
      </div>
    );
  }

  // Resolve the slot's metadata from the roster. `teammates` is
  // the authoritative list with role + authority; `connected`
  // carries live SSE subscriber counts keyed by agentId.
  const teammate: Teammate | undefined = rosterResp?.teammates.find((t) => t.callsign === callsign);
  const agent = rosterResp?.connected.find((c) => c.agentId === callsign);
  const isOnline = Boolean(agent && agent.connected > 0);

  // Filter the objectives signal to the slot's view.
  const assigned = objectives.filter(
    (o) => o.assignee === callsign && o.status !== 'done' && o.status !== 'cancelled',
  );
  const watching = objectives.filter(
    (o) =>
      o.assignee !== callsign &&
      o.watchers.includes(callsign) &&
      o.status !== 'done' &&
      o.status !== 'cancelled',
  );

  return (
    <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
      <BackButton />

      {/* ── Header ───────────────────────────────────── */}
      <div>
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="c17-panel-title !text-2xl text-brand-primary-bright">{callsign}</h1>
          <OnlineDot online={isOnline} />
        </div>
        <div class="text-sm text-brand-muted mt-2 font-medium">
          role: <span class="text-brand-text font-semibold">{teammate?.role ?? '—'}</span>
          {teammate?.authority && (
            <>
              {' · '}
              authority: <span class="text-brand-text font-semibold">{teammate.authority}</span>
            </>
          )}
          {' · '}
          team: <span class="text-brand-text font-semibold">{b.squadron.name}</span>
        </div>
        {viewer !== callsign && (
          <button
            type="button"
            onClick={() => selectDmWith(callsign)}
            class="c17-label text-brand-primary hover:text-brand-primary-bright mt-3"
          >
            → Open DM with {callsign}
          </button>
        )}
      </div>

      {/* ── Metadata: assigned / watching objectives ───── */}
      <section class="border border-brand-border-subtle rounded-sm p-4 bg-brand-surface/40">
        <div class="c17-label text-brand-primary mb-3">━━ Objectives</div>
        <ObjectiveRefList label="Assigned" objectives={assigned} emptyLabel="none assigned" />
        <div class="mt-3">
          <ObjectiveRefList label="Watching" objectives={watching} emptyLabel="none" />
        </div>
      </section>

      {errorMessage && (
        <div class="c17-label !text-brand-err border border-brand-err/40 bg-brand-err/10 rounded-sm px-4 py-3">
          ◆ {errorMessage}
        </div>
      )}

      {/* ── Activity timeline ──────────────────────────── */}
      <AgentTimeline />
    </div>
  );
}

function ObjectiveRefList({
  label,
  objectives,
  emptyLabel,
}: {
  label: string;
  objectives: Objective[];
  emptyLabel: string;
}) {
  return (
    <div>
      <div class="text-xs text-brand-subtle font-medium uppercase tracking-wide mb-1">
        {label} ({objectives.length})
      </div>
      {objectives.length === 0 ? (
        <div class="text-xs text-brand-subtle font-medium italic">{emptyLabel}</div>
      ) : (
        <ul class="space-y-1">
          {objectives.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => selectObjectiveDetail(o.id)}
                class="text-sm text-brand-primary hover:text-brand-primary-bright text-left"
              >
                {o.id} — {o.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span class={`c17-label ${online ? 'text-brand-primary-bright' : 'text-brand-subtle'}`}>
      {online ? '● ON NET' : '◇ OFF NET'}
    </span>
  );
}

function BackButton() {
  return (
    <button
      type="button"
      onClick={selectOverview}
      class="c17-label text-brand-subtle hover:text-brand-text mb-3"
    >
      ← Back to overview
    </button>
  );
}
