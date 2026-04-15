/**
 * Authenticated shell — the main app surface.
 *
 * Layout (CSS grid):
 *
 *   ┌──────────────────────────────────────┐
 *   │ Header                               │
 *   ├──────────┬───────────────────────────┤
 *   │ Sidebar  │ Transcript / RosterPanel  │
 *   │          │                           │
 *   │          ├───────────────────────────┤
 *   │          │ Composer                  │
 *   └──────────┴───────────────────────────┘
 *
 * On mount: fetch briefing + history, open the SSE stream, start
 * the roster polling loop. On unmount: tear everything down.
 *
 * We intentionally don't guard the in-shell bootstrap behind its
 * own loading state — the header just renders once `briefing` is
 * populated, and the transcript falls back to "net is quiet" when
 * there are no messages yet. Progressive reveal avoids a flash of
 * spinner on fast networks.
 */

import { effect } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Composer } from '../components/Composer.js';
import { Header } from '../components/Header.js';
import { ObjectiveCreate } from '../components/ObjectiveCreate.js';
import { ObjectiveDetail } from '../components/ObjectiveDetail.js';
import { ObjectivesPanel } from '../components/ObjectivesPanel.js';
import { RosterPanel } from '../components/RosterPanel.js';
import { Sidebar } from '../components/Sidebar.js';
import { Transcript } from '../components/Transcript.js';
import { loadBriefing } from '../lib/briefing.js';
import { getClient } from '../lib/client.js';
import { appendMessages, messagesByThread } from '../lib/messages.js';
import { loadObjectives } from '../lib/objectives.js';
import { initializePushState } from '../lib/push.js';
import { loadRoster, startRosterPolling } from '../lib/roster.js';
import { logout, session } from '../lib/session.js';
import { startSubscribe, streamConnected } from '../lib/sse.js';
import { initializeLastReadFromStore, markThreadRead } from '../lib/unread.js';
import { currentView } from '../lib/view.js';

export function Shell() {
  const s = session.value;
  const view = currentView.value;

  useEffect(() => {
    if (s.status !== 'authenticated') return;
    const callsign = s.slot;
    let disposeSubscribe: (() => void) | null = null;
    let disposeRoster: (() => void) | null = null;
    let disposeAutoRead: (() => void) | null = null;
    let disposeReconnectRefetch: (() => void) | null = null;

    const boot = async () => {
      try {
        await loadBriefing();
      } catch (err) {
        // A 401 here means the session expired between our last
        // /session check and this mount. Flip to anonymous and let
        // the App gate re-render the login screen.
        if (isUnauthorized(err)) {
          void logout();
          return;
        }
        console.error('briefing failed', err);
      }
      try {
        const history = await getClient().history({ limit: 100 });
        appendMessages(callsign, history);
        // Seed lastRead BEFORE SSE opens so no incoming message can
        // race with the seed and get marked read-on-arrival.
        initializeLastReadFromStore();
      } catch (err) {
        if (isUnauthorized(err)) {
          void logout();
          return;
        }
        console.error('history failed', err);
      }
      try {
        await loadRoster();
      } catch (err) {
        if (isUnauthorized(err)) {
          void logout();
          return;
        }
        console.error('roster failed', err);
      }
      try {
        await loadObjectives();
      } catch (err) {
        if (isUnauthorized(err)) {
          void logout();
          return;
        }
        // Non-fatal — the objectives panel will retry on mount.
        console.error('objectives failed', err);
      }
      disposeRoster = startRosterPolling();
      disposeSubscribe = startSubscribe({
        callsign,
        historyLimit: 50,
        onError: (err) => {
          console.error('sse error', err);
        },
      });

      // Auto-read the active thread: any time the view changes or a
      // new message lands, bump lastRead for the active thread to
      // its latest ts. Keeps the active thread's unread count at 0
      // while the user is watching it. `effect()` is from
      // @preact/signals — reads both signals in its body and
      // re-runs whenever either changes.
      disposeAutoRead = effect(() => {
        const view = currentView.value;
        const map = messagesByThread.value;
        if (view.kind !== 'thread') return;
        const messages = map.get(view.key) ?? [];
        if (messages.length === 0) return;
        const latest = messages[messages.length - 1];
        if (latest) markThreadRead(view.key, latest.ts);
      });

      // Presence-freshness hook: every time our own SSE stream goes
      // from disconnected → connected (initial open, or reconnect
      // after a drop), immediately refetch /roster. This catches the
      // "server restarted, we reconnected, now show who came back"
      // case without waiting for the 10s polling tick. The 10s
      // polling remains as a safety net for cases where presence
      // changed without our stream dropping (e.g. another client
      // disconnecting).
      //
      // We track the previous value inside the effect closure so a
      // false→true transition is distinguishable from steady-state.
      let wasConnected = false;
      disposeReconnectRefetch = effect(() => {
        const nowConnected = streamConnected.value;
        if (nowConnected && !wasConnected) {
          void loadRoster().catch(() => {
            // Swallow — the next polling tick will retry and the
            // roster signal stays at whatever it was.
          });
        }
        wasConnected = nowConnected;
      });

      // Kick off push-state detection in parallel — cheap, no-op if
      // push is unsupported. Populates the signal the NotificationToggle
      // reads; errors inside are fully handled by initializePushState.
      void initializePushState();
    };

    void boot();

    return () => {
      disposeSubscribe?.();
      disposeRoster?.();
      disposeAutoRead?.();
      disposeReconnectRefetch?.();
    };
    // We only want this effect firing when the authenticated slot
    // actually changes (logout → login as a different slot).
  }, [s.status === 'authenticated' ? s.slot : null]);

  if (s.status !== 'authenticated') return null;

  return (
    <main class="h-screen flex flex-col bg-brand-bg text-brand-text">
      <Header />
      <div class="flex flex-1 min-h-0">
        <Sidebar viewer={s.slot} />
        <section class="flex-1 flex flex-col min-w-0">{renderView(view, s.slot)}</section>
      </div>
    </main>
  );
}

/**
 * Route the current view kind to the right panel. Thread views wrap
 * Transcript + Composer; everything else renders a standalone panel
 * in the same flex region.
 */
function renderView(view: ReturnType<(typeof currentView)['peek']>, viewer: string) {
  switch (view.kind) {
    case 'thread':
      return (
        <>
          <Transcript viewer={viewer} />
          <Composer viewer={viewer} />
        </>
      );
    case 'overview':
      return <RosterPanel viewer={viewer} />;
    case 'objectives-list':
      return <ObjectivesPanel viewer={viewer} />;
    case 'objective-detail':
      return <ObjectiveDetail id={view.id} viewer={viewer} />;
    case 'objective-create':
      return <ObjectiveCreate />;
  }
}

/** Narrow error to 401 — the SDK throws `ClientError` with `.status`. */
function isUnauthorized(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: number }).status === 401
  );
}
