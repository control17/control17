/**
 * Phase 1 auth surface: TOTP verification, session cookies, dual-auth.
 *
 * These tests exercise the new /session/* routes end-to-end through
 * the Hono app, plus the TOTP + SessionStore primitives directly.
 * Existing /roster identity/auth coverage lives in app.test.ts; this
 * file is focused on what's new.
 */

import { Broker, InMemoryEventLog } from '@control17/core';
import type { Role, SessionResponse, Squadron } from '@control17/sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { SESSION_COOKIE_NAME, SessionStore } from '../src/sessions.js';
import { createSlotStore } from '../src/slots.js';
import { currentCode, generateSecret, verifyCode } from '../src/totp.js';

const OP_TOKEN = 'c17_auth_test_operator_token';
const BOT_TOKEN = 'c17_auth_test_bot_token';

const SQUADRON: Squadron = {
  name: 'alpha-squadron',
  mission: 'Verify the auth surface.',
  brief: '',
};

const ROLES: Record<string, Role> = {
  operator: {
    description: 'Directs the squadron.',
    instructions: 'Lead the squadron.',
  },
  implementer: {
    description: 'Does the work.',
    instructions: 'Implement things.',
  },
};

/** Minimum helpers — each test gets its own app instance, no shared state. */
function makeApp(options: { now?: () => number; totpSecret?: string } = {}) {
  const secret = options.totpSecret ?? generateSecret();
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const slots = createSlotStore([
    {
      callsign: 'ACTUAL',
      role: 'operator',
      authority: 'commander',
      token: OP_TOKEN,
      totpSecret: secret,
    },
    { callsign: 'build-bot', role: 'implementer', token: BOT_TOKEN },
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db, { now: options.now });
  const app = createApp({
    broker,
    slots,
    sessions,
    squadron: SQUADRON,
    roles: ROLES,
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    now: options.now,
  });
  return { app, slots, sessions, secret };
}

function cookieFrom(res: Response): string | null {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  // Parse the first `name=value` pair from the header. Hono may serialize
  // multiple cookies into one header separated by ',' — for our tests we
  // only ever set one at a time so a simple match is enough.
  const match = sc.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? (match[1] ?? null) : null;
}

// ─── TOTP primitive ─────────────────────────────────────────────────

describe('verifyCode', () => {
  it('accepts the current code and returns a counter', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const code = currentCode(secret, now);
    const result = verifyCode(secret, code, 0, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Counter is floor(now/1000/30). At time 1_700_000_000 that's
      // 56_666_666.
      expect(result.counter).toBe(Math.floor(now / 1000 / 30));
    }
  });

  it('rejects the same code used twice (replay guard)', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const code = currentCode(secret, now);
    const first = verifyCode(secret, code, 0, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = verifyCode(secret, code, first.counter, now);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('replay');
    }
  });

  it('rejects a wrong 6-digit code', () => {
    const secret = generateSecret();
    const result = verifyCode(secret, '000000', 0);
    // There's a tiny chance "000000" happens to be valid for the current
    // period; re-roll the secret once if that happens rather than
    // special-casing the tolerance.
    if (result.ok) {
      const secret2 = generateSecret();
      const retry = verifyCode(secret2, '000000', 0);
      expect(retry.ok).toBe(false);
    } else {
      expect(result.reason).toBe('invalid');
    }
  });

  it('rejects malformed codes (not 6 digits)', () => {
    const secret = generateSecret();
    expect(verifyCode(secret, '12345', 0).ok).toBe(false);
    expect(verifyCode(secret, '1234567', 0).ok).toBe(false);
    expect(verifyCode(secret, 'abcdef', 0).ok).toBe(false);
  });
});

// ─── Session store ──────────────────────────────────────────────────

describe('SessionStore', () => {
  it('creates, looks up, touches, and deletes sessions', () => {
    const db = openDatabase(':memory:');
    const store = new SessionStore(db);
    const created = store.create('ACTUAL', 'test-ua');
    expect(created.slotCallsign).toBe('ACTUAL');

    const found = store.get(created.id);
    expect(found?.slotCallsign).toBe('ACTUAL');

    store.touch(created.id);
    const touched = store.get(created.id);
    expect(touched).not.toBeNull();
    if (touched) expect(touched.lastSeen).toBeGreaterThanOrEqual(created.lastSeen);

    store.delete(created.id);
    expect(store.get(created.id)).toBeNull();
  });

  it('treats expired sessions as missing and purges them', () => {
    let clock = 1_000_000;
    const db = openDatabase(':memory:');
    const store = new SessionStore(db, { now: () => clock });
    const created = store.create('ACTUAL', null);
    // Jump past the 7d TTL.
    clock += 8 * 24 * 60 * 60 * 1000;
    expect(store.get(created.id)).toBeNull();
    expect(store.purgeExpired()).toBe(1);
  });
});

