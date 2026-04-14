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
 * flips `currentView` to `{kind: 'thread', key: dmThreadKey(other)}`.
 * Sidebar's currentView-union logic picks up the new thread, and
 * Transcript renders a fresh-DM empty state until the first message
 * lands via SSE echo from the user's own send.
 */

import type { Agent } from '@control17/sdk/types';
import { briefing } from '../lib/briefing.js';
import { roster } from '../lib/roster.js';
import { senderTextClass } from '../lib/theme.js';
import { selectDmWith } from '../lib/view.js';

export interface RosterPanelProps {
  viewer: string;
}

export function RosterPanel({ viewer }: RosterPanelProps) {
  const r = roster.value;
  const b = briefing.value;
  if (!r) {
    return (
      <div class="flex-1 flex items-center justify-center text-brand-muted text-sm">
        loading roster…
      </div>
    );
  }
  const connectedByCallsign = new Map<string, Agent>(r.connected.map((a) => [a.agentId, a]));

  return (
    <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
      {/* Mission header — mirrors the sidebar team block so context
          stays visible when the user navigates from the sidebar shortcut
          into the full roster view. */}
      {b && (
        <div class="mb-5 pb-4 border-b border-brand-border">
          <div class="text-[10px] uppercase tracking-wide text-brand-muted mb-1">Team</div>
          <div class="text-lg font-bold text-brand-text">{b.team.name}</div>
          {b.team.mission && (
            <div class="text-sm text-brand-muted mt-1 leading-snug">{b.team.mission}</div>
          )}
          {b.team.brief && (
            <div class="text-xs text-brand-muted mt-2 leading-snug whitespace-pre-wrap">
              {b.team.brief}
            </div>
          )}
        </div>
      )}

      <div class="text-[10px] uppercase tracking-wide text-brand-muted mb-3">
        Team roster — click a teammate to DM
      </div>
      <ul class="space-y-1">
        {r.teammates.map((t) => {
          const conn = connectedByCallsign.get(t.callsign);
          const online = (conn?.connected ?? 0) > 0;
          const colorClass = senderTextClass(t.callsign, viewer);
          const isSelf = t.callsign === viewer;

          const rowContent = (
            <>
              <div class="flex items-center gap-3 min-w-0">
                <span class={`${colorClass} font-semibold`}>{t.callsign}</span>
                {isSelf && <span class="text-[10px] text-brand-muted">(you)</span>}
                <span class="text-brand-muted text-xs">{t.role}</span>
              </div>
              <span class={`text-xs ${online ? 'text-brand-primary' : 'text-brand-muted'}`}>
                {online ? `◈ online (${conn?.connected})` : '◇ offline'}
              </span>
            </>
          );

          // Self-row is not clickable — clicking "message yourself"
          // would be confusing and the self-DM edge case (dm:self) is
          // handled by the sender-fanout path if anyone actually wants
          // it, not by roster clicks.
          if (isSelf) {
            return (
              <li
                key={t.callsign}
                class="flex items-center justify-between border-b border-brand-border/50 py-1.5 px-2"
              >
                {rowContent}
              </li>
            );
          }

          return (
            <li key={t.callsign} class="border-b border-brand-border/50">
              <button
                type="button"
                onClick={() => selectDmWith(t.callsign)}
                class="w-full flex items-center justify-between py-1.5 px-2 rounded hover:bg-brand-bg/40 focus:outline-none focus:bg-brand-bg/60 focus:ring-1 focus:ring-brand-primary/40 transition-colors"
                aria-label={`Message ${t.callsign}`}
              >
                {rowContent}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
