// Doc-identity + revision guard for async IPC completions that mutate a
// doc after an await gap (issue #159, first applied to reloadFromDisk and
// reopenWithEncoding — see main.ts's fetchAndApplyReload/
// fetchAndApplyReopen). Every one of these flows shares the same shape:
// capture `doc`, fire an IPC call (openDocument), and once it resolves,
// replace doc.buffer and reset a cluster of doc fields (encoding,
// fingerprint, revision, backup, chunk window, ...) unconditionally. Two
// things can happen while that call is in flight that make an
// unconditional apply wrong:
//
// - The user keeps typing in the same tab. Every edit bumps doc.revision
//   (see tabs.ts's Doc.revision comment — incremented on every editor
//   doc-change, and by reload/reopen/open themselves establishing a fresh
//   baseline) and sets doc.dirty. Applying a response captured before
//   those keystrokes landed would silently discard them — no second
//   confirmation — and the hot-exit backup covering them gets dropped in
//   the same stroke (applyOpenedForReload's dropBackup call), so there's
//   nothing left to recover them from either.
// - The tab gets closed. `doc` survives as a plain JS object (main.ts's
//   fetchAndApplyReload/fetchAndApplyReopen hold it via closure, not a
//   fresh tabs lookup by id), so applying to it wouldn't crash — it would
//   just mutate, and run dropBackup's real delete-the-file IPC for, an
//   orphaned Doc nothing displays anymore.
//
// Neither hazard is issue #124's own — that fix (savemutex.ts's
// mustDefer/nextDrainStep) serializes *save and reload as operations*
// against each other for a doc, so two of them never run concurrently.
// This guard is about a single such operation's *own* await window racing
// a plain edit (or a tab close) in the very doc it's about to overwrite —
// #124's mutex holds the whole time and never looks at revision or tab
// membership at all, so it doesn't (and can't) catch this.
//
// Modeled on chunkguard.ts's ChunkResponseContext/shouldApplyChunkResponse
// (issue #120) and batchconvert.ts's scanGeneration (issue #95/#103): a
// pure capture/validate pair over primitive fields the caller already has
// on hand, not a stateful closure factory. Every other guard/generation
// module here keeps the decision as a pure function that main.ts's
// imperative glue defers to, rather than something that owns mutable
// state itself (see savemutex.ts's header comment for the same split
// applied to the save/reload lock) — this stays consistent with that
// shape instead of introducing a third one. main.ts itself has no
// *.test.ts (see savecompletion.ts's header comment for why); this module
// is what's actually under direct test, and main.ts's own
// fetchAndApplyReload/fetchAndApplyReopen are exercised only indirectly,
// via the simulation harness in this file's own test (see
// savemutex.test.ts/chunkguard.test.ts for the same pattern applied to
// their modules).
//
// Written generically over just {id, revision} — not tabs.ts's Doc, and
// not reload/reopen-specific — so issue #158 (normalize) and #163
// (streaming callback), both flagged as needing the same
// capture-before-IPC / validate-after-IPC treatment, can reuse
// captureIdentity/validateIdentity directly instead of re-deriving their
// own pair.

/** Slice of tabs.ts's Doc this guard reads: just enough to answer "is this
 *  still the same edit session I started with". `id` never changes across
 *  a tab's lifetime (ids are drawn from main.ts's monotonic `nextId`,
 *  never reused), so it's what "the same doc" means here; `revision` (see
 *  tabs.ts's Doc.revision comment) is bumped by every edit and by
 *  reload/reopen/open themselves, so it's what "nothing changed since
 *  capture" means. */
export interface GuardIdentity {
  id: number;
  revision: number;
}

/**
 * Snapshot `doc`'s identity right before starting the async call whose
 * result will later mutate it — e.g. right before `await
 * openDocument(...)` in fetchAndApplyReload/fetchAndApplyReopen. A plain
 * object copy, but named and typed so every call site captures the same
 * two fields the same way instead of guarding ad hoc.
 */
export function captureIdentity(doc: GuardIdentity): GuardIdentity {
  return { id: doc.id, revision: doc.revision };
}

export type GuardVerdict =
  /** Same doc, same revision: nothing that matters happened during the
   *  await — safe to apply the result unconditionally. */
  | "apply"
  /** The captured doc is no longer open (tab closed) — or, defensively, a
   *  `current` that no longer identifies the same doc at all, for a
   *  future caller that re-derives it from a fresh lookup instead of
   *  holding the original reference across the await. Discard the result
   *  outright: no dialog, no partial apply — there's no tab left to ask
   *  about, and nothing left to apply it to. */
  | "closed"
  /** Still open, same doc, but revision moved since capture — something
   *  changed it while the async call was in flight, overwhelmingly a
   *  keystroke. Never silently applied and never silently dropped; the
   *  caller routes this through whatever consent flow fits its own
   *  context (see main.ts's reevaluateReload/reevaluateReopen, both
   *  reusing the existing discard-confirm dialog rather than inventing a
   *  new one). */
  | "edited";

/**
 * Validate a captured snapshot against the doc's state once the awaited
 * call resolves. `stillOpen` is the caller's own membership check (e.g.
 * `tabs.docs.includes(doc)`) — passed as a plain boolean, same as
 * chunkguard.ts's ChunkResponseContext.isActiveTab, so this module never
 * needs to import tabs.ts's Doc/Tabs shape to do its job. `current` is
 * ordinarily the very same object `captureIdentity` was called on — every
 * existing call site holds `doc` via closure across its own `await`,
 * never re-looks it up by id — so the `id`-mismatch branch is defense in
 * depth for a future caller that does re-derive it, not a path today's
 * call sites can actually exercise.
 */
export function validateIdentity(
  captured: GuardIdentity,
  current: GuardIdentity,
  stillOpen: boolean,
): GuardVerdict {
  if (!stillOpen || current.id !== captured.id) return "closed";
  if (current.revision !== captured.revision) return "edited";
  return "apply";
}
