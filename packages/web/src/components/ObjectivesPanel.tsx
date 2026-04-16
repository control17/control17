/**
 * Objectives list view — the full plate for a slot (or squadron-wide
 * for lieutenant+). Click a row to open `ObjectiveDetail`. Commanders
 * and lieutenants get a "+ New Objective" button at the top.
 */

import type { Objective, ObjectiveStatus } from '@control17/sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { loadObjectives, objectives, objectivesLoaded } from '../lib/objectives.js';
import { selectObjectiveCreate, selectObjectiveDetail } from '../lib/view.js';

export interface ObjectivesPanelProps {
  viewer: string;
}

const STATUS_STYLE: Record<ObjectiveStatus, string> = {
  active: 'text-brand-primary',
  blocked: 'text-brand-warn',
  done: 'text-brand-muted',
  cancelled: 'text-brand-muted line-through',
};

export function ObjectivesPanel({ viewer }: ObjectivesPanelProps) {
  const b = briefing.value;
  const list = objectives.value;
  const loaded = objectivesLoaded.value;

  useEffect(() => {
    if (!loaded) void loadObjectives();
  }, [loaded]);

  const canCreate = b !== null && (b.authority === 'commander' || b.authority === 'lieutenant');

  if (!loaded) {
    return (
      <div class="flex-1 flex items-center justify-center c17-label">━━ Loading objectives…</div>
    );
  }

  return (
    <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
      <div class="flex items-center justify-between mb-5 pb-4 border-b border-brand-border-subtle">
        <div>
          <div class="c17-label text-brand-primary">━━ Objectives</div>
          <div class="c17-panel-title mt-2">{list.length} on the board</div>
        </div>
        {canCreate && (
          <button type="button" onClick={selectObjectiveCreate} class="c17-btn-sm-primary">
            + New
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <div class="text-brand-muted text-sm text-center py-8 font-medium">
          No objectives yet — {canCreate ? 'click "+ New" to assign one' : 'nothing on your plate'}
        </div>
      ) : (
        <ul class="space-y-2">
          {list.map((o) => (
            <ObjectiveRow key={o.id} objective={o} viewer={viewer} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ObjectiveRow({ objective, viewer }: { objective: Objective; viewer: string }) {
  const isMine = objective.assignee === viewer;
  return (
    <li>
      <button
        type="button"
        onClick={() => selectObjectiveDetail(objective.id)}
        class="w-full text-left px-4 py-3 rounded-sm border border-brand-border-subtle bg-brand-surface/40 hover:bg-brand-surface hover:border-brand-border-strong focus:outline-none focus:border-brand-primary transition-colors duration-100"
      >
        <div class="flex items-center justify-between gap-3 min-w-0">
          <div class="flex items-center gap-3 min-w-0">
            <span
              class={`font-display font-semibold uppercase tracking-widest text-xs leading-none ${STATUS_STYLE[objective.status]}`}
            >
              {objective.status}
            </span>
            <span class="text-brand-text font-semibold truncate">{objective.title}</span>
          </div>
          <span class="font-display font-medium uppercase tracking-wide text-xs text-brand-subtle flex-shrink-0 leading-none">
            {isMine ? '(you)' : `→ ${objective.assignee}`}
          </span>
        </div>
        <div class="text-xs text-brand-muted mt-1.5 truncate font-medium">
          outcome: {objective.outcome}
        </div>
        {objective.blockReason && (
          <div class="text-xs text-brand-warn mt-1 font-medium">
            blocked: {objective.blockReason}
          </div>
        )}
      </button>
    </li>
  );
}
