/**
 * Session signal — the SPA's single source of truth for "who am I."
 *
 * Three states:
 *   - `loading`       — initial mount, haven't asked the server yet
 *   - `anonymous`     — confirmed no valid session; show login
 *   - `{slot, role}`  — authenticated; show the shell
 *
 * Components read the signal via Preact's `.value`; writes always go
 * through `bootstrap`, `loginWithTotp`, or `logout` so the state
 * transitions stay auditable in one place.
 */

import type { SessionResponse } from '@control17/sdk/types';
import { signal } from '@preact/signals';
import { getClient } from './client.js';

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | {
      status: 'authenticated';
      slot: string;
      role: string;
      expiresAt: number;
    };

export const session = signal<SessionState>({ status: 'loading' });

/**
 * Ask the server for the current session. Called once on SPA mount
 * to rehydrate. A 401 (session expired / never existed) resolves the
 * signal to `anonymous` — it's a first-class state, not an error.
 */
export async function bootstrap(): Promise<void> {
  try {
    const current = await getClient().currentSession();
    if (current === null) {
      session.value = { status: 'anonymous' };
      return;
    }
    session.value = authenticatedFrom(current);
  } catch {
    // Network error, server down, corrupted response — treat as
    // anonymous so the SPA shows the login screen and the user
    // can retry. Surfaces cleanly rather than stranding them on
    // a loading spinner.
    session.value = { status: 'anonymous' };
  }
}

/**
 * Submit a TOTP login. On success the server sets the session cookie
 * and we update the signal to authenticated. On failure we throw
 * `LoginError` so the Login component can render a user-facing message.
 */
export async function loginWithTotp(slot: string, code: string): Promise<void> {
  try {
    const result = await getClient().loginWithTotp({ slot, code });
    session.value = authenticatedFrom(result);
  } catch (err) {
    throw new LoginError(err instanceof Error && err.message ? err.message : 'login failed');
  }
}

/**
 * Drop the server-side session and clear local state. Always resets
 * the signal to `anonymous` — even if the server call fails, the
 * user's intent was "sign out" and leaving them in an authenticated
 * state would be confusing.
 */
export async function logout(): Promise<void> {
  try {
    await getClient().logout();
  } catch {
    // Best-effort; the cookie will be cleared on the next cookie-auth
    // request (server returns 401) even if this POST didn't reach it.
  }
  session.value = { status: 'anonymous' };
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

function authenticatedFrom(resp: SessionResponse): SessionState {
  return {
    status: 'authenticated',
    slot: resp.slot,
    role: resp.role,
    expiresAt: resp.expiresAt,
  };
}
