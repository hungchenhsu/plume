// ROADMAP.md v0.7 Track V "external delete/rename visibility": distinguishes
// a confirmed on-disk deletion from every other transient reload failure
// (a mid-replace window, a permission hiccup, ...) once a reload's own
// openDocument fetch has already rejected — see main.ts's
// fetchAndApplyReload/reevaluateReload, whose catch blocks previously
// swallowed every one of these identically, leaving a clean doc's tab with
// zero UI signal even when the file was genuinely gone. Pulled out for the
// same reason asyncguard.ts/backupflush.ts were: main.ts is wired directly
// into IPC/DOM/editor and isn't unit-testable on its own — this is what's
// actually under direct test, via a mocked "./ipc" (see
// missingondisk.test.ts).
import { documentMetadata } from "./ipc";

/**
 * Re-checks `path` via documentMetadata (a plain `std::fs::metadata` read,
 * src-tauri/src/docinfo.rs) once an attempted reload's own openDocument
 * call has already rejected. documentMetadata rejects the exact same way
 * openDocument's own read does when the file genuinely no longer exists
 * (both bottom out in a failed `std::fs` call), and resolves whenever the
 * path is still statable — the strongest same-process existence signal
 * available without a bespoke IPC command of its own.
 *
 * Deliberately reactive only: call this from inside an existing
 * openDocument-failure catch, never speculatively before a reload is even
 * attempted — an ordinary reload (the overwhelming majority, which never
 * fails) must never pay for a second IPC round trip it doesn't need.
 *
 * A metadata success doesn't positively rule out every other transient
 * cause (e.g. a permissions error unrelated to existence) — it only rules
 * out "the file is gone", which is all the caller's own conservative
 * "leave the buffer as-is" fallback ever needs in order to keep doing
 * exactly that for anything short of a confirmed deletion.
 */
export async function isConfirmedMissing(path: string): Promise<boolean> {
  try {
    await documentMetadata(path);
    return false;
  } catch {
    return true;
  }
}
