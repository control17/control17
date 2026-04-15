/**
 * `c17 roster` — list the squadron's slots and their current state.
 */

import type { Client } from '@control17/sdk/client';

export async function runRosterCommand(client: Client): Promise<string> {
  const { teammates, connected } = await client.roster();
  if (teammates.length === 0) {
    return 'no slots defined';
  }

  const connectedByCallsign = new Map(connected.map((a) => [a.agentId, a]));

  const header = `${'callsign'.padEnd(20)}${'role'.padEnd(14)}${'authority'.padEnd(12)}${'connected'.padEnd(12)}last_seen`;
  const rows = teammates.map((t) => {
    const callsign = t.callsign.padEnd(20);
    const role = t.role.padEnd(14);
    const authority = t.authority.padEnd(12);
    const state = connectedByCallsign.get(t.callsign);
    const conn = String(state?.connected ?? 0).padEnd(12);
    const last = state ? new Date(state.lastSeen).toISOString() : '-';
    return `${callsign}${role}${authority}${conn}${last}`;
  });
  return [header, ...rows].join('\n');
}
