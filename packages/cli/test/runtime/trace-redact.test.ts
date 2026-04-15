/**
 * Secret redaction tests — cover the three entry points
 * (`redactSecrets`, `redactHeaders`, `redactJson`) and all known
 * key patterns we scrub.
 */

import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  redactHeaders,
  redactJson,
  redactSecrets,
} from '../../src/runtime/trace/redact.js';

describe('redactSecrets', () => {
  it('replaces Anthropic sk-ant- keys', () => {
    const input = 'header Authorization: Bearer sk-ant-api03-abc123def456ghi789jklmno end';
    expect(redactSecrets(input)).toContain(REDACTED);
    expect(redactSecrets(input)).not.toContain('sk-ant-api03');
  });

  it('replaces OpenAI sk- keys', () => {
    const input = 'Bearer sk-abcdef1234567890abcdef1234';
    const out = redactSecrets(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('sk-abcdef');
  });

  it('replaces AWS access key IDs', () => {
    const input = 'aws key AKIAIOSFODNN7EXAMPLE end';
    expect(redactSecrets(input)).toBe(`aws key ${REDACTED} end`);
  });

  it('replaces GitHub personal access tokens', () => {
    const input = 'token ghp_aaaaaaaaaaaaaaaaaaaaaaaa end';
    expect(redactSecrets(input)).toContain(REDACTED);
    expect(redactSecrets(input)).not.toContain('ghp_aaaaaa');
  });

  it('replaces Slack tokens', () => {
    const input = 'x=xoxb-1234567890-abcdef-secret end';
    expect(redactSecrets(input)).toContain(REDACTED);
  });

  it('leaves non-secret strings alone', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
    expect(redactSecrets('model="claude-sonnet-4-6"')).toBe('model="claude-sonnet-4-6"');
  });
});

describe('redactHeaders', () => {
  it('strips case-insensitive Authorization headers', () => {
    const out = redactHeaders({
      Authorization: 'Bearer sk-ant-api03-real-looking-key-value-1234',
      'Content-Type': 'application/json',
    });
    expect(out.Authorization).toBe(REDACTED);
    expect(out['Content-Type']).toBe('application/json');
  });

  it('strips x-api-key, cookie, set-cookie, x-anthropic-api-key', () => {
    const out = redactHeaders({
      'x-api-key': 'abc',
      Cookie: 'session=xyz',
      'Set-Cookie': 'session=xyz; HttpOnly',
      'X-Anthropic-Api-Key': 'sk-ant-...',
    });
    expect(out['x-api-key']).toBe(REDACTED);
    expect(out.Cookie).toBe(REDACTED);
    expect(out['Set-Cookie']).toBe(REDACTED);
    expect(out['X-Anthropic-Api-Key']).toBe(REDACTED);
  });

  it('scans non-sensitive header values for leaked secrets', () => {
    const out = redactHeaders({
      'X-Debug': 'token=ghp_abcdefghijklmnopqrstuvwx',
    });
    expect(out['X-Debug']).toContain(REDACTED);
  });
});

describe('redactJson', () => {
  it('recursively redacts every string leaf in an object tree', () => {
    const input = {
      model: 'claude-sonnet-4-6',
      headers: {
        Authorization: 'Bearer sk-ant-api03-real-looking-key-value-1234',
      },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello, here is a key: sk-abcdefghijklmnopqrstuv' },
      ],
      count: 42,
      active: true,
      nil: null,
    };
    const out = redactJson(input);
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.headers.Authorization).toContain(REDACTED);
    expect(out.messages[1]?.content).toContain(REDACTED);
    expect(out.count).toBe(42);
    expect(out.active).toBe(true);
    expect(out.nil).toBeNull();
  });

  it('returns a new object instead of mutating input', () => {
    const input = { key: 'sk-abcdefghijklmnopqrstuv' };
    const out = redactJson(input);
    expect(out.key).toContain(REDACTED);
    expect(input.key).toBe('sk-abcdefghijklmnopqrstuv');
  });
});
