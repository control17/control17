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
  blocked: 'text-yellow-400',
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
      <div class="flex-1 flex items-center justify-center text-brand-muted text-sm">
        loading objectives…
      </div>
    );
  }

  return (
    <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
      <div class="flex items-center justify-between mb-4">
        <div>
          <div class="text-[10px] uppercase tracking-wide text-brand-muted">Objectives</div>
          <div class="text-lg font-bold text-brand-text">{list.length} on the board</div>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={selectObjectiveCreate}
            class="px-3 py-1.5 text-xs rounded bg-brand-primary text-brand-bg font-semibold hover:brightness-110"
          >
            + New
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <div class="text-brand-muted text-sm text-center py-8">
          no objectives yet — {canCreate ? 'click "+ New" to assign one' : 'nothing on your plate'}
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
        class="w-full text-left px-3 py-2 rounded border border-brand-border hover:bg-brand-surface/60 focus:outline-none focus:border-brand-primary"
      >
        <div class="flex items-center justify-between gap-2 min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <span class={`text-xs font-semibold uppercase ${STATUS_STYLE[objective.status]}`}>
              {objective.status}
            </span>
            <span class="text-brand-text font-semibold truncate">{objective.title}</span>
          </div>
          <span class="text-xs text-brand-muted flex-shrink-0">
            {isMine ? '(you)' : `→ ${objective.assignee}`}
          </span>
        </div>
        <div class="text-xs text-brand-muted mt-1 truncate">outcome: {objective.outcome}</div>
        {objective.blockReason && (
          <div class="text-xs text-yellow-400 mt-1">blocked: {objective.blockReason}</div>
        )}
      </button>
    </li>
  );
}
