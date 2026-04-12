/**
 * Main Ink application for `c17 connect`.
 *
 * Layout:
 *   ┌─ sidebar ──┬─ transcript ──────────────────┐
 *   │ * Primary  │ [12:01] alice: hey squadron    │
 *   │   bob (2)  │ [12:02] bob: roger that        │
 *   │   ci       │                                │
 *   │            ├────────────────────────────────│
 *   │            │ > your message here_           │
 *   └────────────┴────────────────────────────────┘
 *
 * Tab/Shift-Tab switch threads. Enter sends. Ctrl-C quits.
 */

import type { Client } from '@control17/sdk/client';
import type { PrincipalKind } from '@control17/sdk/types';
import { type Instance, render } from 'ink';
import React from 'react';
import { App } from './app.js';

export interface ConnectUIOptions {
  client: Client;
  principalName: string;
  principalKind: PrincipalKind;
}

export async function runConnectUI(options: ConnectUIOptions): Promise<void> {
  const { client, principalName, principalKind } = options;

  // Register ourselves before rendering so the broker knows we exist.
  await client.register(principalName);

  const instance: Instance = render(
    React.createElement(App, { client, principalName, principalKind }),
  );

  await instance.waitUntilExit();
}
