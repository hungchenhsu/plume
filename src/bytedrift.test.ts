import { describe, expect, it, vi } from "vitest";
import {
  runByteDriftGate,
  shouldCheckByteDrift,
  shouldPromptByteDrift,
  type ByteDriftCheckResult,
} from "./bytedrift";

const clean: ByteDriftCheckResult = { drift: false, skipped: false, reason: null };
const drifted: ByteDriftCheckResult = { drift: true, skipped: false, reason: null };
const skippedButFlaggedDrift: ByteDriftCheckResult = {
  drift: true,
  skipped: true,
  reason: "mixed-line-ending",
};
const skippedClean: ByteDriftCheckResult = { drift: false, skipped: true, reason: "unicode-encoding" };

describe("shouldCheckByteDrift", () => {
  it("not yet checked this session: runs the check", () => {
    expect(shouldCheckByteDrift({ alreadyChecked: false })).toBe(true);
  });

  it("already checked this session: does not run it again", () => {
    expect(shouldCheckByteDrift({ alreadyChecked: true })).toBe(false);
  });
});

describe("shouldPromptByteDrift — full branch table", () => {
  it("drift, not skipped: prompts", () => {
    expect(shouldPromptByteDrift(drifted)).toBe(true);
  });

  it("no drift, not skipped: no prompt", () => {
    expect(shouldPromptByteDrift(clean)).toBe(false);
  });

  it("skipped wins even if drift is (contract-violating) true: no prompt", () => {
    expect(shouldPromptByteDrift(skippedButFlaggedDrift)).toBe(false);
  });

  it("skipped, no drift: no prompt", () => {
    expect(shouldPromptByteDrift(skippedClean)).toBe(false);
  });
});

// runByteDriftGate takes its IPC call and confirm dialog as injected
// callbacks (see bytedrift.ts's module doc) rather than importing ipc.ts/
// the native confirm() plugin directly, so this whole call/skip/cancel/
// proceed sequence — the same stand-in technique savemutex.test.ts's
// harness uses for issue #124, scaled down to this feature's actual shape
// (one sequential gate, no concurrency) — is testable with plain vi.fn()
// mocks and no module mocking.
describe("runByteDriftGate", () => {
  it("first save this session: calls checkByteDrift once and marks the doc checked", async () => {
    const doc = { byteDriftChecked: false };
    const checkByteDrift = vi.fn().mockResolvedValue(clean);
    const confirmDialog = vi.fn().mockResolvedValue(true);

    const proceed = await runByteDriftGate(doc, checkByteDrift, confirmDialog);

    expect(proceed).toBe(true);
    expect(checkByteDrift).toHaveBeenCalledTimes(1);
    expect(doc.byteDriftChecked).toBe(true);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("second save this session: does not call checkByteDrift again", async () => {
    const doc = { byteDriftChecked: true };
    const checkByteDrift = vi.fn().mockResolvedValue(drifted);
    const confirmDialog = vi.fn().mockResolvedValue(false);

    const proceed = await runByteDriftGate(doc, checkByteDrift, confirmDialog);

    expect(proceed).toBe(true);
    expect(checkByteDrift).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("drift found, user cancels: aborts the save", async () => {
    const doc = { byteDriftChecked: false };
    const checkByteDrift = vi.fn().mockResolvedValue(drifted);
    const confirmDialog = vi.fn().mockResolvedValue(false);

    const proceed = await runByteDriftGate(doc, checkByteDrift, confirmDialog);

    expect(proceed).toBe(false);
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    // The doc is still marked checked even though the save was cancelled —
    // this was still the one-time ask, and re-asking on the user's very
    // next retry would defeat the point of a *one-time* dialog.
    expect(doc.byteDriftChecked).toBe(true);
  });

  it("drift found, user proceeds: allows the save", async () => {
    const doc = { byteDriftChecked: false };
    const checkByteDrift = vi.fn().mockResolvedValue(drifted);
    const confirmDialog = vi.fn().mockResolvedValue(true);

    const proceed = await runByteDriftGate(doc, checkByteDrift, confirmDialog);

    expect(proceed).toBe(true);
    expect(confirmDialog).toHaveBeenCalledTimes(1);
  });

  it("skipped: never shows the dialog, regardless of the drift flag", async () => {
    const doc = { byteDriftChecked: false };
    const checkByteDrift = vi.fn().mockResolvedValue(skippedButFlaggedDrift);
    const confirmDialog = vi.fn().mockResolvedValue(false);

    const proceed = await runByteDriftGate(doc, checkByteDrift, confirmDialog);

    expect(proceed).toBe(true);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  // P3 critic finding: the one-per-session flag must only be spent on a
  // check that actually ran — a transient IPC failure (e.g. the file
  // briefly locked) fails open for THIS save but leaves the flag unset, so
  // the next save retries the check instead of never asking again this
  // session.
  it("checkByteDrift rejects: fails open without spending the one-time flag", async () => {
    const doc = { byteDriftChecked: false };
    const checkByteDrift = vi.fn().mockRejectedValue(new Error("file busy"));
    const confirmDialog = vi.fn().mockResolvedValue(false);

    const proceed = await runByteDriftGate(doc, checkByteDrift, confirmDialog);

    expect(proceed).toBe(true);
    expect(doc.byteDriftChecked).toBe(false);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("a failed check is retried on the next save; a successful one is not", async () => {
    const doc = { byteDriftChecked: false };
    const checkByteDrift = vi
      .fn()
      .mockRejectedValueOnce(new Error("file busy"))
      .mockResolvedValueOnce(clean);
    const confirmDialog = vi.fn().mockResolvedValue(false);

    expect(await runByteDriftGate(doc, checkByteDrift, confirmDialog)).toBe(true);
    expect(doc.byteDriftChecked).toBe(false);

    // Next save: the flag is still unset, so the check runs again — and
    // this time it succeeds, spending the flag for the rest of the session.
    expect(await runByteDriftGate(doc, checkByteDrift, confirmDialog)).toBe(true);
    expect(checkByteDrift).toHaveBeenCalledTimes(2);
    expect(doc.byteDriftChecked).toBe(true);

    // Third save: checked, no further calls.
    expect(await runByteDriftGate(doc, checkByteDrift, confirmDialog)).toBe(true);
    expect(checkByteDrift).toHaveBeenCalledTimes(2);
  });
});
