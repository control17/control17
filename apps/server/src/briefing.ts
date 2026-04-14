/**
 * Team briefing composition.
 *
 * Turns the raw team config + a specific slot into a `BriefingResponse`
 * with a pre-composed `instructions` string ready for the MCP link to
 * hand to `new Server({instructions})`.
 *
 * Voice matters: the instructions are written to COMPLEMENT the
 * agent's base identity, not overwrite it. "On this team you go by X"
 * and "Your role here: Y" — team context layered on top of whatever
 * the agent already knows about itself. This is the enabling layer;
 * it doesn't fight the base system prompt.
 */

import type { BriefingResponse, Role, Slot, Team, Teammate } from '@control17/sdk/types';

export interface ComposeBriefingInput {
  self: Slot;
  selfRole: Role;
  team: Team;
  /** Every teammate on the team, including the caller. The caller is filtered out of the rendered list. */
  teammates: Teammate[];
}

/**
 * Compose the briefing response for a slot. Returns the structured
 * data plus the pre-rendered `instructions` string.
 */
export function composeBriefing(input: ComposeBriefingInput): BriefingResponse {
  const { self, selfRole, team, teammates } = input;
  const others = teammates.filter((t) => t.callsign !== self.callsign);
  const instructions = composeInstructions(self, selfRole, team, others);

  return {
    callsign: self.callsign,
    role: self.role,
    team,
    teammates,
    instructions,
    canEdit: Boolean(selfRole.editor),
  };
}

function composeInstructions(self: Slot, selfRole: Role, team: Team, others: Teammate[]): string {
  const longestCallsign = others.reduce((max, t) => Math.max(max, t.callsign.length), 0);
  const teammateLines = others.map((t) => `  ${t.callsign.padEnd(longestCallsign)} — ${t.role}`);

  const parts: Array<string | false> = [
    `You've connected to the control17 net. On this team you go by ${self.callsign}.`,
    `Your role here: ${self.role}`,
    ``,
    `Team: ${team.name}`,
    `Mission: ${team.mission}`,
    team.brief.trim().length > 0 && `Brief: ${team.brief}`,
    ``,
    `Role notes for ${self.role}:`,
    selfRole.instructions.trim().length > 0
      ? selfRole.instructions
      : `(no role-specific instructions defined for ${self.role})`,
    ``,
    others.length > 0 && `Teammates on the net:`,
    ...(others.length > 0 ? teammateLines : []),
    others.length > 0 && ``,
    `Events from the net arrive as <channel source="c17" thread="primary|dm" from="CALLSIGN">body</channel>.`,
    `When thread="primary" it's the team channel — reply with \`broadcast\`.`,
    `When thread="dm" it's a direct message — reply with \`send\`.`,
    `Your own sends are suppressed by the link before they reach you — you will not see echoes of your own broadcasts or DMs on the live stream. \`recent\` still returns them in scrollback.`,
    `Use \`roster\` to see who's currently on the net and \`recent\` to pull scrollback.`,
  ];

  return parts.filter((p): p is string => typeof p === 'string').join('\n');
}
