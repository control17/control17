/**
 * Current-view signal — which thread or panel is active in the shell.
 *
 * We use a signal rather than URL routing for v1. URL routing is a
 * nice-to-have for deep links and the back button, but it adds
 * complexity for little benefit in a single-page chat app. Can bolt
 * on preact-iso later if users ask for it.
 *
 * `overview` is the team-overview panel: team name, mission, brief,
 * and the full roster with click-to-DM. The enum used to be named
 * `roster` back when the panel only showed the slot list, but it
 * grew and the external label is "Overview" — so the internal state
 * tracks that. The component is still called `RosterPanel` since its
 * dominant content is the teammate list.
 */

import { signal } from '@preact/signals';
import { dmThreadKey, PRIMARY_THREAD } from './messages.js';

export type View = { kind: 'thread'; key: string } | { kind: 'overview' };

export const currentView = signal<View>({ kind: 'thread', key: PRIMARY_THREAD });

/**
 * Sidebar drawer open state — only meaningful at narrow widths where
 * the sidebar is an overlay rather than a static column. At md+ the
 * Sidebar ignores this signal entirely. Kept alongside `currentView`
 * because every view change should also close the drawer — it'd be
 * weird to tap a thread and stay staring at the sidebar on top of it.
 */
export const isSidebarOpen = signal(false);

export function openSidebar(): void {
  isSidebarOpen.value = true;
}

export function closeSidebar(): void {
  isSidebarOpen.value = false;
}

export function selectThread(key: string): void {
  currentView.value = { kind: 'thread', key };
  isSidebarOpen.value = false;
}

/**
 * Open (or switch to) a DM thread with the given counterpart
 * callsign. Used by RosterPanel clicks — the one concrete "start a
 * new conversation" entry point in the SPA. If no messages have
 * been exchanged yet, Sidebar still shows the thread via its
 * currentView-union logic, and Transcript renders a fresh-DM empty
 * state until the first message lands.
 */
export function selectDmWith(callsign: string): void {
  currentView.value = { kind: 'thread', key: dmThreadKey(callsign) };
  isSidebarOpen.value = false;
}

export function selectOverview(): void {
  currentView.value = { kind: 'overview' };
  isSidebarOpen.value = false;
}

export function __resetViewForTests(): void {
  currentView.value = { kind: 'thread', key: PRIMARY_THREAD };
  isSidebarOpen.value = false;
}
