// Bounded-retry wrapper for the updater's hot-exit flush (ROADMAP.md D2,
// Codex re-review of PR #309): re-verifies that nothing changed between a
// flush pass's start and end by comparing a caller-supplied signature,
// retrying the whole pass (up to `maxRetries` times) if it did, rather
// than trusting a snapshot that may already be stale. Pulled out of
// main.ts purely so this ordering/retry contract gets real vitest
// coverage — main.ts is wired directly into IPC/DOM/editor and isn't
// unit-testable on its own (same reasoning as sessionpersist.ts's and
// savecompletion.ts's own header comments).
//
// The caller (main.ts's flushForUpdateRestart) already holds the editor
// frozen read-only across the whole call (src/updater.ts's
// UpdaterDeps.freezeForUpdate), which should make a doc's signature
// changing mid-pass structurally impossible — this is a re-verification
// of that invariant, not the primary defense against it.

export interface RetryingFlushOptions {
  /** Runs one flush pass; resolves `false` on a genuine write failure
   *  (a backup or session write that didn't land) — returned immediately
   *  by `flushWithRevisionRecheck` without spending a retry on it, since a
   *  write failure isn't something re-running the same pass fixes. */
  runPass: () => Promise<boolean>;
  /** Cheap snapshot of whatever must not change during a pass (main.ts
   *  passes every open tab's `id:revision` pair, joined) — compared
   *  before and after each pass. */
  signature: () => string;
  /** Extra attempts beyond the first, spent only on a *changed* signature
   *  after a successful pass — never on a `runPass` failure (see
   *  `runPass`'s doc comment above). */
  maxRetries: number;
  /** Called once per retry, purely for logging/observability — never
   *  called on the final exhausted attempt (there's nothing left to
   *  retry into). */
  onRetry?: (attempt: number, maxAttempts: number) => void;
}

/**
 * Runs `runPass` up to `1 + maxRetries` times. Resolves `true` as soon as a
 * pass both succeeds and leaves `signature()` unchanged from just before it
 * ran. Resolves `false` immediately on any `runPass` failure, or once every
 * attempt is spent and the signature never stabilized.
 */
export async function flushWithRevisionRecheck(
  opts: RetryingFlushOptions,
): Promise<boolean> {
  const maxAttempts = opts.maxRetries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = opts.signature();
    const ok = await opts.runPass();
    if (!ok) return false;
    if (opts.signature() === before) return true;
    if (attempt < maxAttempts) opts.onRetry?.(attempt, maxAttempts);
  }
  return false;
}