// ─── /session/totp — login flow ─────────────────────────────────────

describe('POST /session/totp', () => {
  it('issues a session cookie for a valid code and lets subsequent cookie-auth requests succeed', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const code = currentCode(secret, now);

    const res = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionResponse;
    expect(body.slot).toBe('ACTUAL');
    expect(body.role).toBe('operator');
    expect(body.expiresAt).toBeGreaterThan(now);

    const cookie = cookieFrom(res);
    expect(cookie).toBeTruthy();
    if (!cookie) return;

    // Cookie-auth request works.
    const rosterRes = await app.request('/roster', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(rosterRes.status).toBe(200);
  });

  it('rejects the same code used twice (replay guard)', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const code = currentCode(secret, now);

    const first = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code }),
    });
    expect(second.status).toBe(401);
  });

  it('rejects an unknown/unenrolled slot with the same error shape (no enumeration)', async () => {
    const now = 1_700_000_000_000;
    const { app } = makeApp({ now: () => now });

    // build-bot has no TOTP enrollment; ghost doesn't exist at all.
    // Both should look identical to the caller.
    const botRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'build-bot', code: '000000' }),
    });
    const ghostRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ghost', code: '000000' }),
    });
    expect(botRes.status).toBe(401);
    expect(ghostRes.status).toBe(401);
    const botBody = (await botRes.json()) as { error: string };
    const ghostBody = (await ghostRes.json()) as { error: string };
    expect(botBody.error).toBe(ghostBody.error);
  });

  it('400s on malformed login payload', async () => {
    const { app } = makeApp();
    const res = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('locks out a slot after 5 failed attempts and clears on success', async () => {
    let clock = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => clock });

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/session/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot: 'ACTUAL', code: '000000' }),
      });
      expect(res.status).toBe(401);
    }

    // 6th attempt — now locked out regardless of code correctness.
    const lockedRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code: currentCode(secret, clock) }),
    });
    expect(lockedRes.status).toBe(429);

    // Jump past the 15-minute window.
    clock += 16 * 60 * 1000;
    const recoveredRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code: currentCode(secret, clock) }),
    });
    expect(recoveredRes.status).toBe(200);
  });
});

// ─── /session/logout and /session ───────────────────────────────────

describe('session lifecycle', () => {
  it('logs out: cookie becomes invalid, subsequent requests 401', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const code = currentCode(secret, now);

    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code }),
    });
    const cookie = cookieFrom(loginRes);
    expect(cookie).toBeTruthy();
    if (!cookie) return;

    const logoutRes = await app.request('/session/logout', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(logoutRes.status).toBe(204);

    // Cookie is now stale server-side.
    const afterRes = await app.request('/roster', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(afterRes.status).toBe(401);
  });

  it('GET /session returns the current slot/role/expiresAt', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code: currentCode(secret, now) }),
    });
    const cookie = cookieFrom(loginRes);
    if (!cookie) return;

    const sessionRes = await app.request('/session', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(sessionRes.status).toBe(200);
    const body = (await sessionRes.json()) as SessionResponse;
    expect(body.slot).toBe('ACTUAL');
    expect(body.role).toBe('operator');
    expect(body.expiresAt).toBeGreaterThan(now);
  });
});

// ─── Dual-auth middleware ───────────────────────────────────────────

describe('dual auth (bearer OR cookie)', () => {
  it('accepts /roster with bearer token', async () => {
    const { app } = makeApp();
    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${OP_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('accepts /roster with session cookie', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code: currentCode(secret, now) }),
    });
    const cookie = cookieFrom(loginRes);
    if (!cookie) return;

    const res = await app.request('/roster', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects /roster with no credentials at all', async () => {
    const { app } = makeApp();
    const res = await app.request('/roster');
    expect(res.status).toBe(401);
  });

  it('rejects /roster with a stale cookie even if the session was valid before', async () => {
    const now = 1_700_000_000_000;
    const { app, sessions, secret } = makeApp({ now: () => now });

    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code: currentCode(secret, now) }),
    });
    const cookie = cookieFrom(loginRes);
    if (!cookie) return;

    // Forcibly delete the session server-side to simulate logout-from-
    // another-device or the purge job running.
    sessions.delete(cookie);

    const res = await app.request('/roster', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    // Distinct error so the SPA can tell "no cookie" from "stale cookie".
    expect(body.error).toBe('session expired');
  });

  it('cookie-auth on /subscribe still enforces agentId === callsign', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ACTUAL', code: currentCode(secret, now) }),
    });
    const cookie = cookieFrom(loginRes);
    if (!cookie) return;

    const res = await app.request('/subscribe?agentId=build-bot', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(res.status).toBe(403);
  });
});
