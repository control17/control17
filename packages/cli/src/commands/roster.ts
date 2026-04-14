/**
 * `c17 roster` — list the team's slots and their current connection state.
 */

import type { Client } from '@control17/sdk/client';

export async function runRosterCommand(client: Client): Promise<string> {
  const { teammates, connected } = await client.roster();
  if (teammates.length === 0) {
    return 'no slots defined';
  }

  const connectedByCallsign = new Map(connected.map((a) => [a.agentId, a]));

  const header = `${'callsign'.padEnd(20)}${'role'.padEnd(14)}${'connected'.padEnd(12)}last_seen`;
  const rows = teammates.map((t) => {
    const callsign = t.callsign.padEnd(20);
    const role = t.role.padEnd(14);
    const state = connectedByCallsign.get(t.callsign);
    const conn = String(state?.connected ?? 0).padEnd(12);
    const last = state ? new Date(state.lastSeen).toISOString() : '-';
    return `${callsign}${role}${conn}${last}`;
  });
  return [header, ...rows].join('\n');
}
