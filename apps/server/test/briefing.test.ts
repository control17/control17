import type { Role, Slot, Team, Teammate } from '@control17/sdk/types';
import { describe, expect, it } from 'vitest';
import { composeBriefing } from '../src/briefing.js';

const TEAM: Team = {
  name: 'alpha-squadron',
  mission: 'Ship the payment service.',
  brief: 'We own the full lifecycle of the payment service.',
};

const OPERATOR_ROLE: Role = {
  description: 'Directs the team.',
  instructions: 'Lead the team and issue directives in the team channel.',
  editor: true,
};

const IMPLEMENTER_ROLE: Role = {
  description: 'Writes code.',
  instructions: 'Take direction from the operator, ship code, report progress.',
};

const ACTUAL: Slot = { callsign: 'ACTUAL', role: 'operator' };
const ALPHA_1: Slot = { callsign: 'ALPHA-1', role: 'implementer' };
const SIERRA: Slot = { callsign: 'SIERRA', role: 'implementer' };

const TEAMMATES: Teammate[] = [
  { callsign: 'ACTUAL', role: 'operator' },
  { callsign: 'ALPHA-1', role: 'implementer' },
  { callsign: 'SIERRA', role: 'implementer' },
];

describe('composeBriefing', () => {
  it('includes callsign, role, team, teammates, and canEdit', () => {
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: OPERATOR_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
    });
    expect(briefing.callsign).toBe('ACTUAL');
    expect(briefing.role).toBe('operator');
    expect(briefing.team).toEqual(TEAM);
    expect(briefing.teammates).toEqual(TEAMMATES);
    expect(briefing.canEdit).toBe(true);
  });

  it('marks canEdit=false for non-editor roles', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
    });
    expect(briefing.canEdit).toBe(false);
  });

  it('renders complementary instructions that reference team context', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
    });
    // Complementary voice, not "you are"
    expect(briefing.instructions).toContain('you go by ALPHA-1');
    expect(briefing.instructions).toContain('Your role here: implementer');
    expect(briefing.instructions).toContain(TEAM.name);
    expect(briefing.instructions).toContain(TEAM.mission);
    expect(briefing.instructions).toContain(TEAM.brief);
    expect(briefing.instructions).toContain(IMPLEMENTER_ROLE.instructions);
  });

  it('lists other teammates and filters self out of the rendered list', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
    });
    // Self appears in raw teammates array
    expect(briefing.teammates.some((t) => t.callsign === 'ALPHA-1')).toBe(true);
    // But does NOT appear in the rendered "Teammates on the net:" section.
    const linesAfterHeader = briefing.instructions
      .split('\n')
      .slice(briefing.instructions.split('\n').indexOf('Teammates on the net:'))
      .join('\n');
    expect(linesAfterHeader).toContain('ACTUAL');
    expect(linesAfterHeader).toContain('SIERRA');
    // The self line should not appear as a teammate bullet
    expect(linesAfterHeader).not.toMatch(/^\s{2}ALPHA-1\s/m);
  });

  it('omits the brief line when team.brief is empty', () => {
    const teamNoBrief: Team = { ...TEAM, brief: '' };
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: OPERATOR_ROLE,
      team: teamNoBrief,
      teammates: TEAMMATES,
    });
    expect(briefing.instructions).not.toContain('Brief:');
    expect(briefing.instructions).toContain(`Mission: ${teamNoBrief.mission}`);
  });

  it('falls back to a placeholder when selfRole.instructions is empty', () => {
    const emptyRole: Role = { description: '', instructions: '' };
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: emptyRole,
      team: TEAM,
      teammates: TEAMMATES,
    });
    expect(briefing.instructions).toContain('(no role-specific instructions defined for operator)');
  });

  it('notes that the link suppresses self-echoes on the live stream', () => {
    const briefing = composeBriefing({
      self: SIERRA,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
    });
    expect(briefing.instructions).toContain(
      'Your own sends are suppressed by the link before they reach you',
    );
  });
});
