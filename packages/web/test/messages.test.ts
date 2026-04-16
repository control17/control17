/**
 * Pure-logic tests for the messages signal store.
 */

import type { Message } from '@control17/sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetMessagesForTests,
  appendMessages,
  PRIMARY_THREAD,
  threadKeyOf,
  threadKeys,
  threadMessages,
} from '../src/lib/messages.js';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    ts: 1,
    agentId: null,
    from: 'ACTUAL',
    title: null,
    body: 'hi',
    level: 'info',
    data: {},
    ...overrides,
  };
}

beforeEach(() => {
  __resetMessagesForTests();
});

describe('threadKeyOf', () => {
  it('maps broadcasts to primary', () => {
    expect(threadKeyOf(msg({ agentId: null }), 'ACTUAL')).toBe(PRIMARY_THREAD);
  });

  it('inbound DM is keyed by the sender callsign', () => {
    expect(threadKeyOf(msg({ agentId: 'ACTUAL', from: 'build-bot' }), 'ACTUAL')).toBe(
      'dm:build-bot',
    );
  });

  it('outbound DM is keyed by the recipient callsign', () => {
    expect(threadKeyOf(msg({ agentId: 'build-bot', from: 'ACTUAL' }), 'ACTUAL')).toBe(
      'dm:build-bot',
    );
  });

  it('self-DM gets its own key', () => {
    expect(threadKeyOf(msg({ agentId: 'ACTUAL', from: 'ACTUAL' }), 'ACTUAL')).toBe('dm:self');
  });
});

describe('appendMessages', () => {
  it('sorts by ts and dedupes by id', () => {
    appendMessages('ACTUAL', [
      msg({ id: 'a', ts: 2, body: 'second' }),
      msg({ id: 'b', ts: 1, body: 'first' }),
    ]);
    // Overlapping re-append (simulates a reconnect backfill).
    appendMessages('ACTUAL', [msg({ id: 'a', ts: 2, body: 'second' })]);
    const primary = threadMessages(PRIMARY_THREAD);
    expect(primary.map((m) => m.id)).toEqual(['b', 'a']);
    expect(primary).toHaveLength(2);
  });

  it('routes DMs and broadcasts into separate buckets', () => {
    appendMessages('ACTUAL', [
      msg({ id: 'p1', ts: 1, agentId: null, body: 'team' }),
      msg({ id: 'd1', ts: 2, agentId: 'build-bot', from: 'ACTUAL', body: 'dm' }),
    ]);
    expect(threadMessages(PRIMARY_THREAD)).toHaveLength(1);
    expect(threadMessages('dm:build-bot')).toHaveLength(1);
  });
});

describe('threadKeys', () => {
  it('always includes primary and sorts DMs alphabetically', () => {
    appendMessages('ACTUAL', [
      msg({ id: 'd1', ts: 1, agentId: 'zebra', from: 'ACTUAL' }),
      msg({ id: 'd2', ts: 2, agentId: 'alpha', from: 'ACTUAL' }),
    ]);
    expect(threadKeys()).toEqual([PRIMARY_THREAD, 'dm:alpha', 'dm:zebra']);
  });
});
