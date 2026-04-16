/**
 * Sidebar — overview shortcut + presence list.
 *
 * Two regions:
 *
 *   ┌───────────────────────┐
 *   │  Overview             │  ← single button, active when view='overview'
 *   ├───────────────────────┤
 *   │  Team Chat            │  ← shared channel, always pinned at top
 *   │                       │
 *   │  build-bot      ●     │  ← teammate row, bright dot = online
 *   │  test-agent-1   ○     │  ← teammate row, dim dot = offline
 *   │  …                    │
 *   └───────────────────────┘
 *
 * Structural change from the old thread-store-union design: the
 * teammate rows now come from the full roster (or briefing as a
 * cold-start fallback), not from "threads that have received a
 * message." Every teammate on the team is always listed as a
 * potential DM target, with a live online/offline indicator.
 *
 * Self is filtered out — you can't usefully DM yourself and the
 * RosterPanel's self-row (labeled "(you)") is the dedicated place
 * to see your own identity in the team.
 */

import type { Teammate } from '@control17/sdk/types';
import { briefing } from '../lib/briefing.js';
import { dmThreadKey, messagesByThread, PRIMARY_THREAD } from '../lib/messages.js';
import { objectives } from '../lib/objectives.js';
import { roster } from '../lib/roster.js';
import { logout } from '../lib/session.js';
import { lastReadByThread, unreadCount } from '../lib/unread.js';
import {
  closeSidebar,
  isSidebarOpen,
  selectDmWith,
  selectObjectivesList,
  selectOverview,
  selectThread,
  view,
} from '../lib/view.js';

export interface SidebarProps {
  viewer: string;
}

/**
 * Unread count pill. Caps displayed count at "99+" so a runaway
 * counter doesn't break the sidebar layout. `flex-shrink-0` keeps
 * the badge visible when a long callsign would otherwise push it
 * out of the row.
 */
