/**
 * Header bar — identity + connection status + logout.
 *
 * Shows: plane · CALLSIGN · role · team · ◈ ON NET / ◇ OFF NET
 * The plane silhouette is the
 * control17 brand mark (also the favicon + PWA icon), inlined so the
 * `currentColor` fill inherits from the surrounding text color.
 */

import { briefing } from '../lib/briefing.js';
import { session } from '../lib/session.js';
import { streamConnected } from '../lib/sse.js';
import { isSidebarOpen, openSidebar } from '../lib/view.js';
import { NotificationToggle } from './NotificationToggle.js';

const LOGO_PATH =
  'M 168 72 L 177 72 L 184 75 L 256 110 L 263 108 L 268 104 L 290 99 L 294 107 L 293 114 L 275 121 L 291 129 L 296 129 L 305 124 L 318 120 L 324 120 L 328 126 L 327 135 L 311 141 L 325 148 L 347 147 L 365 139 L 388 133 L 406 134 L 426 144 L 428 148 L 426 154 L 407 171 L 393 178 L 351 190 L 353 197 L 378 189 L 382 190 L 385 196 L 385 203 L 383 205 L 364 211 L 360 209 L 356 211 L 360 225 L 383 218 L 387 221 L 389 226 L 389 232 L 387 234 L 370 239 L 362 239 L 370 264 L 371 273 L 355 277 L 336 246 L 319 250 L 328 242 L 326 238 L 324 237 L 310 240 L 321 231 L 320 226 L 315 225 L 302 228 L 315 217 L 310 208 L 280 217 L 275 217 L 272 215 L 261 218 L 250 218 L 152 206 L 150 201 L 153 198 L 163 194 L 164 191 L 147 155 L 144 152 L 136 152 L 150 145 L 97 113 L 107 109 L 115 110 L 171 133 L 175 134 L 182 131 L 188 131 L 190 133 L 188 146 L 205 178 L 208 180 L 258 174 L 270 168 L 264 163 L 248 167 L 258 158 L 242 146 L 225 150 L 236 141 L 224 132 L 208 136 L 218 127 L 210 121 L 204 120 L 191 123 L 200 117 L 198 113 L 207 109 L 157 77 L 167 73 Z';

export function Header() {
  const s = session.value;
  const b = briefing.value;
  const connected = streamConnected.value;
  if (s.status !== 'authenticated') return null;

  const drawerOpen = isSidebarOpen.value;

  return (
    <header class="flex items-center justify-between border-b border-brand-border-subtle px-3 sm:px-5 py-3 bg-brand-surface flex-shrink-0 relative z-50 gap-2">
      <div class="flex items-center gap-3 sm:gap-4 min-w-0">
        {/* Hamburger — only visible below md, where the sidebar is
            an overlay drawer. aria-expanded reflects the drawer state
            so screen readers announce the toggle correctly. */}
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          class="md:hidden text-brand-muted hover:text-brand-text p-1 -ml-1 flex-shrink-0"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-5 w-5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <svg
          viewBox="95 70 335 210"
          class="h-6 w-auto text-brand-primary flex-shrink-0"
          fill="currentColor"
          aria-label="Control17"
          role="img"
        >
          <path d={LOGO_PATH} />
        </svg>
        {/* Vertical divider — 1px separator that matches the logo lockup
            in the marketing header, keeps the mark visually distinct
            from the identity cluster. */}
        <span class="hidden sm:block w-px h-5 bg-brand-border-strong" aria-hidden="true" />
        <span class="font-display font-bold uppercase tracking-tight text-brand-text text-lg leading-none truncate">
          {s.slot}
        </span>
        {/* Rank + squadron name are secondary context — drop them
            below sm where every pixel matters. Rank (authority) is
            shown rather than role because it's the load-bearing
            identity axis for command authority. Role lives in the
            Overview / Roster panel for anyone who needs it. */}
        <span class="hidden sm:inline font-display font-semibold uppercase tracking-wider text-xs text-brand-subtle leading-none">
          {s.authority}
        </span>
        {b && (
          <span class="hidden md:inline font-display font-medium uppercase tracking-wide text-xs text-brand-subtle leading-none truncate">
            · {b.squadron.name}
          </span>
        )}
      </div>
      <div class="flex items-center gap-3 sm:gap-4 flex-shrink-0">
        <NotificationToggle />
        {/* Connection indicator: icon-only below sm, full label at sm+.
            The title attribute still surfaces the state on hover for
            desktop + assistive tech. Uses the tactical glyph convention
            from the brand guide: ● = operational, ◇ = off-net. */}
        <span
          title={connected ? 'on net' : 'off net'}
          class={
            connected ? 'c17-status-badge text-brand-ok' : 'c17-status-badge text-brand-subtle'
          }
        >
          <span class="sm:hidden text-sm" aria-hidden="true">
            {connected ? '●' : '◇'}
          </span>
          <span class="hidden sm:inline">{connected ? '● ON NET' : '◇ OFF NET'}</span>
        </span>
      </div>
    </header>
  );
}
