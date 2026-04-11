/**
 * `@control17/sdk` runtime client.
 *
 * A thin, typed wrapper over the broker HTTP API. Validates every response
 * against `@control17/sdk/schemas` so callers get either a validated,
 * strongly-typed result or a `ClientError`.
 */

import { AUTH_HEADER, PATHS, PROTOCOL_HEADER, PROTOCOL_VERSION } from './protocol.js';
import {
  AgentListSchema,
  AgentRegistrationSchema,
  HealthResponseSchema,
  MessageSchema,
  PushPayloadSchema,
  PushResultSchema,
} from './schemas.js';
import type {
  Agent,
  AgentRegistration,
  HealthResponse,
  Message,
  PushPayload,
  PushResult,
} from './types.js';

export interface ClientOptions {
  /** Broker base URL, e.g. `http://127.0.0.1:8717`. No trailing slash required. */
  url: string;
  /** Shared-secret bearer token. Required for all endpoints except `/healthz`. */
  token: string;
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
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    // Normalize: strip trailing slash so URL composition is predictable.
    this.baseUrl = new URL(`${options.url.replace(/\/+$/, '')}/`);
    this.token = options.token;
    const fetchRef = options.fetch ?? globalThis.fetch;
    if (!fetchRef) {
      throw new Error('Client: no fetch implementation available');
    }
    // Bind to avoid "Illegal invocation" on some runtimes.
    this.fetchImpl = fetchRef.bind(globalThis);
  }

  /** Make a request with the protocol header and bearer token. */
  private async request(
    path: string,
    init: RequestInit & { skipAuth?: boolean } = {},
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    const headers = new Headers(init.headers);
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    if (!init.skipAuth) {
      headers.set(AUTH_HEADER, `Bearer ${this.token}`);
    }
    const { skipAuth: _skipAuth, ...rest } = init;
    return this.fetchImpl(url, { ...rest, headers });
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

  async register(agentId: string): Promise<AgentRegistration> {
    const resp = await this.request(PATHS.register, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
    return AgentRegistrationSchema.parse(await this.json(resp));
  }

  async listAgents(): Promise<Agent[]> {
    const resp = await this.request(PATHS.agents, { method: 'GET' });
    const parsed = AgentListSchema.parse(await this.json(resp));
    return parsed.agents;
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
