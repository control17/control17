/**
 * Main Ink application for `c17 connect`.
 *
 * Layout:
 *   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 *   ┃ C17  CALLSIGN · role · team          ◈ ON NET    ┃
 *   ┃  PRIMARY  │ ALPHA │ BRAVO 2                       ┃
 *   ┃─────────────────────────────────────────────────── ┃
 *   ┃                                                    ┃
 *   ┃ 14:32  CALLSIGN                                    ┃
 *   ┃        hey squadron, status check                  ┃
 *   ┃                                                    ┃
 *   ┃─────────────────────────────────────────────────── ┃
 *   ┃ > _                                                ┃
 *   ┃ PRIMARY · TAB switch · ENTER send · CTRL-C off net ┃
 *   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * Tab/Shift-Tab switch threads. Enter sends. Ctrl-C quits.
 */

import type { Client } from '@control17/sdk/client';
import type { BriefingResponse } from '@control17/sdk/types';
import { type Instance, render } from 'ink';
import React from 'react';
import { App } from './app.js';

export interface ConnectUIOptions {
  client: Client;
  briefing: BriefingResponse;
}

export async function runConnectUI(options: ConnectUIOptions): Promise<void> {
  const { client, briefing } = options;

  // Slots are pre-seeded into the broker registry at server boot, so
  // we don't need to call register() here — we just subscribe via
  // the App component's effect.

  const instance: Instance = render(React.createElement(App, { client, briefing }));

  await instance.waitUntilExit();
}