function UnreadBadge({ count }: { count: number }) {
  const label = count > 99 ? '99+' : String(count);
  return (
    <span
      class="inline-flex items-center justify-center min-w-[1.25rem] h-[1.125rem] px-1 text-[10px] font-semibold rounded-full bg-brand-primary text-brand-bg flex-shrink-0"
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

export function Sidebar({ viewer }: SidebarProps) {
  // Subscribe to every signal the render reads.
  const v = view.value;
  const r = roster.value;
  const b = briefing.value;
  // Unread state + the message store itself. Both read here so the
  // sidebar re-renders when new messages land or when the active
  // thread's lastRead bumps.
  const lastRead = lastReadByThread.value;
  const msgMap = messagesByThread.value;

  // Teammate list source: roster first (authoritative for presence),
  // briefing teammates as a cold-start fallback so the sidebar
  // populates immediately after Shell mount instead of blinking
  // blank for the ~100ms while /roster is in-flight.
  const teammatesSource: Teammate[] = r?.teammates ?? b?.teammates ?? [];
  const teammates = teammatesSource.filter((t) => t.callsign !== viewer);

  // Build the connection lookup once per render. Only populated once
  // `r` arrives — during the briefing-only fallback window, everyone
  // renders as offline, which is honest (we don't actually know yet).
  const onlineByCallsign = new Map<string, number>();
  if (r) {
    for (const a of r.connected) onlineByCallsign.set(a.agentId, a.connected);
  }

  const overviewActive = v.kind === 'overview';
  const teamChatActive = v.kind === 'thread' && v.key === PRIMARY_THREAD;
  const teamChatUnread = unreadCount(PRIMARY_THREAD, viewer, lastRead, msgMap);
  const drawerOpen = isSidebarOpen.value;
  const objectivesActive =
    v.kind === 'objectives-list' || v.kind === 'objective-detail' || v.kind === 'objective-create';
  // Viewer's active/blocked objective count — surfaced as a badge next
  // to the sidebar entry so a commander sees how loaded a slot is at
  // a glance, and an operator sees what's on their plate without
  // navigating into the panel.
  const activeObjectiveCount = objectives.value.filter(
    (o) => o.assignee === viewer && (o.status === 'active' || o.status === 'blocked'),
  ).length;

  return (
    <>
      {/* Mobile backdrop — only rendered below md when the drawer is
          open. Tapping anywhere outside the sidebar closes it. The
          `md:hidden` keeps it from intercepting clicks on desktop. */}
      {drawerOpen && (
        <button
          type="button"
          onClick={closeSidebar}
          aria-label="Close sidebar"
          class="md:hidden fixed inset-0 z-30 bg-brand-bg/70"
        />
      )}
      <nav
        class={`flex-shrink-0 border-r border-brand-border bg-brand-surface flex-col
          md:static md:flex md:w-48 md:translate-x-0 md:shadow-none md:z-0
          fixed inset-y-0 left-0 z-40 w-60 shadow-2xl transition-transform duration-200
          ${drawerOpen ? 'translate-x-0 flex' : '-translate-x-full hidden md:flex md:-translate-x-0'}`}
      >
        {/* ── Overview + Objectives shortcuts ──────────────────────── */}
        <div class="border-b border-brand-border-subtle py-2">
          <p class="c17-label px-3 pt-2 pb-1">━━ Command</p>
          <button
            type="button"
            onClick={selectOverview}
            aria-label="Open team overview"
            class={`w-full text-left px-3 py-1.5 text-sm truncate ${
              overviewActive
                ? 'bg-brand-primary/20 text-brand-text border-l-4 border-brand-primary'
                : 'text-brand-muted hover:text-brand-text hover:bg-brand-bg/40 border-l-4 border-transparent'
            }`}
          >
            Overview
          </button>
          <button
            type="button"
            onClick={selectObjectivesList}
            aria-label={
              activeObjectiveCount > 0
                ? `Open objectives panel (${activeObjectiveCount} on your plate)`
                : 'Open objectives panel'
            }
            class={`w-full flex items-center gap-2 px-3 py-1.5 text-sm truncate ${
              objectivesActive
                ? 'bg-brand-primary/20 text-brand-text border-l-4 border-brand-primary'
                : 'text-brand-muted hover:text-brand-text hover:bg-brand-bg/40 border-l-4 border-transparent'
            }`}
          >
            <span class="truncate flex-1 text-left">Objectives</span>
            {activeObjectiveCount > 0 && !objectivesActive && (
              <UnreadBadge count={activeObjectiveCount} />
            )}
          </button>
        </div>

        {/* ── Team Chat + teammates ──────────────────────────────── */}
        <ul class="flex-1 overflow-y-auto py-2">
          <li class="mb-1">
            <p class="c17-label px-3 pt-2 pb-1">━━ Squadron</p>
          </li>
          <li>
            <button
              type="button"
              onClick={() => selectThread(PRIMARY_THREAD)}
              aria-label={
                teamChatUnread > 0 ? `Open Team Chat (${teamChatUnread} unread)` : 'Open Team Chat'
              }
              class={`w-full flex items-center gap-2 px-3 py-1.5 text-sm min-w-0 ${
                teamChatActive
                  ? 'bg-brand-primary/20 text-brand-text border-l-4 border-brand-primary'
                  : 'text-brand-muted hover:text-brand-text hover:bg-brand-bg/40 border-l-4 border-transparent'
              }`}
            >
              <span
                class={`truncate flex-1 text-left ${
                  teamChatUnread > 0 && !teamChatActive ? 'font-semibold text-brand-text' : ''
                }`}
              >
                Team Chat
              </span>
              {teamChatUnread > 0 && !teamChatActive && <UnreadBadge count={teamChatUnread} />}
            </button>
          </li>
          {teammates.map((t) => {
            const connected = onlineByCallsign.get(t.callsign) ?? 0;
            const online = connected > 0;
            const active = v.kind === 'thread' && v.key === dmThreadKey(t.callsign);
            const unread = unreadCount(dmThreadKey(t.callsign), viewer, lastRead, msgMap);
            return (
              <li key={t.callsign}>
                <button
                  type="button"
                  onClick={() => selectDmWith(t.callsign)}
                  aria-label={
                    unread > 0
                      ? `Message ${t.callsign} (${online ? 'online' : 'offline'}, ${unread} unread)`
                      : `Message ${t.callsign} (${online ? 'online' : 'offline'})`
                  }
                  class={`w-full flex items-center gap-2 px-3 py-1.5 text-sm min-w-0 ${
                    active
                      ? 'bg-brand-primary/20 text-brand-text border-l-4 border-brand-primary'
                      : 'text-brand-muted hover:text-brand-text hover:bg-brand-bg/40 border-l-4 border-transparent'
                  }`}
                >
                  <span
                    title={online ? 'online' : 'offline'}
                    class={`w-2.5 h-2.5 rounded-full flex-shrink-0 border ${
                      online
                        ? 'bg-brand-primary border-brand-primary'
                        : 'bg-transparent border-brand-muted'
                    }`}
                    aria-hidden="true"
                  />
                  <span
                    class={`truncate flex-1 text-left ${
                      unread > 0 && !active ? 'font-semibold text-brand-text' : ''
                    }`}
                  >
                    {t.callsign}
                  </span>
                  {unread > 0 && !active && <UnreadBadge count={unread} />}
                </button>
              </li>
            );
          })}
        </ul>
        {/* ── Sign-out footer ────────────────────────────────────
          Pinned to the bottom of the sidebar column. `mt-auto` is
          redundant because the teammate `<ul>` above already has
          `flex-1`, but we rely on the nav being a flex column to
          push this block out of the scroll area. */}
        <div class="border-t border-brand-border py-2">
          <button
            type="button"
            onClick={() => {
              void logout();
            }}
            class="w-full text-left px-3 py-1.5 text-sm text-brand-muted hover:text-brand-text hover:bg-brand-bg/40 border-l-4 border-transparent flex items-center gap-2"
            aria-label="Sign out"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4 w-4 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
            <span>sign out</span>
          </button>
        </div>
      </nav>
    </>
  );
}
