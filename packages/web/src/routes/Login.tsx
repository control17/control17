/**
 * Login route — TOTP-only, codeless authentication for human operators.
 *
 * One input (6-digit authenticator code) and a submit button. The
 * server iterates enrolled slots and logs the caller in as whichever
 * slot's current TOTP secret matches. No callsign input — the code
 * itself identifies the user. On success the session signal flips to
 * authenticated and the router renders the shell. On failure we show
 * the server's error text and clear the code input so the user can
 * re-enter on the next 30-second rotation.
 */

import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { LoginError, loginWithTotp } from '../lib/session.js';

const code = signal('');
const error = signal<string | null>(null);
const submitting = signal(false);

async function handleSubmit(event: Event) {
  event.preventDefault();
  if (submitting.value) return;
  error.value = null;
  submitting.value = true;
  try {
    await loginWithTotp(code.value.trim());
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

function onCode(event: JSX.TargetedInputEvent<HTMLInputElement>) {
  // Strip non-digits and cap at 6 — TOTP codes are always 6 digits.
  // Keeps the input from accepting pasted 7-char values or spaces.
  const digits = event.currentTarget.value.replace(/\D/g, '').slice(0, 6);
  code.value = digits;
}

const LOGO_PATH =
  'M 168 72 L 177 72 L 184 75 L 256 110 L 263 108 L 268 104 L 290 99 L 294 107 L 293 114 L 275 121 L 291 129 L 296 129 L 305 124 L 318 120 L 324 120 L 328 126 L 327 135 L 311 141 L 325 148 L 347 147 L 365 139 L 388 133 L 406 134 L 426 144 L 428 148 L 426 154 L 407 171 L 393 178 L 351 190 L 353 197 L 378 189 L 382 190 L 385 196 L 385 203 L 383 205 L 364 211 L 360 209 L 356 211 L 360 225 L 383 218 L 387 221 L 389 226 L 389 232 L 387 234 L 370 239 L 362 239 L 370 264 L 371 273 L 355 277 L 336 246 L 319 250 L 328 242 L 326 238 L 324 237 L 310 240 L 321 231 L 320 226 L 315 225 L 302 228 L 315 217 L 310 208 L 280 217 L 275 217 L 272 215 L 261 218 L 250 218 L 152 206 L 150 201 L 153 198 L 163 194 L 164 191 L 147 155 L 144 152 L 136 152 L 150 145 L 97 113 L 107 109 L 115 110 L 171 133 L 175 134 L 182 131 L 188 131 L 190 133 L 188 146 L 205 178 L 208 180 L 258 174 L 270 168 L 264 163 L 248 167 L 258 158 L 242 146 L 225 150 L 236 141 L 224 132 L 208 136 L 218 127 L 210 121 L 204 120 L 191 123 L 200 117 L 198 113 L 207 109 L 157 77 L 167 73 Z';

export function Login() {
  const canSubmit = !submitting.value && /^\d{6}$/.test(code.value);
  return (
    <main class="min-h-screen flex items-center justify-center p-4 sm:p-6 relative">
      {/* Tactical grid background — masked radial so it fades out at the edges */}
      <div
        aria-hidden="true"
        class="absolute inset-0 pointer-events-none"
        style="background-image: linear-gradient(to right, #1a1e1d 1px, transparent 1px), linear-gradient(to bottom, #1a1e1d 1px, transparent 1px); background-size: 64px 64px; mask-image: radial-gradient(ellipse at center, black 20%, transparent 65%); opacity: 0.6;"
      />
      <form
        onSubmit={handleSubmit}
        class="relative w-full max-w-sm bg-brand-surface border border-brand-border rounded-md p-6 sm:p-7 space-y-5"
      >
        <div class="text-center">
          <svg
            viewBox="95 70 335 210"
            class="h-8 w-auto text-brand-primary mx-auto mb-3"
            fill="currentColor"
            aria-label="control17"
            role="img"
          >
            <path d={LOGO_PATH} />
          </svg>
          <div class="c17-headline text-2xl text-brand-text">control17</div>
          <div class="c17-label mt-2 text-brand-subtle">Enter your authenticator code</div>
        </div>

        <label class="block">
          <span class="c17-label block mb-2 text-brand-subtle">━━ 6-digit code</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code.value}
            onInput={onCode}
            placeholder="000000"
            // biome-ignore lint/a11y/noAutofocus: login is a single-field single-purpose page — users land here specifically to type a 6-digit code
            autoFocus
            class="w-full bg-brand-bg-inset border border-brand-border rounded-sm px-3 py-3 text-brand-text text-center text-2xl tracking-[0.3em] font-mono font-semibold focus:outline-none focus:border-brand-primary focus:shadow-[0_0_0_2px_rgba(95,135,95,0.25)]"
          />
        </label>

        {error.value && (
          <div class="c17-label !text-brand-err border border-brand-err/40 bg-brand-err/10 rounded-sm px-3 py-2">
            ◆ {error.value}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          class="c17-btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-brand-primary disabled:hover:border-brand-primary"
        >
          {submitting.value ? 'Signing in…' : 'Sign in →'}
        </button>
      </form>
    </main>
  );
}

/** Test-only reset for login state between it() blocks. */
export function __resetLoginState(): void {
  code.value = '';
  error.value = null;
  submitting.value = false;
}
