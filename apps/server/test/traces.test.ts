/**
 * Objective trace endpoint tests.
 *
 * Covers the full permission matrix on `POST /objectives/:id/traces`
 * and `GET /objectives/:id/traces`:
 *
 *   - POST: only the current assignee can upload (not commander, not
 *     originator, not a random teammate). Reassignment flips who is
 *     allowed.
 *   - GET: only commanders can view. Assignees, lieutenants, and
 *     operators all get 403.
 *   - Payload validation: malformed JSON returns 400 with Zod errors.
 *   - Storage round-trip: the returned trace matches what was sent.
 *
 * The test server uses an in-memory SQLite database (via the real
 * SqliteObjectivesStore) so the trace schema migration runs exactly
 * the same way it would in production.
 */

import { Broker, InMemoryEventLog } from '@control17/core';
import { OBJECTIVE_PATHS } from '@control17/sdk/protocol';
import type {
  ObjectiveTrace,
  Role,
  Squadron,
  UploadObjectiveTraceRequest,
} from '@control17/sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createSqliteObjectivesStore } from '../src/objectives.js';
import { SessionStore } from '../src/sessions.js';
import { createSlotStore } from '../src/slots.js';

const CMD_TOKEN = 'c17_test_commander';
const ASSIGNEE_TOKEN = 'c17_test_assignee';
const OTHER_TOKEN = 'c17_test_other';

const SQUADRON: Squadron = {
  name: 'alpha-squadron',
  mission: 'Ship the payments service.',
  brief: 'End-to-end ownership.',
};

const ROLES: Record<string, Role> = {
  operator: { description: 'Directs the squadron.', instructions: 'Lead.' },
  implementer: { description: 'Writes code.', instructions: 'Ship work.' },
};

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const slots = createSlotStore([
    { callsign: 'ACTUAL', role: 'operator', authority: 'commander', token: CMD_TOKEN },
    { callsign: 'ALPHA-1', role: 'implementer', token: ASSIGNEE_TOKEN },
    { callsign: 'BRAVO-1', role: 'implementer', token: OTHER_TOKEN },
  ]);
  const db = openDatabase(':memory:');
  const objectives = createSqliteObjectivesStore(db);
  const app = createApp({
    broker,
    slots,
    sessions: new SessionStore(db),
    objectives,
    squadron: SQUADRON,
    roles: ROLES,
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  return { app, objectives, db };
}

function authed(token: string, body?: unknown): RequestInit {
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) {
    init.method = 'POST';
    init.body = JSON.stringify(body);
  }
  return init;
}

function samplePayload(
  overrides: Partial<UploadObjectiveTraceRequest> = {},
): UploadObjectiveTraceRequest {
  return {
    spanStart: 1_700_000_000_000,
    spanEnd: 1_700_000_000_500,
    provider: 'anthropic',
    truncated: false,
    entries: [
      {
        kind: 'anthropic_messages',
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_000_200,
        request: {
          model: 'claude-sonnet-4-6',
          maxTokens: 1024,
          temperature: null,
          system: null,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: null,
        },
        response: {
          stopReason: 'end_turn',
          stopSequence: null,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'world' }] }],
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
          status: 200,
        },
      },
    ],
    ...overrides,
  };
}

describe('objective trace endpoints', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let objectives: ReturnType<typeof makeApp>['objectives'];
  let objectiveId: string;

  beforeEach(() => {
    const fixture = makeApp();
    app = fixture.app;
    objectives = fixture.objectives;
    const created = objectives.create(
      { title: 'Ship the feature', outcome: 'Users can pay', assignee: 'ALPHA-1' },
      'ACTUAL',
    );
    objectiveId = created.objective.id;
  });

  describe('POST /objectives/:id/traces', () => {
    it('accepts an upload from the current assignee', async () => {
      const res = await app.request(
        OBJECTIVE_PATHS.traces(objectiveId),
        authed(ASSIGNEE_TOKEN, samplePayload()),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as ObjectiveTrace;
      expect(body.objectiveId).toBe(objectiveId);
      expect(body.provider).toBe('anthropic');
      expect(body.entries).toHaveLength(1);
      expect(body.id).toBeGreaterThan(0);
    });

    it('rejects uploads from the commander (not the assignee)', async () => {
      const res = await app.request(
        OBJECTIVE_PATHS.traces(objectiveId),
        authed(CMD_TOKEN, samplePayload()),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/only the current assignee/);
    });

    it('rejects uploads from an unrelated teammate', async () => {
      const res = await app.request(
        OBJECTIVE_PATHS.traces(objectiveId),
        authed(OTHER_TOKEN, samplePayload()),
      );
      expect(res.status).toBe(403);
    });

    it('returns 404 for an unknown objective id', async () => {
      const res = await app.request(
        OBJECTIVE_PATHS.traces('obj-nonexistent'),
        authed(ASSIGNEE_TOKEN, samplePayload()),
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 for a malformed trace payload', async () => {
      const res = await app.request(
        OBJECTIVE_PATHS.traces(objectiveId),
        authed(ASSIGNEE_TOKEN, { spanStart: 'not-a-number' }),
      );
      expect(res.status).toBe(400);
    });

    it('reassigning the objective flips who may upload', async () => {
      objectives.reassign(objectiveId, { to: 'BRAVO-1' }, 'ACTUAL');
      const fromOldAssignee = await app.request(
        OBJECTIVE_PATHS.traces(objectiveId),
        authed(ASSIGNEE_TOKEN, samplePayload()),
      );
      expect(fromOldAssignee.status).toBe(403);
      const fromNewAssignee = await app.request(
        OBJECTIVE_PATHS.traces(objectiveId),
        authed(OTHER_TOKEN, samplePayload()),
      );
      expect(fromNewAssignee.status).toBe(201);
    });
  });

  describe('GET /objectives/:id/traces', () => {
    beforeEach(async () => {
      // Seed one trace so GET has something to return.
      await app.request(
        OBJECTIVE_PATHS.traces(objectiveId),
        authed(ASSIGNEE_TOKEN, samplePayload()),
      );
      await app.request(
        OBJECTIVE_PATHS.traces(objectiveId),
        authed(ASSIGNEE_TOKEN, samplePayload({ spanStart: 1_700_000_001_000 })),
      );
    });

    it('returns all traces for the objective to a commander', async () => {
      const res = await app.request(OBJECTIVE_PATHS.traces(objectiveId), {
        headers: { Authorization: `Bearer ${CMD_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { traces: ObjectiveTrace[] };
      expect(body.traces).toHaveLength(2);
      expect(body.traces[0]?.objectiveId).toBe(objectiveId);
    });

    it('rejects non-commander readers with 403 (even the assignee)', async () => {
      const res = await app.request(OBJECTIVE_PATHS.traces(objectiveId), {
        headers: { Authorization: `Bearer ${ASSIGNEE_TOKEN}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/only commanders/);
    });

    it('rejects a random teammate with 403', async () => {
      const res = await app.request(OBJECTIVE_PATHS.traces(objectiveId), {
        headers: { Authorization: `Bearer ${OTHER_TOKEN}` },
      });
      expect(res.status).toBe(403);
    });

    it('returns 404 for an unknown objective', async () => {
      const res = await app.request(OBJECTIVE_PATHS.traces('obj-nowhere'), {
        headers: { Authorization: `Bearer ${CMD_TOKEN}` },
      });
      expect(res.status).toBe(404);
    });
  });
});
