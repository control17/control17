import type { Role, Slot, Squadron, Teammate } from '@control17/sdk/types';
import { describe, expect, it } from 'vitest';
import { composeBriefing } from '../src/briefing.js';

const SQUADRON: Squadron = {
  name: 'alpha-squadron',
  mission: 'Ship the payment service.',
  brief: 'We own the full lifecycle of the payment service.',
};

const OPERATOR_ROLE: Role = {
  description: 'Directs the squadron.',
  instructions: 'Lead the squadron and issue directives in the squadron channel.',
};

const IMPLEMENTER_ROLE: Role = {
  description: 'Writes code.',
  instructions: 'Take direction from command, ship code, report progress.',
};

const ACTUAL: Slot = { callsign: 'ACTUAL', role: 'operator', authority: 'commander' };
const ALPHA_1: Slot = { callsign: 'ALPHA-1', role: 'implementer', authority: 'operator' };
const SIERRA: Slot = { callsign: 'SIERRA', role: 'implementer', authority: 'operator' };

const TEAMMATES: Teammate[] = [
  { callsign: 'ACTUAL', role: 'operator', authority: 'commander' },
  { callsign: 'ALPHA-1', role: 'implementer', authority: 'operator' },
  { callsign: 'SIERRA', role: 'implementer', authority: 'operator' },
];

describe('composeBriefing', () => {
  it('includes callsign, role, authority, squadron, and teammates', () => {
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: OPERATOR_ROLE,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.callsign).toBe('ACTUAL');
    expect(briefing.role).toBe('operator');
    expect(briefing.authority).toBe('commander');
    expect(briefing.squadron).toEqual(SQUADRON);
    expect(briefing.teammates).toEqual(TEAMMATES);
    expect(briefing.openObjectives).toEqual([]);
  });

  it('surfaces authority in the instructions when elevated', () => {
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: OPERATOR_ROLE,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('Your rank: commander');
  });

  it('always surfaces rank in the instructions, including for plain operators', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    // Every agent should know its own rank explicitly — absence of
    // a line is not self-knowledge. Operators need to see
    // "Your rank: operator" as clearly as commanders see theirs.
    expect(briefing.instructions).toContain('Your rank: operator');
  });

  it('renders complementary instructions that reference squadron context', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('you go by ALPHA-1');
    expect(briefing.instructions).toContain('Your role here: implementer');
    expect(briefing.instructions).toContain(SQUADRON.name);
    expect(briefing.instructions).toContain(SQUADRON.mission);
    expect(briefing.instructions).toContain(SQUADRON.brief);
    expect(briefing.instructions).toContain(IMPLEMENTER_ROLE.instructions);
  });

  it('lists other teammates and filters self out of the rendered list', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.teammates.some((t) => t.callsign === 'ALPHA-1')).toBe(true);
    const linesAfterHeader = briefing.instructions
      .split('\n')
      .slice(briefing.instructions.split('\n').indexOf('Teammates on the net:'))
      .join('\n');
    expect(linesAfterHeader).toContain('ACTUAL');
    expect(linesAfterHeader).toContain('SIERRA');
    expect(linesAfterHeader).not.toMatch(/^\s{2}ALPHA-1\s/m);
  });

  it('omits the brief line when squadron.brief is empty', () => {
    const squadronNoBrief: Squadron = { ...SQUADRON, brief: '' };
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: OPERATOR_ROLE,
      squadron: squadronNoBrief,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).not.toContain('Brief:');
    expect(briefing.instructions).toContain(`Mission: ${squadronNoBrief.mission}`);
  });

  it('falls back to a placeholder when selfRole.instructions is empty', () => {
    const emptyRole: Role = { description: '', instructions: '' };
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: emptyRole,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('(no role-specific instructions defined for operator)');
  });

  it('notes that the link suppresses self-echoes on the live stream', () => {
    const briefing = composeBriefing({
      self: SIERRA,
      selfRole: IMPLEMENTER_ROLE,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('Your own sends are suppressed by the link');
  });

  it('returns open objectives on the response but does NOT render them into instructions', () => {
    // MCP has no refresh hook for the `instructions` string, so we
    // deliberately keep the live list out of the prose — it would go
    // stale the moment a new objective was assigned mid-session. Tool
    // descriptions for `objectives_list` carry the live state via
    // `tools/list_changed`.
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [
        {
          id: 'obj-1',
          title: 'Fix the login redirect bug',
          body: '',
          outcome: 'Users hitting /login while authenticated land on /dashboard.',
          status: 'active',
          assignee: 'ALPHA-1',
          originator: 'ACTUAL',
          watchers: [],
          createdAt: 1,
          updatedAt: 1,
          completedAt: null,
          result: null,
          blockReason: null,
        },
      ],
    });
    // openObjectives surfaces on the response body for non-briefing callers.
    expect(briefing.openObjectives).toHaveLength(1);
    expect(briefing.openObjectives[0]?.id).toBe('obj-1');
    // But the ID / title / outcome never land in the prose.
    expect(briefing.instructions).not.toContain('obj-1');
    expect(briefing.instructions).not.toContain('Fix the login redirect bug');
    expect(briefing.instructions).not.toContain('Objectives on your plate');
  });

  it('teaches the objective mechanism in instructions regardless of current plate', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      squadron: SQUADRON,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    // The mechanism explanation + tool verbs are always present so
    // the agent knows what to do when an objective push arrives,
    // regardless of whether one is on the plate right now.
    expect(briefing.instructions).toContain('── Objectives ──');
    expect(briefing.instructions).toContain('kind="objective"');
    expect(briefing.instructions).toContain('objectives_list');
    expect(briefing.instructions).toContain('objectives_update');
    expect(briefing.instructions).toContain('objectives_complete');
    expect(briefing.instructions).toContain('required `outcome`');
  });
});
