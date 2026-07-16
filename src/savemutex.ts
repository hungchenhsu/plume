// Per-doc save/reload in-flight mutex (issue #124, a critic-review finding
// against #112's revision guard). savecompletion.ts's decideSaveCompletion
// protects a single saveFlow against a *plain edit* landing mid-flight, but
// it never guarded against a second *operation* — another reloadFromDisk or
// another saveFlow — running concurrently for the same doc:
//
// - save x reload: a watcher-triggered (or saveFlow's own stale-confirm
//   "reload") reloadFromDisk running while a saveFlow's IPC round trip is
//   still in flight sets dirty=false, drops the hot-exit backup, and
//   overwrites doc.fingerprint/buffer out from under the save. Once the
//   save resolves, decideSaveCompletion correctly refuses to re-clear
//   dirty/re-drop the backup (revision no longer matches its
//   revisionAtStart snapshot) — but by then the reload had already applied
//   its own effects, and whichever of the two IPC calls happens to resolve
//   *last* wins the doc's final buffer/fingerprint, independent of which
//   one actually reflects what's really on disk. Depending on resolution
//   order this leaves either a hot-exit backup that no longer covers
//   anything (backupName set, tab already clean) or a fingerprint that no
//   longer matches the buffer it's supposedly describing (the next save
//   misreports staleness once, for content nothing external actually
//   changed).
// - save x save: saveFlow has no re-entrancy guard at all — two overlapping
//   calls for the same doc each snapshot/compare independently, so the
//   result (no data loss, but which write "wins" and what the final
//   dirty/backup state is) depends on IPC resolution order instead of being
//   deterministic.
//
// Fix: only one of {save, reload} may run for a given doc at a time
// (tracked as `doc.saveReloadInFlight` in tabs.ts/main.ts). A request that
// arrives while the lock is held never runs concurrently and is never
// silently dropped either — it's recorded in a single per-doc pending slot
// (`doc.pendingReload` / `doc.pendingSaveAs`) and re-evaluated once the
// lock releases, via the decisions below.
//
// main.ts's withLock/drainLock is the async glue that actually acquires/
// releases the lock and drives IPC — like every other main.ts flow it's
// wired directly into IPC/DOM/editor and isn't unit-testable on its own
// (see savecompletion.ts's header comment for the same reasoning applied to
// saveFlow's completion step). This module is the pure decision table that
// glue defers to at every branch point, so the exhaustive coverage lives
// here instead — same split as chunkguard.ts/chunkpolicy.ts for issue #120.

export type LockOwner = "save" | "reload" | null;

export interface LockEntryInput {
  /** doc.saveReloadInFlight as of right now. */
  inFlight: LockOwner;
}

/**
 * Whether a new save or reload request must defer instead of running
 * immediately — true whenever *anything* (save or reload, doesn't matter
 * which) already holds the per-doc lock. Same rule for both operations:
 * main.ts's saveFlow and reloadFromDisk both consult this at entry, before
 * either touches any doc state.
 *
 * This also means saveFlow's own internal reloadFromDisk call (the
 * stale-confirm dialog's "reload" choice) defers rather than running
 * inline — main.ts's withLock still holds the save lock for the entire
 * saveFlow body, including that dialog. It doesn't deadlock: the deferred
 * reload becomes a pendingReload that drainLock processes the instant
 * saveFlow's own withLock releases the lock in its finally block, so the
 * reload still runs, just via the same drain path every other deferred
 * request takes instead of a direct call.
 */
export function mustDefer(input: LockEntryInput): boolean {
  return input.inFlight !== null;
}

export interface DrainInput {
  /** A reload was requested while the lock was held by something else.
   *  Single slot: reload has no parameters to overwrite, so a second
   *  request while one is already pending leaves this at true either way —
   *  unlike pendingSaveAs there's no "which one" to track. */
  pendingReload: boolean;
  /** A save was requested while the lock was held; the saveAs flag of the
   *  *last* such request. Single slot — a newer request overwrites an
   *  older still-pending one rather than queuing both (issue #124's own
   *  "後到覆蓋先到"). Null means no pending save. */
  pendingSaveAs: boolean | null;
  /** doc.dirty right now, i.e. after whatever just released the lock (a
   *  completed save or reload) has already applied its own effects. */
  dirty: boolean;
  /** Issue #217 (a critic-review finding against #208's own fix): main.ts's
   *  blockedByReadOnly(doc) — i.e. doc.truncated || doc.userReadOnly,
   *  tabs.ts's isEffectivelyReadOnly — evaluated fresh right now, not the
   *  snapshot saveFlow's own entry gate took when the pending save was
   *  first enqueued. A doc can turn read-only *during* the defer window:
   *  most plausibly doc.userReadOnly, a plain state flip (View menu) never
   *  routed through the save/reload lock at all, so it can land at any
   *  point while a save sits coalesced. doc.truncated in principle too,
   *  though every production path that actually sets it (applyOpenedForReload)
   *  also clears dirty in that same synchronous call — nextDrainStep below
   *  checks dirty first for exactly this reason, so that case is already
   *  handled correctly by dropSave without ever reaching this field. Only
   *  consulted when a pending save is both present and still dirty — the
   *  caller is expected to only pay for computing this when it can
   *  actually change the outcome, since main.ts's blockedByReadOnly has a
   *  rejection-dialog side effect that would be actively misleading to
   *  show for a request nextDrainStep is about to drop as already-covered
   *  rather than reject. */
  blockedByReadOnly: boolean;
}

