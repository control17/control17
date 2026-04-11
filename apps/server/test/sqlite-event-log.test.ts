import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@control17/sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteEventLog } from '../src/sqlite-event-log.js';

describe('SqliteEventLog', () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'c17-sqlite-test-'));
    dirsToClean.push(dir);
    return join(dir, 'events.db');
  }

  it('append + tail round-trip preserves the full message shape', async () => {
    const log = new SqliteEventLog(tmpDbPath());
    const m1: Message = {
      id: 'a',
      ts: 1,
      agentId: 'x',
      title: 'hi',
      body: 'hello',
      level: 'warning',
      data: { foo: 'bar', n: 42 },
    };
    await log.append(m1);
    const tailed = await log.tail();
    expect(tailed).toHaveLength(1);
    expect(tailed[0]).toEqual(m1);
    await log.close();
  });

  it('tail honours since + limit', async () => {
    const log = new SqliteEventLog(tmpDbPath());
    for (let i = 0; i < 5; i++) {
      await log.append({
        id: `m${i}`,
        ts: i,
        agentId: null,
        title: null,
        body: `msg ${i}`,
        level: 'info',
        data: {},
      });
    }
    const since = await log.tail({ since: 3 });
    expect(since.map((m) => m.id).sort()).toEqual(['m3', 'm4']);

    const limit = await log.tail({ limit: 2 });
    expect(limit.map((m) => m.id).sort()).toEqual(['m3', 'm4']);
    await log.close();
  });

  it('persists messages across reopening the database', async () => {
    const path = tmpDbPath();
    const first = new SqliteEventLog(path);
    await first.append({
      id: 'persist',
      ts: 10,
      agentId: 'a1',
      title: null,
      body: 'survive',
      level: 'info',
      data: {},
    });
    await first.close();

    const second = new SqliteEventLog(path);
    const tailed = await second.tail();
    expect(tailed).toHaveLength(1);
    expect(tailed[0]?.body).toBe('survive');
    await second.close();
  });
});
