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
        class="text-xs text-brand-muted hover:text-brand-text mb-3"
      >
        ← back to objectives
      </button>
      <h1 class="text-xl font-bold text-brand-text mb-4">New objective</h1>

      <form onSubmit={onSubmit} class="space-y-4 max-w-2xl">
        <label class="block">
          <span class="text-xs uppercase tracking-wide text-brand-muted">Title</span>
          <input
            type="text"
            value={title.value}
            onInput={(e) => {
              title.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Fix the login redirect bug"
            class="mt-1 w-full bg-brand-bg border border-brand-border rounded px-3 py-2 text-brand-text focus:outline-none focus:border-brand-primary"
          />
        </label>

        <label class="block">
          <span class="text-xs uppercase tracking-wide text-brand-muted">
            Outcome <span class="text-brand-primary">*</span>
          </span>
          <div class="text-[11px] text-brand-muted mt-0.5 mb-1">
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
            class="w-full bg-brand-bg border border-brand-border rounded px-3 py-2 text-brand-text focus:outline-none focus:border-brand-primary"
          />
        </label>

        <label class="block">
          <span class="text-xs uppercase tracking-wide text-brand-muted">Body (optional)</span>
          <textarea
            rows={4}
            value={body.value}
            onInput={(e) => {
              body.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="Additional context — links, reproductions, constraints."
            class="mt-1 w-full bg-brand-bg border border-brand-border rounded px-3 py-2 text-brand-text focus:outline-none focus:border-brand-primary"
          />
        </label>

        <label class="block">
          <span class="text-xs uppercase tracking-wide text-brand-muted">Assignee</span>
          <select
            value={assignee.value}
            onChange={(e) => {
              assignee.value = (e.currentTarget as HTMLSelectElement).value;
            }}
            class="mt-1 w-full bg-brand-bg border border-brand-border rounded px-3 py-2 text-brand-text focus:outline-none focus:border-brand-primary"
          >
            <option value="">select a teammate…</option>
            {teammates.map((t) => (
              <option key={t.callsign} value={t.callsign}>
                {t.callsign} ({t.role})
              </option>
            ))}
          </select>
        </label>

        <div class="block">
          <span class="text-xs uppercase tracking-wide text-brand-muted">
            Initial watchers (optional)
          </span>
          <div class="text-[11px] text-brand-muted mt-0.5 mb-1">
            Teammates who should be looped into the objective's discussion thread from the
            start. They'll receive every lifecycle event and discussion post without being
            the assignee. Commanders see everything automatically; don't add them here.
          </div>
          {watchers.value.length > 0 && (
            <div class="flex flex-wrap gap-1.5 mb-2">
              {watchers.value.map((w) => (
                <span
                  key={w}
                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-brand-surface border border-brand-border text-brand-text"
                >
                  <span>{w}</span>
                  <button
                    type="button"
                    onClick={() => {
                      watchers.value = watchers.value.filter((x) => x !== w);
                    }}
                    class="text-brand-muted hover:text-red-300 text-[11px] leading-none -mr-0.5"
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
            class="w-full bg-brand-bg border border-brand-border rounded px-3 py-2 text-brand-text focus:outline-none focus:border-brand-primary"
          >
            <option value="">add a watcher…</option>
            {teammates
              .filter(
                (t) => !watchers.value.includes(t.callsign) && t.callsign !== assignee.value,
              )
              .map((t) => (
                <option key={t.callsign} value={t.callsign}>
                  {t.callsign} ({t.role})
                </option>
              ))}
          </select>
        </div>

        {err.value && (
          <div class="text-xs text-red-400 border border-red-900/50 bg-red-950/30 rounded p-2">
            {err.value}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          class="px-4 py-2 rounded bg-brand-primary text-brand-bg font-semibold disabled:opacity-40 hover:brightness-110"
        >
          {busy.value ? 'creating…' : 'Create + assign'}
        </button>
      </form>
    </div>
  );
}

export function __resetObjectiveCreateForTests(): void {
  resetForm();
  busy.value = false;
}
