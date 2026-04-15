/**
 * Anthropic API payload extractor tests.
 *
 * Feeds synthetic HttpExchange records (as if tshark had already
 * decrypted and parsed them) through `extractEntries` and asserts the
 * structured output matches what the web UI / server upload expects.
 */

import { describe, expect, it } from 'vitest';
import {
  type AnthropicMessagesEntry,
  extractEntries,
  type HttpExchange,
  type OpaqueHttpEntry,
} from '../../src/runtime/trace/anthropic.js';
import { REDACTED } from '../../src/runtime/trace/redact.js';

function anthropicExchange(overrides: Partial<HttpExchange> = {}): HttpExchange {
  return {
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_500,
    request: {
      method: 'POST',
      url: '/v1/messages',
      host: 'api.anthropic.com',
      headers: {
        Authorization: 'Bearer sk-ant-api03-real-looking-key-value-1234',
        'Content-Type': 'application/json',
      },
      body: {
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        temperature: 0.3,
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'What time is it?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check.' },
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'get_time',
                input: { timezone: 'UTC' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_01',
                content: '14:23:45 UTC',
                is_error: false,
              },
            ],
          },
        ],
        tools: [
          {
            name: 'get_time',
            description: 'Get current UTC time',
            input_schema: { type: 'object', properties: { timezone: { type: 'string' } } },
          },
        ],
      },
    },
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'The time is 14:23:45 UTC.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 150,
          output_tokens: 12,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
        },
      },
    },
    ...overrides,
  };
}

describe('extractEntries', () => {
  it('parses a full anthropic /v1/messages exchange', () => {
    const [entry] = extractEntries([anthropicExchange()]);
    expect(entry?.kind).toBe('anthropic_messages');
    const a = entry as AnthropicMessagesEntry;
    expect(a.request.model).toBe('claude-sonnet-4-6');
    expect(a.request.maxTokens).toBe(2048);
    expect(a.request.temperature).toBe(0.3);
    expect(a.request.system).toBe('You are a helpful assistant.');
    expect(a.request.messages).toHaveLength(3);
    expect(a.request.messages[0]?.role).toBe('user');
    expect(a.request.messages[0]?.content[0]).toEqual({ type: 'text', text: 'What time is it?' });

    // tool_use block round-trips.
    expect(a.request.messages[1]?.content[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_01',
      name: 'get_time',
      input: { timezone: 'UTC' },
    });

    // tool_result block round-trips.
    expect(a.request.messages[2]?.content[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'toolu_01',
      content: '14:23:45 UTC',
      isError: false,
    });

    expect(a.request.tools?.[0]?.name).toBe('get_time');
    expect(a.response?.stopReason).toBe('end_turn');
    expect(a.response?.usage?.inputTokens).toBe(150);
    expect(a.response?.usage?.outputTokens).toBe(12);
    expect(a.response?.usage?.cacheReadInputTokens).toBe(50);
  });

  it('matches subdomain anthropic hosts (e.g. console.anthropic.com)', () => {
    const [entry] = extractEntries([
      anthropicExchange({
        request: {
          method: 'POST',
          url: '/v1/messages?beta=1',
          host: 'console.anthropic.com',
          headers: {},
          body: { model: 'claude-haiku-4-5', messages: [] },
        },
      }),
    ]);
    expect(entry?.kind).toBe('anthropic_messages');
    const a = entry as AnthropicMessagesEntry;
    expect(a.request.model).toBe('claude-haiku-4-5');
  });

  it('non-anthropic hosts fall through to opaque_http', () => {
    const [entry] = extractEntries([
      {
        startedAt: 1,
        endedAt: 2,
        request: {
          method: 'GET',
          url: '/api/data',
          host: 'example.com',
          headers: { 'User-Agent': 'c17' },
          body: null,
        },
        response: {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: { ok: true },
        },
      },
    ]);
    expect(entry?.kind).toBe('opaque_http');
    const o = entry as OpaqueHttpEntry;
    expect(o.host).toBe('example.com');
    expect(o.status).toBe(200);
    expect(o.responseBodyPreview).toContain('"ok":true');
  });

  it('redacts secrets in messages even when the outer request is benign', () => {
    const [entry] = extractEntries([
      {
        startedAt: 1,
        endedAt: 2,
        request: {
          method: 'POST',
          url: '/v1/messages',
          host: 'api.anthropic.com',
          headers: {},
          body: {
            model: 'claude',
            messages: [
              {
                role: 'user',
                content: 'here is my key: sk-ant-api03-leaked-key-value-should-redact',
              },
            ],
          },
        },
        response: null,
      },
    ]);
    const a = entry as AnthropicMessagesEntry;
    const content = a.request.messages[0]?.content[0];
    expect(content?.type).toBe('text');
    if (content?.type === 'text') {
      expect(content.text).toContain(REDACTED);
      expect(content.text).not.toContain('sk-ant-api03-leaked');
    }
  });

  it('tolerates a request with missing response (request-only flow)', () => {
    const [entry] = extractEntries([anthropicExchange({ response: null })]);
    const a = entry as AnthropicMessagesEntry;
    expect(a.response).toBeNull();
    expect(a.request.model).toBe('claude-sonnet-4-6');
  });

  it('normalizes plain-string content into a text block', () => {
    const [entry] = extractEntries([
      anthropicExchange({
        request: {
          method: 'POST',
          url: '/v1/messages',
          host: 'api.anthropic.com',
          headers: {},
          body: {
            model: 'claude',
            messages: [{ role: 'user', content: 'plain string' }],
          },
        },
      }),
    ]);
    const a = entry as AnthropicMessagesEntry;
    expect(a.request.messages[0]?.content).toEqual([{ type: 'text', text: 'plain string' }]);
  });
});