export type DrainStep =
  | { kind: "reload" }
  | { kind: "save"; saveAs: boolean }
  /** A save was pending, but the doc came out of the lock already clean —
   *  the save that just finished already wrote this exact content (its own
   *  revision-matched completion cleared dirty), or a reload that just
   *  finished discarded whatever the pending save would have written.
   *  Running it for real would be a redundant no-op write, so it's dropped
   *  instead (issue #124: "若 revision 沒變...否則丟棄，save1 已寫最新內容").
   *  Callers still waiting on the pending save's outcome are told it's
   *  covered (see main.ts's drainLock) — dropping the write doesn't mean
   *  failing the request. Takes precedence over blockedByReadOnly (issue
   *  #217) whenever both would otherwise apply: a doc that's clean has
   *  nothing left to write regardless of its read-only status a moment
   *  later, so there is nothing to reject — see nextDrainStep's own doc
   *  comment for why getting this ordering backwards would be wrong, not
   *  just redundant. */
  | { kind: "dropSave" }
  /** A save was pending and the doc is still genuinely dirty — it has
   *  content that hasn't reached disk under any interpretation — but the
   *  doc is blocked (truncated or userReadOnly) as of this exact recheck
   *  (issue #217). Unlike dropSave, nothing already covers this request:
   *  running it anyway would write doc's current buffer (possibly a
   *  large-file preview slice) over the real file, exactly what saveFlow's
   *  own entry gate exists to prevent for a non-deferred save — this is
   *  that same gate, re-run at the one other point content can actually
   *  reach disk. Callers still waiting on the pending save's outcome are
   *  told `false` (see main.ts's drainLock), not `true` like dropSave: no
   *  write of any kind happened this time, so nothing covers what they
   *  asked for. */
  | { kind: "rejectBlocked" }
  | { kind: "done" };

/**
 * What to do next once the lock holder (a save or a reload) has released
 * doc.saveReloadInFlight. Consulted in a loop (main.ts's drainLock) until
 * it returns "done": draining one step (e.g. applying a reload) can itself
 * pick up a newer pending request before the next check, since each step
 * re-acquires the lock and runs for real rather than being a pure state
 * transition.
 *
 * Reload always drains before a pending save when a doc comes out of the
 * lock with both queued. Issue #124 specifies each pairwise interleaving
 * (save-blocks-reload, save-blocks-save, reload-blocks-save) independently
 * and doesn't say what a doc with *both* a pending reload and a pending
 * save should do — this picks reload first as the one reasonable
 * resolution: reconcile with external truth before deciding whether the
 * queued save is still meaningful, rather than the other way around. A
 * pending reload's own presence also short-circuits blockedByReadOnly
 * entirely for this call — it's only ever consulted once control actually
 * reaches the save branch below.
 *
 * For a pending save, dirty is checked before blockedByReadOnly (issue
 * #217): dirty=false means whatever just released the lock already covers
 * this request — either its own matching-revision completion wrote this
 * exact content, or a reload the user explicitly consented to discarded it
 * — and that stays true independent of the doc's read-only status a moment
 * later. Rejecting a request that already succeeded (or was already
 * knowingly abandoned) would be actively wrong, not just redundant, so
 * dropSave takes it before blockedByReadOnly is even consulted. Only a
 * save that's *still* dirty — genuinely has content that hasn't reached
 * disk under any interpretation — reaches the blockedByReadOnly check at
 * all.
 */
export function nextDrainStep(input: DrainInput): DrainStep {
  if (input.pendingReload) return { kind: "reload" };
  if (input.pendingSaveAs !== null) {
    if (!input.dirty) return { kind: "dropSave" };
    if (input.blockedByReadOnly) return { kind: "rejectBlocked" };
    return { kind: "save", saveAs: input.pendingSaveAs };
  }
  return { kind: "done" };
}

/**
 * Deep-equality over the opaque Fingerprint blob ipc.ts's `unknown` type
 * hides (src-tauri/src/fsguard.rs's `Fingerprint` — a plain `#[derive(
 * PartialEq, Eq, Serialize, Deserialize)]` struct with `serde(rename_all =
 * "camelCase")`, always serialized in the same declared field order, never
 * a Map/Set or anything else order-sensitive) — a JSON round-trip is a safe
 * proxy for the Rust-side `==` this data was compared with before crossing
 * IPC as an opaque value.
 *
 * Used to re-validate a pending reload once its blocking op releases the
 * lock (issue #124): a fresh disk read whose fingerprint still matches
 * doc.fingerprint (the baseline the save or reload that just ran already
 * established) means nothing has changed beyond that — applying it anyway
 * would be a pointless, disruptive buffer replacement (fresh undo history,
 * lost cursor/scroll position) for content identical to what's already
 * showing. Only a genuine mismatch means something *else* changed the file
 * in the meantime and the reload should actually apply.
 */
export function fingerprintsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
