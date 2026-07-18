// Per-document hot-exit backup pipeline: every write to and delete of a
// document's backup file goes through one per-doc ordered queue, and the
// doc's `backupName` is committed only after a write has actually reached
// disk (issue #263). Replaces main.ts's former flushBackup/backupNameFor
// and backup.ts's dropBackup, whose independent fire-and-forget IPC calls
// had three failure modes:
//
// - `backupName` was assigned *before* the write's IPC round trip, and
//   `collectSession` reads it synchronously — a session written in the
//   gap (every tab switch persists) referenced a backup file that a crash
//   could prevent from ever existing. The next launch then silently fell
//   back to the on-disk file (dropping the unsaved edits the backup was
//   for) or, for an untitled tab, lost the tab entirely.
// - A failed write still left the name on the doc, with the same dangling
//   session reference.
// - Two overlapping IPC calls for the same name — a switch-away flush
//   racing the close sweep, or a slow write racing dropBackup's delete —
//   had no ordering: an older write landing last could overwrite newer
//   backup content, and a write landing after a delete resurrected the
//   file as an orphan (whose recovery then revives content the user
//   already discarded — see the orphan note below).
//
// Ordering alone can't fix drops: a queued-but-not-yet-run flush must not
// run at all once the backup it was meant to write is dropped (a save
// completed; the content no longer needs cover) — it would mint and
// commit a fresh backup file the delete never knew about. Each drop
// therefore bumps a per-doc epoch, and a flush checks its captured epoch
// both before writing and again between the write landing and the name
// commit (the drop may arrive mid-write; its queued delete then removes
// the just-written file right after).
//
// A backup an operation should have dropped but didn't becomes an orphan:
// the next launch's orphan recovery (main.ts's restoreSession) resurrects
// it as a spurious dirty tab, reviving content the user already
// discarded. Deletion failures are still swallowed (a stray file is a
// cheap, already-tolerated cost, far cheaper than blocking a close/reload
// on best-effort cleanup) — but deletion *ordering* is not best-effort,
// for the resurrection reason above.
//
// Pulled out of main.ts (wired into IPC/DOM/editor, not unit-testable —
// see backupflush.ts's header for the same split) so every one of these
// invariants gets real vitest coverage.

import { createOpQueue, type OpQueue } from "./opqueue";

/** The slice of tabs.ts's Doc this pipeline owns: `backupName` is the
 *  *committed* name — non-null only once some write of this doc's content
 *  has verifiably reached disk under that name. Session persistence
 *  (collectSession) may reference it at any moment. */
export interface BackupSlot {
  id: number;
  backupName: string | null;
}

export interface BackupPipeline {
  /**
   * Write `content` to the doc's backup file, serialized behind every
   * earlier write/delete for the same doc. Resolves true once the write
   * has landed and `backupName` is committed; false when the write failed
   * (the name stays uncommitted or keeps pointing at the last version
   * that did land — err on the keep-more side) or when a drop superseded
   * this flush while it waited or wrote. Never rejects.
   */
  flush(doc: BackupSlot, content: string): Promise<boolean>;
  /**
   * Discard the doc's backup: clears `backupName` synchronously (session
   * snapshots taken from here on no longer reference it), cancels any
   * queued-but-unrun flushes via the epoch bump, and queues the file
   * delete behind whatever write is still in flight.
   */
  drop(doc: BackupSlot): void;
  /** Release per-doc queue/reservation state once the doc is closed for
   *  good. Already-queued operations still settle; the doc can simply
   *  never enqueue again. */
  forget(id: number): void;
}

export function createBackupPipeline(io: {
  save: (name: string, content: string) => Promise<unknown>;
  remove: (name: string) => Promise<unknown>;
}): BackupPipeline {
  const queues = new Map<number, OpQueue>();
  /** Name minted for a doc's first-ever write, before it has succeeded —
   *  kept stable across retries so a doc never scatters backups across
   *  several differently-stamped files. */
  const reserved = new Map<number, string>();
  /** Bumped by every drop; a flush captured under an older epoch must
   *  not write (see the module header's drop-cancellation paragraph). */
  const epochs = new Map<number, number>();

  const queueFor = (id: number): OpQueue => {
    let queue = queues.get(id);
    if (!queue) {
      queue = createOpQueue();
      queues.set(id, queue);
    }
    return queue;
  };
  const epochOf = (id: number): number => epochs.get(id) ?? 0;

  return {
    flush(doc: BackupSlot, content: string): Promise<boolean> {
      const epoch = epochOf(doc.id);
      return queueFor(doc.id).enqueue(async () => {
        if (epochOf(doc.id) !== epoch) return false; // dropped while queued
        const name =
          doc.backupName ?? reserved.get(doc.id) ?? `bk-${doc.id}-${Date.now()}.txt`;
        if (doc.backupName === null) reserved.set(doc.id, name);
        try {
          await io.save(name, content);
        } catch {
          return false;
        }
        // A drop that arrived mid-write already bumped the epoch and
        // queued a delete right behind this op — leave the name
        // uncommitted so nothing ever references the file it removes.
        if (epochOf(doc.id) !== epoch) return false;
        doc.backupName = name;
        reserved.delete(doc.id);
        return true;
      });
    },

    drop(doc: BackupSlot): void {
      epochs.set(doc.id, epochOf(doc.id) + 1);
      const name = doc.backupName ?? reserved.get(doc.id) ?? null;
      doc.backupName = null;
      reserved.delete(doc.id);
      if (name !== null) {
        void queueFor(doc.id)
          .enqueue(() => io.remove(name))
          .catch(() => {
            // Swallowed by design — see the orphan note in the header.
          });
      }
    },

    forget(id: number): void {
      queues.delete(id);
      reserved.delete(id);
      epochs.delete(id);
    },
  };
}
