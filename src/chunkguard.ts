// Generation guard for large-file chunk IPC responses (issue #120).
//
// pageChunk (Next/Prev), autoAppendChunk/prependChunk (continuous reading),
// and gotoLargeFileLine (Go to Line / bookmark jump, via ensureLineIndex)
// each fire one or more async read_document_chunk(_before)/
// locate_line_offset/build_line_index IPC calls and, once they resolve,
// mutate the doc's chunk-window state (offsets, buffer content, line
// index) and the visible editor. These calls race arbitrarily — a second
// Next click, a goto-line jump, a bookmark jump, or a reload/reopen can
// all be issued before an earlier one's response lands. Before this fix,
// main.ts validated at most "is this doc's tab still active"
// (append/prepend only; pageChunk and gotoLargeFileLine checked nothing at
// all), which doesn't catch two overlapping requests for the *same*
// still-active doc (rapid Next/Next, or Next racing a goto/reload).
//
// Modeled on batchconvert.ts's scanGeneration (issue #95/#103 — see
// invalidateScan/runScan there): every chunk-mutating call bumps the doc's
// own monotonic `chunkGeneration` counter (tabs.ts Doc.chunkGeneration)
// before making its IPC call(s) and captures the post-bump value as its
// own generation. reloadFromDisk/reopenWithEncoding bump it too, even
// though they have no chunk response of their own to gate here, purely to
// invalidate whatever chunk request might still be in flight once they
// reset the doc's chunk-window state from scratch.
//
// A response is only applied if the doc's generation hasn't moved on
// *and* the doc is still the active tab. Unlike mojibake.ts's two
// independently-checked guards (content-drift and active-tab, evaluated
// separately because isMojibakeSnapshotStale predates the tab check),
// every call site here needs both conditions at once, so they're bundled
// into a single decision rather than split across two checks.
//
// issue #134: sharing one per-doc chunkLoadInFlight guard across all five
// call sites had a side effect — a user-initiated jump (pageChunk Next/
// Prev, gotoLargeFileLine via Go to Line or a bookmark jump) that arrived
// while an auto append/prepend was still in flight used to hit
// `if (doc.chunkLoadInFlight) return;` and silently no-op, forcing a
// retry. preemptChunkLoad below lets those call sites preempt instead of
// blocking: bump the generation and clear the flag right before starting
// their own request, exactly like reloadFromDisk/reopenWithEncoding
// already do, so whatever was in flight discards its own response via
// shouldApplyChunkResponse once it resolves. Auto append/prepend
// deliberately never call it — they still yield to an in-flight load
// (chunkpolicy.ts's canAutoAppend/canPrepend, unchanged) — so only
// user-initiated requests preempt, including one user-initiated request
// preempting another (rapid Next/Next): safe because the loser's response
// is a generation-guarded discard, not the pre-#120 stale-overwrite race.

export interface ChunkResponseContext {
  /** This request's own generation, captured right after the bump that
   *  preceded its IPC call(s). */
  requestGeneration: number;
  /** doc.chunkGeneration as of right now (after the await) — bumped by any
   *  newer chunk request for this doc, or by a reload/reopen, issued since
   *  this request started. */
  currentGeneration: number;
  /** tabs.activeId === doc.id as of right now. */
  isActiveTab: boolean;
}

/** Whether a chunk IPC response is still current and safe to apply — i.e.
 *  mutate the doc's chunk-window state and/or the visible editor. False
 *  means: discard outright — no state mutation, no status-bar update, no
 *  error dialog for a failed response either. */
export function shouldApplyChunkResponse(context: ChunkResponseContext): boolean {
  return context.requestGeneration === context.currentGeneration && context.isActiveTab;
}

/** Slice of tabs.ts's Doc that preemptChunkLoad reads/writes. */
export interface ChunkLoadState {
  chunkGeneration: number;
  chunkLoadInFlight: boolean;
}

/**
 * Preempt whatever chunk request is currently in flight for a doc, so a
 * user-initiated jump (pageChunk Next/Prev, gotoLargeFileLine — including
 * a bookmark jump via jumpToBookmark) never silently no-ops just because
 * a background continuous-reading auto append/prepend — or another
 * still-in-flight user-initiated jump — got there first (issue #134).
 *
 * Mirrors reloadFromDisk/reopenWithEncoding's existing approach: bump the
 * generation and clear the in-flight flag, so whatever was in flight
 * discards its own response via `shouldApplyChunkResponse` once it
 * resolves, instead of either blocking this new request or racing to
 * clobber it. The caller is expected to immediately follow this with the
 * same generation-bump-and-set-flag pair every chunk-mutating call site
 * already runs unconditionally before issuing its own IPC call — this
 * only invalidates what came before.
 *
 * Auto append/prepend deliberately never call this: they yield to an
 * in-flight load instead of preempting it (see chunkpolicy.ts's
 * canAutoAppend/canPrepend) — only user-initiated requests preempt.
 */
export function preemptChunkLoad(state: ChunkLoadState): void {
  state.chunkLoadInFlight = false;
  state.chunkGeneration += 1;
}
