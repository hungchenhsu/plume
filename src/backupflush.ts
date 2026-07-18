// Debounced hot-exit backup scheduling, pulled out of main.ts (which is
// wired directly into IPC/DOM/editor and isn't unit-testable on its own —
// see backup.ts's header comment) so the flush-on-tab-switch contract gets
// real vitest coverage.
//
// One debounce timer covers whatever document is active *when it fires*:
// schedule() is only ever called for edits to the active document, so the
// timer and the active tab normally agree. They can disagree after a tab
// switch inside the debounce window — the timer would fire seeing the
// *new* active document, and the previous document's last edits would
// never reach their backup, breaking hot exit's data promise for any
// abnormal termination (crash, kill, power loss) before the next flush of
// that document (issue #253). Every switch-away path must therefore call
// flushPending(previous, content) before the active tab changes; the
// window-close handler instead calls cancel() and does its own sweep over
// every dirty document.

/** The two Doc fields that decide whether a document needs backup cover:
 *  only a dirty, non-truncated document does (a truncated large-file
 *  preview is read-only and never has unsaved content). */
export interface BackupCoverable {
  dirty: boolean;
  truncated: boolean;
}

export interface BackupFlushScheduler<D extends BackupCoverable> {
  /** Debounce a backup of whatever document is active when the timer
   *  fires. Called on every save-relevant edit; restarts the window. */
  schedule(): void;
  /** Cancel the pending timer and flush `doc` with `content` right now if
   *  it needs cover — must run before the editor switches away from
   *  `doc`, while `content` still is that document's latest text. A
   *  no-op when no flush is pending: the last edit was already flushed. */
  flushPending(doc: D, content: string): void;
  /** Cancel any pending timer without flushing (the close handler sweeps
   *  every dirty document itself, so a concurrent debounced flush would
   *  only race it). */
  cancel(): void;
}

export function createBackupFlushScheduler<D extends BackupCoverable>(opts: {
  debounceMs: number;
  active: () => D | null;
  activeContent: () => string;
  flush: (doc: D, content: string) => Promise<unknown>;
}): BackupFlushScheduler<D> {
  let timer: number | null = null;
  const clear = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const needsCover = (doc: D | null): doc is D =>
    doc !== null && doc.dirty && !doc.truncated;
  return {
    schedule(): void {
      clear();
      timer = window.setTimeout(() => {
        timer = null;
        const doc = opts.active();
        if (needsCover(doc)) void opts.flush(doc, opts.activeContent());
      }, opts.debounceMs);
    },
    flushPending(doc: D, content: string): void {
      if (timer === null) return;
      clear();
      if (needsCover(doc)) void opts.flush(doc, content);
    },
    cancel: clear,
  };
}
