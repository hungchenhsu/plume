import { describe, expect, it, vi } from "vitest";

const deleteBackup = vi.fn();
vi.mock("./ipc", () => ({
  deleteBackup: (...args: unknown[]) =>
    (deleteBackup as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc is already mocked by the time ./backup is evaluated — same pattern
// as batchconvert.test.ts / theme.test.ts.
import { dropBackup } from "./backup";

// Issue #115: reloadFromDisk and reopenWithEncoding (main.ts) both replace
// a doc's buffer with on-disk content and discard whatever it held before,
// but neither called dropBackup afterward — the stale hot-exit backup was
// left on disk and the next launch's orphan recovery resurrected it as a
// spurious dirty tab, reviving content the user had just explicitly
// discarded. main.ts itself is wired directly into IPC/DOM/editor and isn't
// unit-testable (see savecompletion.ts's header comment), so dropBackup —
// the exact step both call sites were missing — is pulled out here to get
// real coverage instead.
describe("dropBackup (issue #115 — reload/reopen backup cleanup)", () => {
  it("deletes the backup file and clears backupName when one exists", () => {
    deleteBackup.mockReset().mockResolvedValue(undefined);
    const doc = { backupName: "bk-1-123.txt" };

    dropBackup(doc);

    expect(deleteBackup).toHaveBeenCalledWith("bk-1-123.txt");
    expect(doc.backupName).toBeNull();
  });

  it("control group: no backup is a silent no-op — never calls deleteBackup", () => {
    deleteBackup.mockReset();
    const doc = { backupName: null };

    dropBackup(doc);

    expect(deleteBackup).not.toHaveBeenCalled();
    expect(doc.backupName).toBeNull();
  });

  it("still clears backupName even when the delete rejects (best-effort cleanup)", async () => {
    deleteBackup.mockReset().mockRejectedValue(new Error("disk full"));
    const doc = { backupName: "bk-2-456.txt" };

    dropBackup(doc);

    // Cleared synchronously — hot exit must stop treating this doc as
    // covered by that backup regardless of whether the delete IPC call
    // eventually succeeds.
    expect(doc.backupName).toBeNull();
    // Let the swallowed rejection's microtask settle so it can't leak as an
    // unhandled rejection into a later test.
    await Promise.resolve();
    await Promise.resolve();
  });
});
