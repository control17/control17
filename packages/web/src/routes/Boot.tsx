/**
 * Boot screen — rendered while the session signal is in `loading`
 * state on initial mount. Deliberately tiny; no spinner animation
 * dependency, no layout shift when it disappears.
 */

export function Boot() {
  return (
    <main class="min-h-screen flex items-center justify-center">
      <div class="text-brand-muted text-sm">control17 · loading</div>
    </main>
  );
}
