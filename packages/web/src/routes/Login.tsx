/**
 * Login route — TOTP-only authentication for human operators.
 *
 * Two inputs (callsign + 6-digit code) and a submit button. No slot
 * list / dropdown: we don't leak the roster pre-auth. On success the
 * session signal flips to authenticated and the router renders the
 * shell. On failure we show the server's error text and clear the
 * code input so the user can try again without retyping the callsign.
 */

import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { LoginError, loginWithTotp } from '../lib/session.js';

const callsign = signal('');
const code = signal('');
const error = signal<string | null>(null);
const submitting = signal(false);

async function handleSubmit(event: Event) {
  event.preventDefault();
  if (submitting.value) return;
  error.value = null;
  submitting.value = true;
  try {
    await loginWithTotp(callsign.value.trim(), code.value.trim());
    // On success the session signal flips and the Router unmounts
    // this component — no further state to manage here.
  } catch (err) {
    if (err instanceof LoginError) {
      error.value = err.message;
    } else {
      error.value = err instanceof Error ? err.message : 'unexpected error';
    }
    code.value = '';
  } finally {
    submitting.value = false;
  }
}

function onCallsign(event: JSX.TargetedInputEvent<HTMLInputElement>) {
  callsign.value = event.currentTarget.value;
}

function onCode(event: JSX.TargetedInputEvent<HTMLInputElement>) {
  // Strip non-digits and cap at 6 — TOTP codes are always 6 digits.
  // Keeps the input from accepting pasted 7-char values or spaces.
  const digits = event.currentTarget.value.replace(/\D/g, '').slice(0, 6);
  code.value = digits;
}

export function Login() {
  const canSubmit =
    !submitting.value && callsign.value.trim().length > 0 && /^\d{6}$/.test(code.value);
  return (
    <main class="min-h-screen flex items-center justify-center p-4 sm:p-6">
      <form
        onSubmit={handleSubmit}
        class="w-full max-w-sm bg-brand-surface border border-brand-border rounded-lg p-5 sm:p-6 space-y-4"
      >
        <div class="text-center">
          <div class="text-2xl font-bold text-brand-primary">control17</div>
          <div class="text-xs text-brand-muted mt-1">sign in with your authenticator code</div>
        </div>

        <label class="block">
          <span class="text-xs text-brand-muted uppercase tracking-wide">Callsign</span>
          <input
            type="text"
            autoComplete="username"
            autoCapitalize="off"
            spellcheck={false}
            value={callsign.value}
            onInput={onCallsign}
            placeholder="ACTUAL"
            class="mt-1 w-full bg-brand-bg border border-brand-border rounded px-3 py-2 text-brand-text focus:outline-none focus:border-brand-primary"
          />
        </label>

        <label class="block">
          <span class="text-xs text-brand-muted uppercase tracking-wide">6-digit code</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code.value}
            onInput={onCode}
            placeholder="000000"
            class="mt-1 w-full bg-brand-bg border border-brand-border rounded px-3 py-2 text-brand-text text-center tracking-widest font-mono focus:outline-none focus:border-brand-primary"
          />
        </label>

        {error.value && (
          <div class="text-xs text-red-400 border border-red-900/50 bg-red-950/30 rounded px-3 py-2">
            {error.value}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          class="w-full rounded bg-brand-primary text-brand-bg font-semibold py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
        >
          {submitting.value ? 'signing in…' : 'sign in'}
        </button>
      </form>
    </main>
  );
}

/** Test-only reset for login state between it() blocks. */
export function __resetLoginState(): void {
  callsign.value = '';
  code.value = '';
  error.value = null;
  submitting.value = false;
}
