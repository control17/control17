/**
 * Root component for @control17/web.
 *
 * Phase 4 wires auth. The flow:
 *   1. `bootstrap()` runs once on mount, calling GET /session to
 *      rehydrate any existing cookie. Sets the session signal to
 *      `loading`, then `authenticated` or `anonymous`.
 *   2. The gate below reads the signal and renders Boot → Login → Shell.
 *
 * No router in this phase — the three states ARE the routing. Phase 5
 * introduces preact-iso for deep links inside the authenticated shell
 * (channel vs DM threads, settings, etc).
 */

import { useEffect } from 'preact/hooks';
import { bootstrap, session } from './lib/session.js';
import { Boot } from './routes/Boot.js';
import { Login } from './routes/Login.js';
import { Shell } from './routes/Shell.js';

export function App() {
  // Bootstrap once on mount. Empty dep array is intentional — we
  // only want this firing once per page load.
  useEffect(() => {
    void bootstrap();
  }, []);

  const state = session.value;
  if (state.status === 'loading') return <Boot />;
  if (state.status === 'anonymous') return <Login />;
  return <Shell />;
}
