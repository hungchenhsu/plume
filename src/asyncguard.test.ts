import { describe, expect, it } from "vitest";
import { fingerprintsEqual, mustDefer, type LockOwner } from "./savemutex";
import { captureIdentity, validateIdentity, type GuardIdentity } from "./asyncguard";

describe("captureIdentity", () => {
  it("copies id and revision as of the call", () => {
    const doc = { id: 7, revision: 42 };
    expect(captureIdentity(doc)).toEqual({ id: 7, revision: 42 });
  });

  it("returns an independent snapshot — mutating doc afterward doesn't change it", () => {
    const doc = { id: 7, revision: 42 };
    const snapshot = captureIdentity(doc);
    doc.revision = 43;
    expect(snapshot.revision).toBe(42);
  });
});

describe("validateIdentity — full branch table", () => {
  const captured: GuardIdentity = { id: 1, revision: 5 };

  it("apply: same doc, same revision, still open", () => {
    expect(validateIdentity(captured, { id: 1, revision: 5 }, true)).toBe("apply");
  });

  it("closed: stillOpen is false, regardless of id/revision match", () => {
    expect(validateIdentity(captured, { id: 1, revision: 5 }, false)).toBe("closed");
  });

  it("closed: id no longer matches (defensive — a caller re-deriving `current` from a fresh lookup instead of the captured object)", () => {
    expect(validateIdentity(captured, { id: 2, revision: 5 }, true)).toBe("closed");
  });

  it("edited: still open, same id, but revision moved", () => {
    expect(validateIdentity(captured, { id: 1, revision: 6 }, true)).toBe("edited");
  });

  it("closed takes priority over edited when both conditions independently hold", () => {
    expect(validateIdentity(captured, { id: 2, revision: 999 }, false)).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// main.ts-shaped simulation for reloadFromDisk/reopenWithEncoding's own
// IPC-await guard (issue #159) and reopenWithEncoding's entry into the
// save/reload lock (issue #169). Same technique as savemutex.test.ts
// (issue #124) and chunkguard.test.ts (issue #120): main.ts itself has no
// *.test.ts (see savecompletion.ts's header comment) — this harness
// mirrors its planned control flow closely enough to reproduce each
// race, wired to the real captureIdentity/validateIdentity (this module)
// and the real mustDefer/fingerprintsEqual (savemutex.ts) rather than
// reimplementing their logic independently. The save/reload *mutex*
// interplay itself (drainLock, pendingReload, double-save coalescing) is
// already exhaustively covered by savemutex.test.ts; this harness only
// adds the minimum save stand-in needed for issue #169's
// reopen-vs-save-in-flight scenario, and otherwise isolates the identity
// guard these two flows gained.

interface DocState {
  id: number;
  path: string;
  revision: number;
  dirty: boolean;
  backupName: string | null;
  fingerprint: unknown;
  buffer: string;
  encoding: string;
  saveReloadInFlight: LockOwner;
}

interface OpenedFixture {
  content: string;
  fingerprint: unknown;
  encoding: string;
}

function makeDocState(overrides: Partial<DocState> = {}): DocState {
  return {
    id: 1,
    path: "/doc.txt",
    revision: 0,
    dirty: false,
    backupName: null,
    fingerprint: "fp-0",
    buffer: "original",
    encoding: "UTF-8",
    saveReloadInFlight: null,
    ...overrides,
  };
}

/** Mirrors backup.ts's dropBackup for this simulation — same
 *  observable-only stand-in savemutex.test.ts already uses. */
function dropBackupSim(doc: DocState): void {
  doc.backupName = null;
}

/** Mirrors applyOpenedForReload/applyOpenedForReopen's shared shape:
 *  unconditional state replacement once something upstream has already
 *  decided it's safe to apply. */
function applyOpened(doc: DocState, opened: OpenedFixture): void {
  doc.dirty = false;
  dropBackupSim(doc);
  doc.revision += 1;
  doc.fingerprint = opened.fingerprint;
  doc.buffer = opened.content;
  doc.encoding = opened.encoding;
}

async function withLock(
  doc: DocState,
  owner: Exclude<LockOwner, null>,
  body: () => Promise<void>,
): Promise<void> {
  doc.saveReloadInFlight = owner;
  try {
    await body();
  } finally {
    doc.saveReloadInFlight = null;
  }
}

/** Hooks a test injects to observe/drive the shared discard-confirm
 *  dialog — defaults throw so a test that reaches it without expecting to
 *  fails loudly instead of silently resolving one way or the other (same
 *  convention as savemutex.test.ts's HarnessOptions.confirmReload). */
interface DialogHooks {
  confirmDiscard?: () => Promise<boolean>;
}

function createHarness(doc: DocState, hooks: DialogHooks = {}) {
  const tabs: DocState[] = [doc];
  const confirmDiscard =
    hooks.confirmDiscard ??
    (() => {
      throw new Error(
        "reached the discard-confirm dialog but the test injected no confirmDiscard",
      );
    });
  const calls = { busyNotices: 0, reevaluateReload: 0, reevaluateReopen: 0 };

  async function notifyBusy(): Promise<void> {
    calls.busyNotices += 1;
  }

  // --- reload (issue #159) -------------------------------------------
  /** Drained/in-place re-validation, shared shape with main.ts's
   *  reevaluateReload: re-fetches fresh (never trusts the pre-await
   *  snapshot) and only re-asks the user when the doc is actually dirty
   *  right now — a spurious wake (fingerprint unchanged) is a silent
   *  no-op, exactly like #124's own reevaluateReload. */
  async function reevaluateReload(fetchOpen: () => Promise<OpenedFixture>): Promise<void> {
    calls.reevaluateReload += 1;
    const opened = await fetchOpen();
    if (fingerprintsEqual(opened.fingerprint, doc.fingerprint)) return;
    if (doc.dirty) {
      const reload = await confirmDiscard();
      if (!reload) return;
      applyOpened(doc, await fetchOpen());
      return;
    }
    applyOpened(doc, opened);
  }

  /** Mirrors fetchAndApplyReload (issue #159): capture identity before the
   *  IPC call, validate after — closed discards outright, edited routes
   *  through the same re-evaluation reevaluateReload already does for the
   *  drained-pending-reload path, apply is the untouched fast path. */
  async function fetchAndApplyReload(fetchOpen: () => Promise<OpenedFixture>): Promise<void> {
    const guard = captureIdentity(doc);
    const opened = await fetchOpen();
    const verdict = validateIdentity(guard, doc, tabs.includes(doc));
    if (verdict === "closed") return;
    if (verdict === "edited") {
      await reevaluateReload(fetchOpen);
      return;
    }
    applyOpened(doc, opened);
  }

  // --- reopen (issue #159 + #169) -------------------------------------
  /** Mirrors reevaluateReopen: unlike reload there's no "did disk actually
   *  change" short-circuit — the user explicitly asked for a re-decode
   *  regardless of disk state — so this only ever re-asks the SAME
   *  discard-confirm reopenWithEncoding's own entry already shows,
   *  re-consulted against doc's CURRENT dirty state, then applies a
   *  SECOND fresh read (the disk/buffer may have moved again while any
   *  dialog here was open). */
  async function reevaluateReopen(fetchOpen: () => Promise<OpenedFixture>): Promise<void> {
    calls.reevaluateReopen += 1;
    if (doc.dirty) {
      const discard = await confirmDiscard();
      if (!discard) return;
    }
    applyOpened(doc, await fetchOpen());
  }

  /** Mirrors fetchAndApplyReopen (issue #159): same capture/validate shape
   *  as fetchAndApplyReload. */
  async function fetchAndApplyReopen(fetchOpen: () => Promise<OpenedFixture>): Promise<void> {
    const guard = captureIdentity(doc);
    const opened = await fetchOpen();
    const verdict = validateIdentity(guard, doc, tabs.includes(doc));
    if (verdict === "closed") return;
    if (verdict === "edited") {
      await reevaluateReopen(fetchOpen);
      return;
    }
    applyOpened(doc, opened);
  }

  return {
    tabs,
    calls,
    async issueReload(fetchOpen: () => Promise<OpenedFixture>): Promise<void> {
      await withLock(doc, "reload", () => fetchAndApplyReload(fetchOpen));
    },
    /** Mirrors reopenWithEncoding (issue #169): mustDefer-checked at
     *  entry, and again right after the discard-confirm dialog — that
     *  dialog is itself an await gap something else (a watcher-triggered
     *  reload, most plausibly) could grab the lock during, so the
     *  check-then-acquire right before withLock has to be re-verified,
     *  not just asserted once at entry. Deliberately never sets a
     *  pending-reopen slot: blocked-and-notified rather than queued,
     *  since reopen (unlike reload) is always user-initiated — a blunt
     *  "busy, try again" is simpler than a queue and no less honest about
     *  what just happened. */
    async issueReopenWithEncoding(fetchOpen: () => Promise<OpenedFixture>): Promise<void> {
      if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
        await notifyBusy();
        return;
      }
      if (doc.dirty) {
        const discard = await confirmDiscard();
        if (!discard) return;
        if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
          await notifyBusy();
          return;
        }
      }
      await withLock(doc, "reload", () => fetchAndApplyReopen(fetchOpen));
    },
    async issueSave(ipc: () => Promise<void>): Promise<void> {
      await withLock(doc, "save", ipc);
    },
  };
}

/** A promise plus its resolve/reject, exposed for manual settlement — lets
 *  a test hold an openDocument IPC mock open across another synchronous
 *  action (e.g. a same-tab edit) before deciding when it "arrives". Same
 *  shape as savemutex.test.ts / chunkguard.test.ts's helper. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("issue #159 — reloadFromDisk's own IPC await races a same-tab edit", () => {
  it("typing during the IPC, then declining the resulting confirm: buffer/dirty/backup/fingerprint all survive untouched", async () => {
    const doc = makeDocState({ revision: 5, fingerprint: "fp-old", buffer: "original" });
    let confirmCalls = 0;
    const harness = createHarness(doc, {
      confirmDiscard: () => {
        confirmCalls += 1;
        return Promise.resolve(false);
      },
    });
    const openCall = deferred<OpenedFixture>();

    const reloadPromise = harness.issueReload(() => openCall.promise);

    // User types in the same tab while openDocument's IPC round trip is
    // still in flight — mirrors the editor's onChange handler (main.ts):
    // every keystroke bumps revision unconditionally and sets dirty on
    // the clean->dirty transition.
    doc.revision = 6;
    doc.dirty = true;
    doc.buffer = "original-plus-typing";
    doc.backupName = "bk-typed.txt";

    openCall.resolve({ content: "external-new", fingerprint: "fp-new", encoding: "UTF-8" });
    await reloadPromise;

    expect(confirmCalls).toBe(1);
    expect(doc.buffer).toBe("original-plus-typing");
    expect(doc.dirty).toBe(true);
    expect(doc.backupName).toBe("bk-typed.txt");
    expect(doc.fingerprint).toBe("fp-old");
    expect(doc.revision).toBe(6);
  });

  it("typing during the IPC, then confirming: applies a SECOND fresh read, not the pre-await snapshot", async () => {
    const doc = makeDocState({ revision: 5, fingerprint: "fp-old", buffer: "original" });
    const harness = createHarness(doc, { confirmDiscard: () => Promise.resolve(true) });
    const openCall = deferred<OpenedFixture>();
    let fetchCount = 0;
    const fetchOpen = () => {
      fetchCount += 1;
      if (fetchCount === 1) return openCall.promise;
      // The second (post-consent) fetch sees the disk having moved again
      // while the dialog was up — proves the apply isn't reusing the
      // stale first response.
      return Promise.resolve({ content: "external-v2", fingerprint: "fp-v2", encoding: "UTF-8" });
    };

    const reloadPromise = harness.issueReload(fetchOpen);
    doc.revision = 6;
    doc.dirty = true;
    doc.buffer = "original-plus-typing";
    doc.backupName = "bk-typed.txt";
    openCall.resolve({ content: "external-new", fingerprint: "fp-new", encoding: "UTF-8" });
    await reloadPromise;

    expect(doc.buffer).toBe("external-v2");
    expect(doc.fingerprint).toBe("fp-v2");
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
  });

  it("closing the tab during the IPC discards the result with no mutation at all", async () => {
    const doc = makeDocState({
      revision: 5,
      fingerprint: "fp-old",
      buffer: "original",
      backupName: "bk-1.txt",
    });
    const harness = createHarness(doc);
    const openCall = deferred<OpenedFixture>();

    const reloadPromise = harness.issueReload(() => openCall.promise);
    harness.tabs.length = 0; // tab closed mid-flight — tabs.ts close()'s splice, simulated

    openCall.resolve({ content: "external-new", fingerprint: "fp-new", encoding: "UTF-8" });
    await reloadPromise;

    expect(doc.buffer).toBe("original");
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBe("bk-1.txt");
    expect(doc.fingerprint).toBe("fp-old");
    expect(doc.revision).toBe(5);
    expect(harness.calls.reevaluateReload).toBe(0);
  });

  it("control — no edit during the IPC: applies normally with no dialog (zero regression)", async () => {
    const doc = makeDocState({ revision: 5, fingerprint: "fp-old", buffer: "original" });
    const harness = createHarness(doc); // no confirmDiscard injected — reaching it would throw
    await harness.issueReload(() =>
      Promise.resolve({ content: "external-new", fingerprint: "fp-new", encoding: "UTF-8" }),
    );
    expect(doc.buffer).toBe("external-new");
    expect(doc.fingerprint).toBe("fp-new");
    expect(doc.dirty).toBe(false);
    expect(doc.revision).toBe(6);
  });
});

describe("issue #159 — reopenWithEncoding's own IPC await races a same-tab edit", () => {
  it("typing during the IPC, then declining the resulting confirm: buffer/dirty/backup/encoding all survive untouched", async () => {
    const doc = makeDocState({ revision: 5, fingerprint: "fp-old", buffer: "original", dirty: false });
    let confirmCalls = 0;
    const harness = createHarness(doc, {
      confirmDiscard: () => {
        confirmCalls += 1;
        return Promise.resolve(false);
      },
    });
    const openCall = deferred<OpenedFixture>();

    // doc started clean, so reopenWithEncoding's own entry dirty-check
    // never fired a dialog — the user only types after the IPC is
    // already under way.
    const reopenPromise = harness.issueReopenWithEncoding(() => openCall.promise);
    doc.revision = 6;
    doc.dirty = true;
    doc.buffer = "original-plus-typing";
    doc.backupName = "bk-typed.txt";

    openCall.resolve({ content: "big5-decoded", fingerprint: "fp-new", encoding: "Big5" });
    await reopenPromise;

    expect(confirmCalls).toBe(1);
    expect(doc.buffer).toBe("original-plus-typing");
    expect(doc.dirty).toBe(true);
    expect(doc.backupName).toBe("bk-typed.txt");
    expect(doc.encoding).toBe("UTF-8"); // never switched to the requested encoding
    expect(doc.fingerprint).toBe("fp-old");
  });

  it("typing during the IPC, then confirming: applies a SECOND fresh read with the requested encoding", async () => {
    const doc = makeDocState({ revision: 5, fingerprint: "fp-old", buffer: "original", dirty: false });
    const harness = createHarness(doc, { confirmDiscard: () => Promise.resolve(true) });
    const openCall = deferred<OpenedFixture>();
    let fetchCount = 0;
    const fetchOpen = () => {
      fetchCount += 1;
      if (fetchCount === 1) return openCall.promise;
      return Promise.resolve({ content: "big5-v2", fingerprint: "fp-v2", encoding: "Big5" });
    };

    const reopenPromise = harness.issueReopenWithEncoding(fetchOpen);
    doc.revision = 6;
    doc.dirty = true;
    doc.buffer = "original-plus-typing";
    openCall.resolve({ content: "big5-decoded", fingerprint: "fp-new", encoding: "Big5" });
    await reopenPromise;

    expect(doc.buffer).toBe("big5-v2");
    expect(doc.encoding).toBe("Big5");
    expect(doc.dirty).toBe(false);
  });

  it("closing the tab during the IPC discards the result with no mutation at all", async () => {
    const doc = makeDocState({
      revision: 5,
      fingerprint: "fp-old",
      buffer: "original",
      backupName: "bk-1.txt",
    });
    const harness = createHarness(doc);
    const openCall = deferred<OpenedFixture>();

    const reopenPromise = harness.issueReopenWithEncoding(() => openCall.promise);
    harness.tabs.length = 0;

    openCall.resolve({ content: "big5-decoded", fingerprint: "fp-new", encoding: "Big5" });
    await reopenPromise;

    expect(doc.buffer).toBe("original");
    expect(doc.encoding).toBe("UTF-8");
    expect(doc.backupName).toBe("bk-1.txt");
    expect(harness.calls.reevaluateReopen).toBe(0);
  });

  it("control — no edit during the IPC: applies normally with no dialog (zero regression)", async () => {
    const doc = makeDocState({ revision: 5, buffer: "original" });
    const harness = createHarness(doc);
    await harness.issueReopenWithEncoding(() =>
      Promise.resolve({ content: "big5-decoded", fingerprint: "fp-new", encoding: "Big5" }),
    );
    expect(doc.buffer).toBe("big5-decoded");
    expect(doc.encoding).toBe("Big5");
    expect(doc.dirty).toBe(false);
  });
});

describe("issue #169 — reopenWithEncoding defers to an in-flight save instead of racing it", () => {
  it("a save already in flight at entry blocks the reopen with a busy notice — no IPC attempted, no mutation", async () => {
    const doc = makeDocState({ revision: 5, buffer: "original" });
    const harness = createHarness(doc);
    const saveCall = deferred<void>();
    const savePromise = harness.issueSave(() => saveCall.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    await harness.issueReopenWithEncoding(() => {
      throw new Error("reopen's openDocument must never be called while a save is in flight");
    });

    expect(harness.calls.busyNotices).toBe(1);
    expect(doc.buffer).toBe("original");
    expect(doc.saveReloadInFlight).toBe("save"); // unclobbered — still the save's own lock

    saveCall.resolve();
    await savePromise;
  });

  it("a save that grabs the lock while reopen's own discard-confirm dialog is up is also respected, not clobbered", async () => {
    const doc = makeDocState({ revision: 5, buffer: "original", dirty: true });
    const saveCall = deferred<void>();
    let savePromise: Promise<void> | null = null;
    const harness = createHarness(doc, {
      confirmDiscard: async () => {
        // While the user is still looking at reopen's own discard-confirm
        // dialog, something else (a watcher-triggered save-adjacent flow,
        // modeled directly as a save here) starts and takes the per-doc
        // lock.
        savePromise = harness.issueSave(() => saveCall.promise);
        return true;
      },
    });

    await harness.issueReopenWithEncoding(() => {
      throw new Error("reopen's openDocument must never be called once the lock was taken from under it");
    });

    expect(harness.calls.busyNotices).toBe(1);
    expect(doc.saveReloadInFlight).toBe("save"); // still the save's, unclobbered by reopen's withLock

    saveCall.resolve();
    await savePromise;
  });
});
