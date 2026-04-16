/**
 * Anthropic API payload extractor.
 *
 * Fed by the HTTP/1.1 reassembler sitting inside the MITM TLS proxy:
 * once a request/response pair is decoded from plaintext bytes, we
 * walk each exchange and, where the request is a `POST /v1/messages`
 * to an Anthropic-looking host, extract the structured shape we care
 * about:
 *
 *   - model, max_tokens, temperature, system prompt
 *   - messages array (user/assistant/tool role, content blocks
 *     including text, tool_use, tool_result)
 *   - stop_reason, stop_sequence
 *   - usage (input_tokens, output_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens)
 *
 * Non-Anthropic records pass through as opaque HTTP so we don't lose
 * them — a human can still read them in the web UI and figure out
 * what provider they belong to.
 *
 * Everything is defensive about schema: real Anthropic payloads can
 * mutate model names, add fields we don't know about, stream responses
 * in chunks. We treat unknown structures as "raw json" rather than
 * throwing; the worst case is a less-detailed summary in the UI, not
 * a crashed upload.
 */

import { redactHeaders, redactJson } from './redact.js';

export interface HttpRequestRecord {
  method: string;
  url: string;
  host: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpResponseRecord {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpExchange {
  request: HttpRequestRecord;
  response: HttpResponseRecord | null;
  startedAt: number;
  endedAt: number;
}

export type TraceEntry = AnthropicMessagesEntry | OpaqueHttpEntry;

export interface AnthropicMessagesEntry {
  kind: 'anthropic_messages';
  startedAt: number;
  endedAt: number;
  request: {
    model: string | null;
    maxTokens: number | null;
    temperature: number | null;
    system: string | null;
    messages: AnthropicMessage[];
    tools: AnthropicTool[] | null;
  };
  response: {
    stopReason: string | null;
    stopSequence: string | null;
    messages: AnthropicMessage[];
    usage: AnthropicUsage | null;
    status: number | null;
  } | null;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'tool' | 'system' | string;
  content: AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }
  | { type: 'image'; mediaType: string | null }
  | { type: 'thinking'; text: string }
  | { type: 'unknown'; raw: unknown };

export interface AnthropicTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export interface AnthropicUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface OpaqueHttpEntry {
  kind: 'opaque_http';
  startedAt: number;
  endedAt: number;
  host: string;
  method: string;
  url: string;
  status: number | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodyPreview: string | null;
  responseBodyPreview: string | null;
}

const ANTHROPIC_HOST_RE = /(?:^|\.)anthropic\.com$/i;
const MESSAGES_PATH_RE = /\/v1\/messages(?:\?|$)/;
const OPAQUE_BODY_PREVIEW_BYTES = 4096;

/**
 * Convert a list of HTTP exchanges into structured trace entries.
 * Anthropic `/v1/messages` calls get the deep parser; everything else
 * becomes an `OpaqueHttpEntry` with headers + a body preview.
 *
 * All output values go through the redaction layer. Callers should
 * treat the return value as safe to log, upload, or persist.
 */
export function extractEntries(exchanges: readonly HttpExchange[]): TraceEntry[] {
  return exchanges.map((ex) => extractOne(ex));
}

function extractOne(exchange: HttpExchange): TraceEntry {
  const { request, response, startedAt, endedAt } = exchange;
  if (
    request.method.toUpperCase() === 'POST' &&
    ANTHROPIC_HOST_RE.test(request.host) &&
    MESSAGES_PATH_RE.test(request.url)
  ) {
    return buildAnthropicEntry(exchange);
  }
  return {
    kind: 'opaque_http',
    startedAt,
    endedAt,
    host: request.host,
    method: request.method,
    url: request.url,
    status: response?.status ?? null,
    requestHeaders: redactHeaders(request.headers),
    responseHeaders: redactHeaders(response?.headers ?? {}),
    requestBodyPreview: previewBody(request.body),
    responseBodyPreview: previewBody(response?.body),
  };
}

function buildAnthropicEntry(exchange: HttpExchange): AnthropicMessagesEntry {
  const reqBody = (exchange.request.body ?? {}) as Record<string, unknown>;
  const respBody = (exchange.response?.body ?? null) as Record<string, unknown> | null;

  return {
    kind: 'anthropic_messages',
    startedAt: exchange.startedAt,
    endedAt: exchange.endedAt,
    request: {
      model: asString(reqBody.model),
      maxTokens: asNumber(reqBody.max_tokens),
      temperature: asNumber(reqBody.temperature),
      system: asString(reqBody.system),
      messages: parseMessages(reqBody.messages),
      tools: parseTools(reqBody.tools),
    },
    response:
      respBody === null
        ? null
        : {
            stopReason: asString(respBody.stop_reason),
            stopSequence: asString(respBody.stop_sequence),
            messages: parseMessages(
              respBody.content ? [{ role: 'assistant', content: respBody.content }] : [],
            ),
            usage: parseUsage(respBody.usage),
            status: exchange.response?.status ?? null,
          },
  };
}

function parseMessages(raw: unknown): AnthropicMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AnthropicMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const message = item as { role?: unknown; content?: unknown };
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    out.push({ role, content: parseContent(message.content) });
  }
  return redactJson(out);
}

function parseContent(raw: unknown): AnthropicContentBlock[] {
  // Anthropic allows either a plain string or an array of blocks.
  if (typeof raw === 'string') return [{ type: 'text', text: raw }];
  if (!Array.isArray(raw)) return [];
  const out: AnthropicContentBlock[] = [];
  for (const block of raw) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const t = typeof b.type === 'string' ? b.type : 'unknown';
    if (t === 'text') {
      out.push({ type: 'text', text: asString(b.text) ?? '' });
    } else if (t === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: asString(b.id) ?? '',
        name: asString(b.name) ?? '',
        input: b.input ?? null,
      });
    } else if (t === 'tool_result') {
      out.push({
        type: 'tool_result',
        toolUseId: asString(b.tool_use_id) ?? '',
        content: b.content ?? null,
        isError: b.is_error === true,
      });
    } else if (t === 'image') {
      const source = (b.source ?? null) as Record<string, unknown> | null;
      out.push({
        type: 'image',
        mediaType: source ? (asString(source.media_type) ?? null) : null,
      });
    } else if (t === 'thinking') {
      out.push({ type: 'thinking', text: asString(b.thinking) ?? asString(b.text) ?? '' });
    } else {
      out.push({ type: 'unknown', raw: b });
    }
  }
  return out;
}

function parseTools(raw: unknown): AnthropicTool[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AnthropicTool[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    out.push({
      name: asString(t.name) ?? '',
      description: asString(t.description),
      inputSchema: t.input_schema ?? null,
    });
  }
  return out;
}

function parseUsage(raw: unknown): AnthropicUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: asNumber(u.input_tokens),
    outputTokens: asNumber(u.output_tokens),
    cacheCreationInputTokens: asNumber(u.cache_creation_input_tokens),
    cacheReadInputTokens: asNumber(u.cache_read_input_tokens),
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function previewBody(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  let text: string;
  if (typeof body === 'string') {
    text = body;
  } else if (Buffer.isBuffer(body)) {
    text = body.slice(0, OPAQUE_BODY_PREVIEW_BYTES).toString('utf8');
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  const truncated = text.length > OPAQUE_BODY_PREVIEW_BYTES;
  const preview = truncated ? text.slice(0, OPAQUE_BODY_PREVIEW_BYTES) : text;
  return redactJson(preview) + (truncated ? '…[truncated]' : '');
}
