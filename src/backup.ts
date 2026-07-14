import { deleteBackup } from "./ipc";

// Hot-exit backup lifecycle: dropBackup deletes a document's backup file
// (if it has one) once its buffer no longer needs covering — an explicit
// save, closing a dirty tab, or (issue #115) reload-from-disk /
// reopen-with-encoding once either has replaced the buffer with on-disk
// content and discarded whatever the backup was covering. A backup an
// operation should have dropped but didn't becomes an orphan: the next
// launch's orphan recovery (main.ts's restoreSession) resurrects it as a
// spurious dirty tab, reviving content the user already discarded.
//
// Pulled out of main.ts, which is wired directly into IPC/DOM/editor and
// isn't unit-testable on its own (see savecompletion.ts's header comment),
// so this narrow but safety-critical step gets real vitest coverage
// instead — including the no-backup case, which must stay a silent no-op.

/** Minimal shape dropBackup needs — matches tabs.ts's Doc.backupName field
 *  without importing the whole (DOM-adjacent) Doc type. */
export interface HasBackup {
  backupName: string | null;
}

/**
 * Delete `doc`'s hot-exit backup file, if it has one, and forget its name.
 * Safe to call unconditionally, including when there is no backup (a
 * no-op) — every caller in main.ts relies on this so it doesn't need its
 * own dirty/backupName branch before calling it. Deletion failures are
 * swallowed: a stray backup file left behind after a failed delete is a
 * cheap, already-tolerated cost (see restoreSession's orphan-recovery
 * comment in main.ts), far cheaper than blocking the caller's own flow
 * (reload, reopen, tab close, save completion) on a best-effort disk
 * cleanup.
 */
export function dropBackup(doc: HasBackup): void {
  if (doc.backupName) {
    void deleteBackup(doc.backupName).catch(() => {});
    doc.backupName = null;
  }
}
