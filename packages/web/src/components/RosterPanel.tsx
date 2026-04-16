/**
 * Roster panel — full teammate list with connection state + DM
 * initiation.
 *
 * Each teammate row (other than the viewer's own slot) is a button
 * that opens a DM thread with that callsign. This is the sole
 * "start a new conversation" entry point in the SPA: the sidebar
 * only shows threads that already exist (plus the active view),
 * so without this click path there's no way to begin an outbound
 * DM for someone you haven't already talked to.
 *
 * Clicking doesn't write anything to the message store — it just
 * flips `view` to `{kind: 'thread', key: dmThreadKey(other)}`.
 * Sidebar's view-union logic picks up the new thread, and
 * Transcript renders a fresh-DM empty state until the first message
 * lands via SSE echo from the user's own send.
 */

import type { Agent } from '@control17/sdk/types';
import { briefing } from '../lib/briefing.js';
import { roster } from '../lib/roster.js';
import { senderTextClass } from '../lib/theme.js';
import { selectAgentDetail, selectDmWith } from '../lib/view.js';

export interface RosterPanelProps {
  viewer: string;
}

export function RosterPanel({ viewer }: RosterPanelProps) {
  const r = roster.value;
  const b = briefing.value;
  if (!r) {
    return <div class="flex-1 flex items-center justify-center c17-label">━━ Loading roster…</div>;
  }
  const connectedByCallsign = new Map<string, Agent>(r.connected.map((a) => [a.agentId, a]));
  const isCommander = b?.authority === 'commander';

  return (
    <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
      {/* Mission header — mirrors the sidebar team block so context
          stays visible when the user navigates from the sidebar shortcut
          into the full roster view. */}
      {b && (
        <div class="mb-6 pb-5 border-b border-brand-border-subtle">
          <div class="c17-label text-brand-primary mb-2">━━ Squadron</div>
          <div class="c17-panel-title !text-2xl">{b.squadron.name}</div>
          {b.squadron.mission && (
            <div class="text-sm text-brand-text mt-3 leading-relaxed font-medium">
              {b.squadron.mission}
            </div>
          )}
          {b.squadron.brief && (
            <div class="text-xs text-brand-muted mt-2 leading-relaxed font-medium whitespace-pre-wrap">
              {b.squadron.brief}
            </div>
          )}
        </div>
      )}

      <div class="c17-label text-brand-subtle mb-4">━━ Roster · click a teammate to DM</div>
      <ul class="space-y-0">
        {r.teammates.map((t) => {
          const conn = connectedByCallsign.get(t.callsign);
          const online = (conn?.connected ?? 0) > 0;
          const colorClass = senderTextClass(t.callsign, viewer);
          const isSelf = t.callsign === viewer;

          // The teammate identity cluster — callsign + role.
          const identityCluster = (
            <div class="flex items-center gap-3 min-w-0">
              <span
                class={`${colorClass} font-display font-bold uppercase tracking-tight text-sm leading-none`}
              >
                {t.callsign}
              </span>
              {isSelf && (
                <span class="font-display font-semibold uppercase tracking-widest text-[10px] text-brand-subtle leading-none">
                  (you)
                </span>
              )}
              <span class="font-display font-medium uppercase tracking-wide text-xs text-brand-subtle leading-none">
                {t.role}
              </span>
            </div>
          );
          const statusCluster = (
            <span
              class={`font-display font-semibold uppercase tracking-wider text-xs leading-none ${online ? 'text-brand-ok' : 'text-brand-subtle'}`}
            >
              {online ? `● ON NET · ${conn?.connected}` : '◇ OFF NET'}
            </span>
          );

          // Self-row is not clickable — clicking "message yourself"
          // would be confusing and the self-DM edge case (dm:self) is
          // handled by the sender-fanout path if anyone actually wants
          // it, not by roster clicks.
          if (isSelf) {
            return (
              <li
                key={t.callsign}
                class="flex items-center justify-between border-b border-brand-border-subtle py-3 px-3"
              >
                {identityCluster}
                {statusCluster}
              </li>
            );
          }

          // Non-self row: DM button fills the left side (identity +
          // status), optional commander-only "→ AGENT" button on the
          // right. Two real buttons rather than one wrapping button
          // with a nested role=button span.
          return (
            <li
              key={t.callsign}
              class="flex items-center border-b border-brand-border-subtle hover:bg-brand-surface/60 transition-colors"
            >
              <button
                type="button"
                onClick={() => selectDmWith(t.callsign)}
                class="flex-1 flex items-center justify-between py-3 px-3 focus:outline-none focus:bg-brand-primary-faint focus:ring-1 focus:ring-brand-primary/40 text-left"
                aria-label={`Message ${t.callsign}`}
              >
                {identityCluster}
                {statusCluster}
              </button>
              {isCommander && (
                <button
                  type="button"
                  onClick={() => selectAgentDetail(t.callsign)}
                  aria-label={`View ${t.callsign} agent page`}
                  class="font-display font-semibold uppercase tracking-wider text-[10px] leading-none text-brand-subtle hover:text-brand-primary-bright px-3 py-3 border-l border-brand-border-subtle hover:bg-brand-primary-faint"
                >
                  → AGENT
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
