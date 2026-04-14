/**
 * `@control17/sdk` runtime client.
 *
 * A thin, typed wrapper over the broker HTTP API. Validates every response
 * against `@control17/sdk/schemas` so callers get either a validated,
 * strongly-typed result or a `ClientError`.
 */

import { AUTH_HEADER, PATHS, PROTOCOL_HEADER, PROTOCOL_VERSION } from './protocol.js';
import {
  BriefingResponseSchema,
  HealthResponseSchema,
  HistoryResponseSchema,
  MessageSchema,
  PushPayloadSchema,
  PushResultSchema,
  PushSubscriptionResponseSchema,
  RosterResponseSchema,
  SessionResponseSchema,
  VapidPublicKeyResponseSchema,
} from './schemas.js';
import type {
  BriefingResponse,
  HealthResponse,
  HistoryQuery,
  Message,
  PushPayload,
  PushResult,
  PushSubscriptionPayload,
  PushSubscriptionResponse,
  RosterResponse,
  SessionResponse,
  TotpLoginRequest,
  VapidPublicKeyResponse,
} from './types.js';

export interface ClientOptions {
  /** Broker base URL, e.g. `http://127.0.0.1:8717`. No trailing slash required. */
  url: string;
  /**
   * Shared-secret bearer token. Optional — omit for human/web-UI usage
   * where auth comes from the session cookie (`useCookies: true`).
   * Required for machine/MCP-link usage where no cookie is available.
   */
  token?: string;
  /**
   * Opt into `credentials: 'include'` on every request — for
   * browser-side SPAs that rely on the `c17_session` cookie instead
   * of a bearer token. Has no effect in Node where fetch doesn't
   * manage cookies automatically.
   */
  useCookies?: boolean;
  /** Custom fetch implementation (for tests or polyfills). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export class ClientError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
    this.body = body;
  }
}

export class Client {
  private readonly baseUrl: URL;
  private readonly token: string | null;
  private readonly useCookies: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    // Normalize: strip trailing slash so URL composition is predictable.
    this.baseUrl = new URL(`${options.url.replace(/\/+$/, '')}/`);
    this.token = options.token ?? null;
    this.useCookies = options.useCookies ?? false;
    if (!this.token && !this.useCookies) {
      throw new Error(
        'Client: must provide either `token` (bearer) or `useCookies: true` (session)',
      );
    }
    const fetchRef = options.fetch ?? globalThis.fetch;
    if (!fetchRef) {
      throw new Error('Client: no fetch implementation available');
    }
    // Bind to avoid "Illegal invocation" on some runtimes.
    this.fetchImpl = fetchRef.bind(globalThis);
  }

  /** Make a request with the protocol header and credentials. */
  private async request(
    path: string,
    init: RequestInit & { skipAuth?: boolean } = {},
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    const headers = new Headers(init.headers);
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    if (!init.skipAuth && this.token) {
      headers.set(AUTH_HEADER, `Bearer ${this.token}`);
    }
    const { skipAuth: _skipAuth, ...rest } = init;
    const requestInit: RequestInit = { ...rest, headers };
    if (this.useCookies) {
      requestInit.credentials = 'include';
    }
    return this.fetchImpl(url, requestInit);
  }

  private async json<T>(resp: Response): Promise<T> {
    const text = await resp.text();
    if (!resp.ok) {
      throw new ClientError(`${resp.status} ${resp.statusText}`, resp.status, text);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ClientError(`invalid JSON from ${resp.url}`, resp.status, text);
    }
  }

  async health(): Promise<HealthResponse> {
    const resp = await this.request(PATHS.health, { method: 'GET', skipAuth: true });
    return HealthResponseSchema.parse(await this.json(resp));
  }

