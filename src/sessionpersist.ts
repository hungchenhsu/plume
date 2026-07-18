// Serializes on-disk session writes. Pulled out of main.ts (which is wired
// directly into IPC/DOM/editor and isn't unit-testable on its own — see
// backupflush.ts's header comment for the same reasoning) purely so the
// ordering/freeze contract below gets real vitest coverage; collectSession
// itself (the tabs/editor-coupled snapshot builder) stays in main.ts and is
// only ever passed in here as `collect`.
//
// Same race recentOps closes for recent.json (opqueue.ts's header, issue
// #252), here for session.json (ROADMAP.md v0.7 Track R, following PR
// #270's pattern): saveSession's IPC calls can resolve out of order, so a
// write from an earlier mutation finishing after a later one's write would
// overwrite session.json with a stale snapshot. Two things close it:
//   1. every write goes through one queue, so writes land on disk in
//      enqueue order regardless of which IPC response comes back first
//      (createOpQueue's own guarantee — see opqueue.ts);
//   2. `collect()` runs synchronously inside `persist()`, at enqueue time —
//      not inside the queued closure, which would instead read app state
//      whenever the queue gets around to running it. Session state is live
//      and mutable (tabs/editor), so a deferred read would hand a queued
//      write whatever the app looks like *then*, not what it looked like
//      when persist() was actually called (mirrors prefsOps's
//      structuredClone(current) in preferences.ts — same freeze
//      requirement, different capture mechanism since collectSession()
//      already allocates a fresh, decoupled object on every call).

import { createOpQueue } from "./opqueue";

export interface SessionPersister {
  /** Snapshot now (via `collect`), then enqueue its persistence behind
   *  every previously enqueued write; returns the write's own promise.
   *  Most callers fire-and-forget it (main.ts's persistSession); the
   *  window-close handler instead awaits it to know the final write has
   *  landed before quitting. */
  persist(): Promise<void>;
}

export function createSessionPersister<T>(opts: {
  collect: () => T;
  save: (session: T) => Promise<void>;
}): SessionPersister {
  const queue = createOpQueue();
  return {
    persist(): Promise<void> {
      const snapshot = opts.collect();
      return queue.enqueue(() => opts.save(snapshot));
    },
  };
}
