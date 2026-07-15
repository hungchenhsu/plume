/** Most-recently-closed-tabs stack behind File > Reopen Closed Tab
 *  (ROADMAP.md v0.5 Track C). Session-local and memory-only, deliberately
 *  never persisted: session restore already reopens the tabs that were
 *  open at exit, so persisting this list too would resurrect tabs the
 *  user closed on purpose.
 *
 *  Pulled out of main.ts (which is wired directly into IPC/DOM/editor and
 *  isn't unit-testable on its own — the backup.ts precedent) so the
 *  push/pop/untitled-exclusion/cap semantics get real vitest coverage;
 *  module-level singleton plus thin wrapper functions mirror
 *  searchhistory.ts, minus its storage layer.
 */

/** What a reopen needs: the file path plus the cursor as a character
 *  offset — the same value collectSession persists in SessionFile.cursor,
 *  restored through the same clamped `newBuffer` path (editor.ts), so a
 *  file shrunk on disk since the close can't put the selection out of
 *  range. */
export interface ClosedTabEntry {
  path: string;
  cursor: number;
}

/** Stack depth cap; the oldest entry is dropped beyond it. Reopening is a
 *  recency gesture — nobody digs 20 closes deep — so a small bound keeps
 *  an all-day session from growing the stack without limit. */
export const MAX_CLOSED_TABS = 20;

export class ClosedTabsStack {
  private entries: ClosedTabEntry[] = [];

  /** Record a just-closed tab as the most recent reopen candidate.
   *
   *  Untitled tabs (`path === null`) are excluded here rather than at the
   *  call site so the rule is unit-tested: with no path there is nothing
   *  a reopen could open — by the time an untitled tab's close goes
   *  through, the user has either confirmed discarding its content or
   *  saved it to a real path (which set `doc.path`, so that close records
   *  the new path).
   *
   *  Re-closing a path that's already stacked replaces the older entry
   *  (most-recent-wins, the searchhistory.ts MRU precedent): a reopen
   *  never pops a stale duplicate of a file whose newer entry was already
   *  consumed — openPath would just focus the already-open tab, wasting
   *  the keystroke. */
  push(path: string | null, cursor: number): void {
    if (path === null) return;
    this.entries = this.entries.filter((e) => e.path !== path);
    this.entries.push({ path, cursor });
    if (this.entries.length > MAX_CLOSED_TABS) this.entries.shift();
  }

  /** Remove and return the most recently closed entry, or `null` when
   *  nothing is left. Popping consumes the entry unconditionally: if the
   *  file turns out to be gone from disk, the caller reports the open
   *  error and stops — the next reopen moves on to the previous entry
   *  instead of retrying a path that just failed. */
  pop(): ClosedTabEntry | null {
    return this.entries.pop() ?? null;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }
}

const closedTabs = new ClosedTabsStack();

/** Record `path`/`cursor` for a tab that is definitely closing (call only
 *  after the close-confirm flow has resolved — a cancelled close must not
 *  record anything). No-op for untitled tabs (`path === null`). */
export function recordClosedTab(path: string | null, cursor: number): void {
  closedTabs.push(path, cursor);
}

/** Consume and return the most recently closed tab, or `null`. */
export function popClosedTab(): ClosedTabEntry | null {
  return closedTabs.pop();
}

/** Whether File > Reopen Closed Tab has anything to reopen — drives the
 *  menu item's enabled state (main.ts's `syncReopenClosedTabState`). */
export function hasClosedTabs(): boolean {
  return !closedTabs.isEmpty();
}