  /**
   * Exchange a TOTP code for a session. Succeeds → server sets the
   * `c17_session` cookie and returns the authenticated slot info.
   * Failure modes: wrong/stale code → 401, malformed → 400,
   * too-many-attempts → 429.
   */
  async loginWithTotp(payload: TotpLoginRequest): Promise<SessionResponse> {
    const resp = await this.request(PATHS.sessionTotp, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      skipAuth: true,
    });
    return SessionResponseSchema.parse(await this.json(resp));
  }

  /**
   * Drop the server-side session and clear the cookie. Safe to call
   * even if already logged out — returns 200 either way.
   */
  async logout(): Promise<void> {
    const resp = await this.request(PATHS.sessionLogout, {
      method: 'POST',
      skipAuth: true,
    });
    // Any 2xx is success; no body to validate.
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(`logout failed: ${resp.status} ${resp.statusText}`, resp.status, body);
    }
  }

  /**
   * Fetch the current session's slot/role/expiry. Used by the SPA on
   * mount to rehydrate its session signal before showing any UI.
   * Returns null on 401 (no / expired session) so callers can treat
   * "not signed in" as a first-class state without catching errors.
   */
  async currentSession(): Promise<SessionResponse | null> {
    const resp = await this.request(PATHS.session, {
      method: 'GET',
      skipAuth: true,
    });
    if (resp.status === 401) return null;
    return SessionResponseSchema.parse(await this.json(resp));
  }

  /**
   * Fetch the server's VAPID public key. Anonymous — no auth needed.
   * Used by the SPA's push-subscription flow to pass into
   * `pushManager.subscribe({applicationServerKey})`.
   */
  async vapidPublicKey(): Promise<VapidPublicKeyResponse> {
    const resp = await this.request(PATHS.pushVapidPublicKey, {
      method: 'GET',
      skipAuth: true,
    });
    return VapidPublicKeyResponseSchema.parse(await this.json(resp));
  }

  /**
   * Register (or refresh) a push subscription for the current
   * authenticated slot. Subsequent calls with the same endpoint
   * replace the existing row.
   */
  async registerPushSubscription(
    payload: PushSubscriptionPayload,
  ): Promise<PushSubscriptionResponse> {
    const resp = await this.request(PATHS.pushSubscriptions, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return PushSubscriptionResponseSchema.parse(await this.json(resp));
  }

  /**
   * Remove a push subscription by its database id. Scoped to the
   * authenticated slot server-side.
   */
  async deletePushSubscription(id: number): Promise<void> {
    const resp = await this.request(`${PATHS.pushSubscriptions}/${id}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(
        `deletePushSubscription failed: ${resp.status} ${resp.statusText}`,
        resp.status,
        body,
      );
    }
  }

  /**
   * Fetch the team-context briefing for the authenticated slot.
   *
   * Returns the caller's callsign, role, team (name/mission/brief),
   * list of teammates, and a pre-composed `instructions` string ready
   * for `new Server({instructions})` in the MCP link. The TUI uses it
   * to show "who you are on this team" in the header.
   */
  async briefing(): Promise<BriefingResponse> {
    const resp = await this.request(PATHS.briefing, { method: 'GET' });
    return BriefingResponseSchema.parse(await this.json(resp));
  }

  /**
   * List all slots defined on the team (including any not currently
   * connected) plus the runtime connection state of each registered
   * agent. Use this for the team roster view in the TUI and for the
   * `roster` MCP tool on the link side.
   */
  async roster(): Promise<RosterResponse> {
    const resp = await this.request(PATHS.roster, { method: 'GET' });
    return RosterResponseSchema.parse(await this.json(resp));
  }

  async history(query: HistoryQuery = {}): Promise<Message[]> {
    const params = new URLSearchParams();
    if (query.with) params.set('with', query.with);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before !== undefined) params.set('before', String(query.before));
    const qs = params.toString();
    const path = qs ? `${PATHS.history}?${qs}` : PATHS.history;
    const resp = await this.request(path, { method: 'GET' });
    const parsed = HistoryResponseSchema.parse(await this.json(resp));
    return parsed.messages;
  }

  async push(payload: PushPayload): Promise<PushResult> {
    const validated = PushPayloadSchema.parse(payload);
    const resp = await this.request(PATHS.push, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return PushResultSchema.parse(await this.json(resp));
  }

  /**
   * Open a long-lived SSE subscription for `agentId` and yield messages as
   * they arrive. Aborts cleanly when `signal` is triggered.
   */
  async *subscribe(agentId: string, signal?: AbortSignal): AsyncIterable<Message> {
    const url = new URL(PATHS.subscribe.replace(/^\//, ''), this.baseUrl);
    url.searchParams.set('agentId', agentId);

    const headers = new Headers();
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    headers.set(AUTH_HEADER, `Bearer ${this.token}`);
    headers.set('Accept', 'text/event-stream');

    const resp = await this.fetchImpl(url, { method: 'GET', headers, signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(
        `subscribe failed: ${resp.status} ${resp.statusText}`,
        resp.status,
        body,
      );
    }
    if (!resp.body) {
      throw new ClientError('subscribe: empty response body', resp.status, '');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE frame loop
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const message = parseSseFrame(frame);
          if (message !== null) yield message;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* reader may already be released if cancelled */
      }
    }
  }
}

/**
 * Parse a single SSE frame. Returns a validated `Message` or null for any
 * frame we shouldn't surface to the caller.
 *
 * Per the SSE spec, only the default `message` event carries a payload
 * we care about. Named events (`connected`, `keepalive`, …) and pure
 * comments are skipped. This is what keeps the consumer resilient to
 * connection-level traffic like hello frames and idle heartbeats.
 */
function parseSseFrame(frame: string): Message | null {
  const dataLines: string[] = [];
  let eventType = 'message';
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (eventType !== 'message') return null;
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  if (payload === '') return null;
  return MessageSchema.parse(JSON.parse(payload));
}
