// Save-completion policy (issue #112): a document can keep changing while
// its IPC save round trip is in flight (including the lossy-encoding
// confirm and stale-overwrite force retries in main.ts's saveFlow), so the
// completion handler must not blindly trust a successful write to mean
// "the buffer the user sees right now is on disk". Pulled out as a pure
// function — main.ts's saveFlow is wired directly into the DOM/editor/IPC
// and isn't unit-testable on its own (see chunkpolicy.ts/mojibake.ts's
// isMojibakeSnapshotStale for the same pattern) — so the decision table
// itself gets full-branch vitest coverage instead.

export interface SaveCompletionInput {
  /** Whether this save attempt's bytes actually reached disk. */
  written: boolean;
  /** Whether the backend reported the on-disk fingerprint no longer
   *  matched `expectedFingerprint` (issue #113). Contractually this is
   *  always false when `written` is true (see ipc.ts SaveResult) — carried
   *  here anyway so a caller that violates that contract fails closed
   *  instead of this function silently trusting `written` alone. */
  stale: boolean;
  /** doc.revision captured at the moment saveFlow read editor.content(),
   *  before any IPC round trip (including retries — a lossy-confirm or
   *  stale-overwrite retry re-sends the same content snapshot, so it
   *  reuses this same value rather than re-reading it). */
  revisionAtStart: number;
  /** doc.revision as of right now, i.e. once the save's IPC promise (or
   *  its last retry) has resolved. */
  currentRevision: number;
  /** Whether doc.path changed since the flow started (a concurrent flow —
   *  e.g. an overlapping Save As — moved the doc to a different path).
   *  Not the ordinary Save As of *this* flow, which reassigns doc.path
   *  unconditionally regardless of this decision. */
  pathChanged: boolean;
}

export interface SaveCompletionDecision {
  /** Clear doc.dirty — safe only when nothing new landed since the
   *  content snapshot this save actually wrote. */
  clearDirty: boolean;
  /** Delete the hot-exit backup — must stay false whenever clearDirty is
   *  false, so the backup cycle keeps covering unsaved edits. */
  dropBackup: boolean;
  /** Update doc.fingerprint to the backend's post-write value. Unconditional
   *  whenever written: disk now holds exactly what this call wrote, so the
   *  next save's staleness check (issue #113) needs this as its baseline
   *  regardless of whether the edit happened concurrently. */
  updateFingerprint: boolean;
}

/**
 * Decide what a successful (or not) save IPC round trip is allowed to do to
 * the tab's dirty/backup/fingerprint state. Revision and path are compared
 * as of "now" (after the await) against the snapshot taken before the IPC
 * call; a mismatch means the user kept editing (or a concurrent flow moved
 * the doc) while bytes were in flight, so the *new* content is still only
 * in the editor buffer, not on disk — dirty and the backup must survive so
 * hot exit keeps covering it. Nothing auto-retries and nothing prompts
 * here; the next explicit Save naturally writes the newer content.
 */
export function decideSaveCompletion(
  input: SaveCompletionInput,
): SaveCompletionDecision {
  if (!input.written || input.stale) {
    return { clearDirty: false, dropBackup: false, updateFingerprint: false };
  }
  const revisionMatches =
    input.revisionAtStart === input.currentRevision && !input.pathChanged;
  return {
    clearDirty: revisionMatches,
    dropBackup: revisionMatches,
    updateFingerprint: true,
  };
}
