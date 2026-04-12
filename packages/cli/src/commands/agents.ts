/**
 * `c17 agents` — list all currently registered agents.
 */

import type { Client } from '@control17/sdk/client';

export async function runAgentsCommand(client: Client): Promise<string> {
  const agents = await client.listAgents();
  if (agents.length === 0) {
    return 'no agents registered';
  }
  const header = `${'agent_id'.padEnd(28)}${'kind'.padEnd(10)}${'connected'.padEnd(12)}last_seen`;
  const rows = agents.map((a) => {
    const id = a.agentId.padEnd(28);
    const kind = (a.kind ?? '-').padEnd(10);
    const conn = String(a.connected).padEnd(12);
    const last = new Date(a.lastSeen).toISOString();
    return `${id}${kind}${conn}${last}`;
  });
  return [header, ...rows].join('\n');
}
