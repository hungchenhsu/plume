import { afterEach, describe, expect, it, vi } from "vitest";

const documentMetadata = vi.fn();
// vi.mock calls are hoisted above the static imports by vitest, so ./ipc
// is already mocked by the time ./missingondisk is evaluated — same
// pattern as docinfo.test.ts.
vi.mock("./ipc", () => ({
  documentMetadata: (...a: unknown[]) =>
    (documentMetadata as (...x: unknown[]) => unknown)(...a),
}));

import { isConfirmedMissing } from "./missingondisk";

afterEach(() => {
  documentMetadata.mockReset();
});

describe("isConfirmedMissing", () => {
  it("resolves true when documentMetadata also rejects — the file is confirmed gone, not just an open failure", async () => {
    documentMetadata.mockRejectedValue(new Error("Failed to read /doc.txt: No such file or directory"));
    await expect(isConfirmedMissing("/doc.txt")).resolves.toBe(true);
  });

  it("resolves false when documentMetadata resolves — the path is still statable, so the open failure was something else transient", async () => {
    documentMetadata.mockResolvedValue({ size: 10, modifiedMs: 0 });
    await expect(isConfirmedMissing("/doc.txt")).resolves.toBe(false);
  });

  it("re-checks the exact same path it was given — not a hardcoded or recomputed one", async () => {
    documentMetadata.mockResolvedValue({ size: 10, modifiedMs: 0 });
    await isConfirmedMissing("/some/other/path.txt");
    expect(documentMetadata).toHaveBeenCalledWith("/some/other/path.txt");
    expect(documentMetadata).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// main.ts-shaped simulation for the doc.missingOnDisk flag's full lifecycle
// (ROADMAP.md v0.7 Track V "external delete/rename visibility"). Same
// technique as asyncguard.test.ts/savemutex.test.ts (main.ts itself has no
// *.test.ts — see savecompletion.ts's header comment): mirrors
// fetchAndApplyReload/markMissingIfConfirmed/applyOpenedForReload/
// runSaveFlow's own shape closely enough to reproduce each scenario, wired
// to the real isConfirmedMissing (this module, itself backed by the mocked
// "./ipc" above) rather than reimplementing its own reject/resolve logic
// independently. Only the trivial surrounding glue (which field to flip,
// when to call the status-bar stand-in) is mirrored directly, matching what
// main.ts's own markMissingIfConfirmed/applyOpenedForReload/runSaveFlow
// actually do.

interface DocState {
  id: number;
  path: string;
  missingOnDisk?: boolean;
}

interface Harness {
  /** Mirrors tabs.docs — membership is "still open". */
  tabs: DocState[];
  activeId: number | null;
  /** Mirrors main.ts's updateStatusBar(doc) calls — a plain observation
   *  log, not a real DOM render (see statusbar.ts's own module-level DOM
   *  queries, which this test deliberately never imports). */
  statusBarCalls: DocState[];
}

function makeHarness(doc: DocState, activeId: number | null = doc.id): Harness {
  return { tabs: [doc], activeId, statusBarCalls: [] };
}

/** Mirrors main.ts's markMissingIfConfirmed exactly: reactive
 *  documentMetadata re-check once a reload's own openDocument fetch has
 *  already rejected, gated on the doc still being open, with a status-bar
 *  refresh only when it's the active tab. */
async function markMissingIfConfirmedSim(
  h: Harness,
  doc: DocState,
  path: string,
): Promise<void> {
  const missing = await isConfirmedMissing(path);
  if (!missing || !h.tabs.includes(doc)) return;
  doc.missingOnDisk = true;
  if (h.activeId === doc.id) h.statusBarCalls.push(doc);
}

/** Mirrors fetchAndApplyReload's own try/catch shape: a successful
 *  openDocument clears a stale missing flag (applyOpenedForReload's own
 *  unconditional reset — the file obviously exists, since it was just
 *  read), a rejection routes into markMissingIfConfirmedSim instead of a
 *  bare swallow. */
async function attemptReloadSim(
  h: Harness,
  doc: DocState,
  openDocument: () => Promise<unknown>,
): Promise<void> {
  try {
    await openDocument();
    doc.missingOnDisk = false;
  } catch {
    await markMissingIfConfirmedSim(h, doc, doc.path);
  }
}

/** Mirrors runSaveFlow's own success-path clear: `written: true`
 *  unconditionally means the file exists on disk right now, regardless of
 *  the separate revisionMatches/dirty gate decideSaveCompletion applies. */
function applySaveSuccessSim(doc: DocState): void {
  doc.missingOnDisk = false;
}

/** A promise plus its resolve/reject, exposed for manual settlement — same
 *  shape as asyncguard.test.ts's own `deferred` helper, used here to land
 *  a tab close inside markMissingIfConfirmedSim's own documentMetadata
 *  await. */
interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

describe("missingOnDisk flag lifecycle", () => {
  it("(a) openDocument reject + documentMetadata reject: confirms missing, sets the flag, and refreshes the status bar (active tab)", async () => {
    documentMetadata.mockRejectedValue(new Error("ENOENT"));
    const doc: DocState = { id: 1, path: "/doc.txt" };
    const h = makeHarness(doc);

    await attemptReloadSim(h, doc, () => Promise.reject(new Error("open failed")));

    expect(doc.missingOnDisk).toBe(true);
    expect(h.statusBarCalls).toEqual([doc]);
  });

  it("(b) openDocument reject + documentMetadata resolve: today's conservative behavior is preserved — no flag, no status-bar refresh", async () => {
    documentMetadata.mockResolvedValue({ size: 10, modifiedMs: 0 });
    const doc: DocState = { id: 1, path: "/doc.txt" };
    const h = makeHarness(doc);

    await attemptReloadSim(h, doc, () => Promise.reject(new Error("open failed")));

    expect(doc.missingOnDisk).toBeUndefined();
    expect(h.statusBarCalls).toEqual([]);
  });

  it("(c) missing, then a save succeeds: the flag clears", () => {
    const doc: DocState = { id: 1, path: "/doc.txt", missingOnDisk: true };

    applySaveSuccessSim(doc);

    expect(doc.missingOnDisk).toBe(false);
  });

  it("(d) missing, then the file comes back (a later reload attempt's openDocument succeeds): the flag clears", async () => {
    const doc: DocState = { id: 1, path: "/doc.txt", missingOnDisk: true };
    const h = makeHarness(doc);

    await attemptReloadSim(h, doc, () => Promise.resolve({ content: "it's back" }));

    expect(doc.missingOnDisk).toBe(false);
  });

  it("(e) the tab closes while the documentMetadata re-check is still in flight: the detached doc is never mutated and no status-bar refresh fires", async () => {
    const metadataCall = deferred<{ size: number; modifiedMs: number }>();
    documentMetadata.mockReturnValue(metadataCall.promise);
    const doc: DocState = { id: 1, path: "/doc.txt" };
    const h = makeHarness(doc);

    const attempt = attemptReloadSim(h, doc, () => Promise.reject(new Error("open failed")));
    // Let the catch branch reach and call documentMetadata (a real IPC
    // round trip normally has an await gap here; a manual microtask flush
    // reproduces that same gap deterministically without a real timer).
    await Promise.resolve();
    await Promise.resolve();

    h.tabs.length = 0; // tab closed mid-flight, during the metadata re-check
    metadataCall.reject(new Error("ENOENT")); // confirms missing, too late to matter
    await attempt;

    expect(doc.missingOnDisk).toBeUndefined();
    expect(h.statusBarCalls).toEqual([]);
  });

  it("(f) confirmed missing on a background (non-active) tab: the flag still sets, but the status bar is not refreshed for a tab that isn't showing", async () => {
    documentMetadata.mockRejectedValue(new Error("ENOENT"));
    const doc: DocState = { id: 1, path: "/doc.txt" };
    const otherActiveDoc: DocState = { id: 2, path: "/other.txt" };
    const h = makeHarness(doc, otherActiveDoc.id);
    h.tabs.push(otherActiveDoc);

    await attemptReloadSim(h, doc, () => Promise.reject(new Error("open failed")));

    expect(doc.missingOnDisk).toBe(true);
    expect(h.statusBarCalls).toEqual([]);
  });
});
