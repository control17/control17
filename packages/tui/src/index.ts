/**
 * `@control17/tui` — interactive terminal UI for control17.
 *
 * Exposes `runConnectUI()` as the sole public entry point. The caller
 * (either `c17 connect` or a direct Node consumer) provides an
 * authenticated SDK Client and a fully-populated `BriefingResponse`
 * (callsign, role, team, teammates, composed instructions). This
 * module handles the Ink render lifecycle.
 */

export { type ConnectUIOptions, runConnectUI } from './ui.js';
export { TUI_VERSION } from './version.js';
