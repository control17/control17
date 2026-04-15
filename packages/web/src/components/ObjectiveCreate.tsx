/**
 * New-objective form — visible only to lieutenants + commanders.
 * Fields: title, outcome (required), body, assignee (from roster),
 * optional initial watchers.
 * On submit, creates the objective, refreshes the list, and routes
 * to the detail view for the new row.
 */

import { signal } from '@preact/signals';
import { createObjective } from '../lib/objectives.js';
import { roster } from '../lib/roster.js';
import { selectObjectiveDetail, selectObjectivesList } from '../lib/view.js';

const title = signal('');
const outcome = signal('');
const body = signal('');
const assignee = signal('');
const watchers = signal<string[]>([]);
const busy = signal(false);
const err = signal<string | null>(null);

function resetForm(): void {
  title.value = '';
  outcome.value = '';
  body.value = '';
  assignee.value = '';
  watchers.value = [];
  err.value = null;
}

export function ObjectiveCreate() {
  const r = roster.value;
  const teammates = r?.teammates ?? [];
  const canSubmit =
    !busy.value &&
    title.value.trim().length > 0 &&
    outcome.value.trim().length > 0 &&
    assignee.value.length > 0;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    busy.value = true;
    err.value = null;
    try {
      const created = await createObjective({
        title: title.value.trim(),
        outcome: outcome.value.trim(),
        assignee: assignee.value,
        ...(body.value.trim() ? { body: body.value.trim() } : {}),
        ...(watchers.value.length > 0 ? { watchers: watchers.value } : {}),
      });
      resetForm();
      selectObjectiveDetail(created.id);
    } catch (e2) {
      err.value = e2 instanceof Error ? e2.message : String(e2);
    } finally {
      busy.value = false;
    }
  }

  return (
    <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
      <button
        type="button"
        onClick={selectObjectivesList}
        class="c17-label text-brand-subtle hover:text-brand-text mb-4"
      >
        ← Back to objectives
      </button>
      <div class="c17-label text-brand-primary mb-2">━━ New objective</div>
      <h1 class="c17-panel-title !text-2xl mb-6">Create + assign</h1>

      <form onSubmit={onSubmit} class="space-y-5 max-w-2xl">
        <label class="block">
          <span class="c17-label text-brand-subtle block mb-1.5">━━ Title</span>
          <input
            type="text"
            value={title.value}
            onInput={(e) => {
              title.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Fix the login redirect bug"
            class="c17-input"
          />
        </label>

        <label class="block">
          <span class="c17-label text-brand-subtle block mb-1">
            ━━ Outcome <span class="text-brand-primary">*</span>
          </span>
          <div class="text-xs text-brand-muted mt-0.5 mb-2 font-medium leading-relaxed">
            The tangible result that defines "done". Propagates to the assignee's tool descriptions
            and is surfaced when they go to mark complete.
          </div>
          <textarea
            rows={3}
            value={outcome.value}
            onInput={(e) => {
              outcome.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="A user hitting /login while authenticated lands on /dashboard, not /login again."
            class="c17-input"
          />
        </label>

        <label class="block">
          <span class="c17-label text-brand-subtle block mb-1.5">━━ Body (optional)</span>
          <textarea
            rows={4}
            value={body.value}
            onInput={(e) => {
              body.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="Additional context — links, reproductions, constraints."
            class="c17-input"
          />
        </label>

        <label class="block">
          <span class="c17-label text-brand-subtle block mb-1.5">━━ Assignee</span>
          <select
            value={assignee.value}
            onChange={(e) => {
              assignee.value = (e.currentTarget as HTMLSelectElement).value;
            }}
            class="c17-input"
          >
            <option value="">Select a teammate…</option>
            {teammates.map((t) => (
              <option key={t.callsign} value={t.callsign}>
                {t.callsign} ({t.role})
              </option>
            ))}
          </select>
        </label>

        <div class="block">
          <span class="c17-label text-brand-subtle block mb-1">━━ Initial watchers (optional)</span>
          <div class="text-xs text-brand-muted mt-0.5 mb-2 font-medium leading-relaxed">
            Teammates who should be looped into the objective's discussion thread from the start.
            They'll receive every lifecycle event and discussion post without being the assignee.
            Commanders see everything automatically; don't add them here.
          </div>
          {watchers.value.length > 0 && (
            <div class="flex flex-wrap gap-1.5 mb-2">
              {watchers.value.map((w) => (
                <span
                  key={w}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs font-display font-semibold uppercase tracking-wide bg-brand-primary-faint border border-brand-primary-dim text-brand-primary-bright"
                >
                  <span>{w}</span>
                  <button
                    type="button"
                    onClick={() => {
                      watchers.value = watchers.value.filter((x) => x !== w);
                    }}
                    class="text-brand-primary-dim hover:text-brand-err text-sm leading-none -mr-0.5"
                    aria-label={`Remove watcher ${w}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <select
            value=""
            onChange={(e) => {
              const cs = (e.currentTarget as HTMLSelectElement).value;
              if (!cs) return;
              if (!watchers.value.includes(cs) && cs !== assignee.value) {
                watchers.value = [...watchers.value, cs];
              }
              (e.currentTarget as HTMLSelectElement).value = '';
            }}
            class="c17-input"
          >
            <option value="">Add a watcher…</option>
            {teammates
              .filter((t) => !watchers.value.includes(t.callsign) && t.callsign !== assignee.value)
              .map((t) => (
                <option key={t.callsign} value={t.callsign}>
                  {t.callsign} ({t.role})
                </option>
              ))}
          </select>
        </div>

        {err.value && (
          <div class="c17-label !text-brand-err border border-brand-err/40 bg-brand-err/10 rounded-sm px-3 py-2">
            ◆ {err.value}
          </div>
        )}

        <button type="submit" disabled={!canSubmit} class="c17-btn-primary">
          {busy.value ? 'Creating…' : 'Create + assign →'}
        </button>
      </form>
    </div>
  );
}

export function __resetObjectiveCreateForTests(): void {
  resetForm();
  busy.value = false;
}
