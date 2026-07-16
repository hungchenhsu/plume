import { describe, expect, it } from "vitest";
import { fingerprintsEqual, mustDefer, type LockOwner } from "./savemutex";
import {
  captureIdentity,
  reloadEncodingFor,
  validateIdentity,
  type GuardIdentity,
} from "./asyncguard";
import { planNormalization, type NormalizeForm } from "./normalize";

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

describe("reloadEncodingFor — full branch table (issue #161)", () => {
  it("no speculative window: falls back to doc.encoding, unchanged from every reload path's pre-#161 behavior", () => {
    expect(
      reloadEncodingFor({ encoding: "UTF-8", speculativeEncoding: null }),
    ).toBe("UTF-8");
    expect(
      reloadEncodingFor({ encoding: "Big5", speculativeEncoding: null }),
    ).toBe("Big5");
  });

  it("a Save with Encoding speculative window is open: returns the protected original, not the not-yet-written doc.encoding", () => {
    expect(
      reloadEncodingFor({
        encoding: "UTF-8", // the speculative target Save with Encoding applied
        speculativeEncoding: { encoding: "Big5" }, // the protected original
      }),
    ).toBe("Big5");
  });

  it("the speculative original can equal the current doc.encoding (no-op mutation, e.g. re-picking the same encoding+BOM combination) without changing the result", () => {
    expect(
      reloadEncodingFor({
        encoding: "UTF-8",
        speculativeEncoding: { encoding: "UTF-8" },
      }),
    ).toBe("UTF-8");
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

  /** Mirrors main.ts's fetchAndApplyGuarded (issue #209): the shared guard
   *  reevaluateReload/reevaluateReopen's own post-confirm fetch goes
   *  through, instead of applying that fetch's result unconditionally.
   *  'closed' discards outright; 'edited' hands back to the caller's own
   *  re-evaluation function (called again from the top, not patched in
   *  place — see main.ts's fetchAndApplyGuarded doc comment for why);
   *  'apply' is the untouched fast path. */
  async function fetchAndApplyGuarded(
    fetchOpen: () => Promise<OpenedFixture>,
    onEdited: () => Promise<void>,
  ): Promise<void> {
    const guard = captureIdentity(doc);
    const opened = await fetchOpen();
    const verdict = validateIdentity(guard, doc, tabs.includes(doc));
    if (verdict === "closed") return;
    if (verdict === "edited") {
      await onEdited();
      return;
    }
    applyOpened(doc, opened);
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
      // Guarded (issue #209): this second fetch is its own await gap, same
      // hazard as fetchAndApplyReload's own openDocument call.
      await fetchAndApplyGuarded(fetchOpen, () => reevaluateReload(fetchOpen));
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
    // Guarded (issue #209): this fetch is its own await gap, same hazard as
    // fetchAndApplyReopen's own openDocument call.
    await fetchAndApplyGuarded(fetchOpen, () => reevaluateReopen(fetchOpen));
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

describe("issue #209 — reevaluateReload/reevaluateReopen's own post-confirm fetch races a same-tab edit or a tab close", () => {
  describe("reload", () => {
    it("typing again after confirming discard, while reevaluateReload's own second fetch is in flight: the fresh keystrokes are not clobbered, and a stale/premature read is never applied", async () => {
      const doc = makeDocState({ revision: 5, fingerprint: "fp-old", buffer: "original" });
      let confirmCalls = 0;
      const harness = createHarness(doc, {
        // Round 1 (inside reevaluateReload, reached via fetchAndApplyReload's
        // own "edited" verdict) agrees to discard; round 2 (the recursive
        // re-evaluation triggered by typing AGAIN during round 1's own
        // guarded second fetch) declines — proving the decline path leaves
        // everything from round 2's typing untouched.
        confirmDiscard: () => {
          confirmCalls += 1;
          return Promise.resolve(confirmCalls === 1);
        },
      });

      const firstOuterFetch = deferred<OpenedFixture>(); // fetchAndApplyReload's own await
      const secondFetch = deferred<OpenedFixture>(); // reevaluateReload's guarded post-confirm fetch
      let fetchCount = 0;
      const fetchOpen = () => {
        fetchCount += 1;
        if (fetchCount === 1) return firstOuterFetch.promise;
        // reevaluateReload's own first (fingerprint-check) fetch, reached
        // via the "edited" verdict above — must mismatch doc.fingerprint
        // ("fp-old") so the dirty-confirm branch fires.
        if (fetchCount === 2) {
          return Promise.resolve({ content: "external-1", fingerprint: "fp-1", encoding: "UTF-8" });
        }
        if (fetchCount === 3) return secondFetch.promise;
        // The recursive reevaluateReload's own first fetch (round 2) — disk
        // still hasn't moved from doc's perspective (still mismatches
        // fp-old), so it re-prompts instead of silently no-oping.
        if (fetchCount === 4) {
          return Promise.resolve({ content: "external-2", fingerprint: "fp-2", encoding: "UTF-8" });
        }
        throw new Error("must not fetch a 5th time — round 2's confirm was declined");
      };

      const reloadPromise = harness.issueReload(fetchOpen);

      // Round 1: user types while fetchAndApplyReload's own outer await is
      // in flight — routes into reevaluateReload via the "edited" verdict.
      doc.revision = 6;
      doc.dirty = true;
      doc.buffer = "typing-1";
      doc.backupName = "bk-1.txt";
      firstOuterFetch.resolve({ content: "stale-outer", fingerprint: "fp-stale", encoding: "UTF-8" });

      await waitUntil(() => fetchCount >= 3);
      expect(confirmCalls).toBe(1); // sanity: round 1's confirm already resolved, second fetch under way

      // Round 2: user types AGAIN while reevaluateReload's own guarded
      // second fetch (the one issue #209 reports as unguarded) is in
      // flight.
      doc.revision = 7;
      doc.buffer = "typing-2";
      doc.backupName = "bk-2.txt";
      secondFetch.resolve({
        content: "premature-should-not-apply",
        fingerprint: "fp-premature",
        encoding: "UTF-8",
      });

      await reloadPromise;

      expect(fetchCount).toBe(4); // round 2 declined before its own second fetch
      expect(confirmCalls).toBe(2); // re-confirmed once per round — not silently dropped, not silently applied
      expect(doc.buffer).toBe("typing-2");
      expect(doc.dirty).toBe(true);
      expect(doc.backupName).toBe("bk-2.txt");
      expect(doc.fingerprint).toBe("fp-old"); // nothing ever actually applied
    });

    it("closing the tab while reevaluateReload's own second fetch is in flight: discards the result with no mutation to the detached doc and no backup deletion", async () => {
      const doc = makeDocState({
        revision: 5,
        fingerprint: "fp-old",
        buffer: "original",
        dirty: true,
        backupName: "bk-1.txt",
      });
      const harness = createHarness(doc, { confirmDiscard: () => Promise.resolve(true) });

      const firstOuterFetch = deferred<OpenedFixture>();
      const secondFetch = deferred<OpenedFixture>();
      let fetchCount = 0;
      const fetchOpen = () => {
        fetchCount += 1;
        if (fetchCount === 1) return firstOuterFetch.promise;
        if (fetchCount === 2) {
          return Promise.resolve({ content: "external-1", fingerprint: "fp-1", encoding: "UTF-8" });
        }
        if (fetchCount === 3) return secondFetch.promise;
        throw new Error("must not fetch again — the tab is closed, nothing left to re-evaluate for");
      };

      const reloadPromise = harness.issueReload(fetchOpen);
      doc.revision = 6; // same-tab edit routes fetchAndApplyReload into reevaluateReload
      firstOuterFetch.resolve({ content: "stale-outer", fingerprint: "fp-stale", encoding: "UTF-8" });

      await waitUntil(() => fetchCount >= 3);

      harness.tabs.length = 0; // tab closed mid-flight, during reevaluateReload's own second fetch
      secondFetch.resolve({
        content: "premature-should-not-apply",
        fingerprint: "fp-premature",
        encoding: "UTF-8",
      });

      await reloadPromise;

      expect(doc.buffer).toBe("original");
      expect(doc.dirty).toBe(true);
      expect(doc.backupName).toBe("bk-1.txt"); // dropBackup never reached the detached doc
      expect(doc.fingerprint).toBe("fp-old");
    });
  });

  describe("reopen", () => {
    it("typing again after confirming discard, while reevaluateReopen's own second fetch is in flight: the fresh keystrokes are not clobbered, and a stale/premature read is never applied", async () => {
      const doc = makeDocState({ revision: 5, fingerprint: "fp-old", buffer: "original", dirty: false });
      let confirmCalls = 0;
      const harness = createHarness(doc, {
        confirmDiscard: () => {
          confirmCalls += 1;
          return Promise.resolve(confirmCalls === 1);
        },
      });

      const firstOuterFetch = deferred<OpenedFixture>(); // fetchAndApplyReopen's own await
      const secondFetch = deferred<OpenedFixture>(); // reevaluateReopen's guarded fetch
      let fetchCount = 0;
      const fetchOpen = () => {
        fetchCount += 1;
        if (fetchCount === 1) return firstOuterFetch.promise;
        if (fetchCount === 2) return secondFetch.promise;
        throw new Error("must not fetch a 3rd time — round 2's confirm was declined");
      };

      // doc starts clean, so reopenWithEncoding's own entry dirty-check
      // never fires — the user only types after the IPC is under way,
      // exactly like the existing #159 reopen tests above.
      const reopenPromise = harness.issueReopenWithEncoding(fetchOpen);

      doc.revision = 6;
      doc.dirty = true;
      doc.buffer = "typing-1";
      doc.backupName = "bk-1.txt";
      firstOuterFetch.resolve({ content: "big5-decoded", fingerprint: "fp-new", encoding: "Big5" });

      await waitUntil(() => fetchCount >= 2);
      expect(confirmCalls).toBe(1);

      doc.revision = 7;
      doc.buffer = "typing-2";
      doc.backupName = "bk-2.txt";
      secondFetch.resolve({
        content: "premature-should-not-apply",
        fingerprint: "fp-premature",
        encoding: "Big5",
      });

      await reopenPromise;

      expect(fetchCount).toBe(2);
      expect(confirmCalls).toBe(2);
      expect(doc.buffer).toBe("typing-2");
      expect(doc.dirty).toBe(true);
      expect(doc.backupName).toBe("bk-2.txt");
      expect(doc.encoding).toBe("UTF-8"); // never switched to the requested encoding
    });

    it("closing the tab while reevaluateReopen's own second fetch is in flight: discards the result with no mutation to the detached doc and no backup deletion", async () => {
      const doc = makeDocState({
        revision: 5,
        fingerprint: "fp-old",
        buffer: "original",
        dirty: false,
        backupName: "bk-1.txt",
      });
      const harness = createHarness(doc, { confirmDiscard: () => Promise.resolve(true) });

      const firstOuterFetch = deferred<OpenedFixture>();
      const secondFetch = deferred<OpenedFixture>();
      let fetchCount = 0;
      const fetchOpen = () => {
        fetchCount += 1;
        if (fetchCount === 1) return firstOuterFetch.promise;
        if (fetchCount === 2) return secondFetch.promise;
        throw new Error("must not fetch again — the tab is closed, nothing left to re-evaluate for");
      };

      const reopenPromise = harness.issueReopenWithEncoding(fetchOpen);
      doc.revision = 6;
      doc.dirty = true;
      firstOuterFetch.resolve({ content: "big5-decoded", fingerprint: "fp-new", encoding: "Big5" });

      await waitUntil(() => fetchCount >= 2);

      harness.tabs.length = 0;
      secondFetch.resolve({
        content: "premature-should-not-apply",
        fingerprint: "fp-premature",
        encoding: "Big5",
      });

      await reopenPromise;

      expect(doc.buffer).toBe("original");
      expect(doc.encoding).toBe("UTF-8");
      expect(doc.backupName).toBe("bk-1.txt");
    });
  });

  // No separate control test here for "confirm, then no further interference
  // during the second fetch": issue #159's own "typing during the IPC, then
  // confirming" tests above (reload: "applies a SECOND fresh read, not the
  // pre-await snapshot"; reopen: "applies a SECOND fresh read with the
  // requested encoding") already exercise exactly that window — a same-tab
  // edit routes into reevaluateReload/reevaluateReopen, the user confirms
  // discard, and the resulting post-confirm fetch resolves with zero further
  // interference — so they double as this section's regression control:
  // still green and unchanged post-#209 is the assertion.
});

// ---------------------------------------------------------------------------
// main.ts-shaped simulation for runNormalizeFlow's own confirm-dialog and
// representability-IPC awaits (issue #158). Same technique as the
// reload/reopen harness above (main.ts has no *.test.ts of its own — see
// that harness's own header comment): mirrors runNormalizeFlow's control
// flow closely enough to reproduce each race, wired to the real
// captureIdentity/validateIdentity (this module) and the real
// planNormalization (normalize.ts) rather than reimplementing their logic
// independently.
//
// Unlike reload/reopen, the eventual mutation (`editor.replaceContent`)
// writes to a single surface shared by every tab, not a per-doc buffer — so
// the id/revision guard alone isn't sufficient: a doc can be untouched and
// still open (validateIdentity would say "apply") yet no longer be what the
// editor is showing, if the user switched tabs during one of
// runNormalizeFlow's three await gaps (the first confirm, the
// checkRepresentable IPC round trip, the second confirm).
// NormalizeEditorState below models the editor as its own object,
// independent of any NormalizeDocState, precisely so a wrongful cross-tab
// apply is visible as THAT object ending up with tab A's normalized text
// while tab B is active — the bug this section exists to catch.
// normalizeGuardOutcomeSim adds the explicit active-tab check
// showMojibakeRepairWizard already established for this same hazard
// (mojibake.ts's own snapshot-staleness check predates asyncguard.ts, so it
// doesn't reuse captureIdentity/validateIdentity, but the "is this still
// the active tab" half of its reasoning is identical).

interface NormalizeDocState {
  id: number;
  revision: number;
  encoding: string;
}

interface NormalizeTabsState {
  docs: NormalizeDocState[];
  activeId: number | null;
}

/** Stand-in for main.ts's single shared `editor` (editor.ts's
 *  EditorBuffer) — content lives here, not on any particular
 *  NormalizeDocState, so a wrongful cross-tab apply is visible as THIS
 *  object ending up with tab A's normalized text while tab B is active. */
interface NormalizeEditorState {
  content: string;
}

/** Mirrors main.ts's `isUnicodeEncoding`. */
function isUnicodeEncodingSim(encoding: string): boolean {
  return encoding === "UTF-8" || encoding.startsWith("UTF-16");
}

type NormalizeGuardOutcome = "apply" | "silent" | "notify";

/** Mirrors main.ts's `normalizeGuardOutcome` (issue #158): asyncguard.ts's
 *  identity verdict, plus the active-tab check described above. "apply"
 *  only when `doc` is both unchanged since `guard` was captured AND still
 *  the tab the (shared) editor is currently showing. "silent" for a closed
 *  tab or one the user switched away from — nothing useful to tell them
 *  either way, same reasoning as asyncguard.ts's own "closed" verdict and
 *  showMojibakeRepairWizard's activeId check. "notify" only for a
 *  same-tab edit (asyncguard.ts's "edited", while still active): the user
 *  is still looking right at this tab and just confirmed an operation, so
 *  silently discarding it would be confusing. */
function normalizeGuardOutcomeSim(
  tabs: NormalizeTabsState,
  guard: GuardIdentity,
  doc: NormalizeDocState,
): NormalizeGuardOutcome {
  if (tabs.activeId !== guard.id) return "silent";
  const verdict = validateIdentity(guard, doc, tabs.docs.includes(doc));
  if (verdict === "apply") return "apply";
  if (verdict === "closed") return "silent";
  return "notify";
}

interface NormalizeDeps {
  confirmDialog: () => Promise<boolean>;
  checkRepresentable: (text: string, encoding: string) => Promise<{ unmappableCount: number }>;
  /** Fire-and-forget stand-in for main.ts's un-awaited
   *  `void messageDialog(...)` — matches showMojibakeRepairWizard's own
   *  staleContentMessage, a plain acknowledgement nothing needs to wait
   *  on. */
  notifyStale: () => void;
}

/** Mirrors runNormalizeFlow (issue #158): capture identity before the first
 *  await, re-validate (guard + active-tab, via normalizeGuardOutcomeSim)
 *  after every await that precedes the eventual apply — the first confirm,
 *  the representability IPC round trip, and the second
 *  (unrepresentable-chars) confirm — with zero further await between the
 *  last passing check and the apply itself on every path (a "notify" or
 *  "silent" outcome always returns immediately instead of falling through). */
async function runNormalizeFlowSim(
  tabs: NormalizeTabsState,
  editorState: NormalizeEditorState,
  doc: NormalizeDocState,
  form: NormalizeForm,
  deps: NormalizeDeps,
): Promise<void> {
  const guard = captureIdentity(doc);
  const plan = planNormalization(editorState.content, form);
  if (!plan.changed) return;

  const proceed = await deps.confirmDialog();
  if (!proceed) return;
  let outcome = normalizeGuardOutcomeSim(tabs, guard, doc);
  if (outcome === "notify") deps.notifyStale();
  if (outcome !== "apply") return;

  if (!isUnicodeEncodingSim(doc.encoding)) {
    const report = await deps.checkRepresentable(plan.normalized, doc.encoding);
    outcome = normalizeGuardOutcomeSim(tabs, guard, doc);
    if (outcome === "notify") deps.notifyStale();
    if (outcome !== "apply") return;

    if (report.unmappableCount > 0) {
      const proceedAnyway = await deps.confirmDialog();
      if (!proceedAnyway) return;
      outcome = normalizeGuardOutcomeSim(tabs, guard, doc);
      if (outcome === "notify") deps.notifyStale();
      if (outcome !== "apply") return;
    }
  }

  editorState.content = plan.normalized;
}

/** Drains the microtask queue until `predicate` holds (or gives up after 20
 *  ticks) — used to deterministically land a test's own mutation inside a
 *  later await gap (checkRepresentable, the second confirm) that sits
 *  behind one or more earlier awaits a given test resolves immediately
 *  rather than controls directly. Over-waiting is harmless: once the
 *  awaited chain reaches a promise nothing has resolved yet, further ticks
 *  are no-ops, so this always settles as soon as the target call actually
 *  lands. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !predicate(); i++) {
    await Promise.resolve();
  }
}

const NFD_CAFE = "café"; // "café" spelled with a combining acute accent (NFD)
const NFC_CAFE = "café"; // precomposed "café" (NFC)

describe("issue #158 — runNormalizeFlow's own confirm/IPC awaits race a tab switch or same-tab edit", () => {
  describe("first confirm dialog", () => {
    it("switching tabs while the confirm dialog is up: normalized text is not applied to the new active tab's editor, silently", async () => {
      const docA: NormalizeDocState = { id: 1, revision: 0, encoding: "UTF-8" };
      const docB: NormalizeDocState = { id: 2, revision: 0, encoding: "UTF-8" };
      const tabs: NormalizeTabsState = { docs: [docA, docB], activeId: docA.id };
      const editorState: NormalizeEditorState = { content: NFD_CAFE };
      const confirmCall = deferred<boolean>();
      let notifyCalls = 0;

      const flowPromise = runNormalizeFlowSim(tabs, editorState, docA, "NFC", {
        confirmDialog: () => confirmCall.promise,
        checkRepresentable: () => {
          throw new Error("UTF-8 doc must never call checkRepresentable");
        },
        notifyStale: () => {
          notifyCalls += 1;
        },
      });

      // User switches to tab B while the confirm dialog is still open —
      // mirrors tabs.setActive reassigning activeId; the shared editor now
      // shows B's own content, not A's.
      tabs.activeId = docB.id;
      editorState.content = "tab B's own live content";

      confirmCall.resolve(true);
      await flowPromise;

      expect(editorState.content).toBe("tab B's own live content");
      expect(notifyCalls).toBe(0); // silent — the user isn't looking at A anymore
    });

    it("typing in the same tab while the confirm dialog is up: the fresh edit is not overwritten, and a stale notice fires", async () => {
      const doc: NormalizeDocState = { id: 1, revision: 0, encoding: "UTF-8" };
      const tabs: NormalizeTabsState = { docs: [doc], activeId: doc.id };
      const editorState: NormalizeEditorState = { content: NFD_CAFE };
      const confirmCall = deferred<boolean>();
      let notifyCalls = 0;

      const flowPromise = runNormalizeFlowSim(tabs, editorState, doc, "NFC", {
        confirmDialog: () => confirmCall.promise,
        checkRepresentable: () => {
          throw new Error("UTF-8 doc must never call checkRepresentable");
        },
        notifyStale: () => {
          notifyCalls += 1;
        },
      });

      // User keeps typing in the same tab while the confirm dialog is open
      // — mirrors the editor's onChange handler bumping doc.revision on
      // every keystroke.
      doc.revision += 1;
      editorState.content = NFD_CAFE + " plus fresh typing";

      confirmCall.resolve(true);
      await flowPromise;

      expect(editorState.content).toBe(NFD_CAFE + " plus fresh typing");
      expect(notifyCalls).toBe(1);
    });
  });

  describe("representability IPC (legacy encoding path)", () => {
    it("switching tabs while checkRepresentable is in flight: not applied, silently", async () => {
      const docA: NormalizeDocState = { id: 1, revision: 0, encoding: "Big5" };
      const docB: NormalizeDocState = { id: 2, revision: 0, encoding: "Big5" };
      const tabs: NormalizeTabsState = { docs: [docA, docB], activeId: docA.id };
      const editorState: NormalizeEditorState = { content: NFD_CAFE };
      const repCall = deferred<{ unmappableCount: number }>();
      let checkRepCalls = 0;
      let notifyCalls = 0;

      const flowPromise = runNormalizeFlowSim(tabs, editorState, docA, "NFC", {
        confirmDialog: () => Promise.resolve(true),
        checkRepresentable: () => {
          checkRepCalls += 1;
          return repCall.promise;
        },
        notifyStale: () => {
          notifyCalls += 1;
        },
      });

      await waitUntil(() => checkRepCalls > 0);
      expect(checkRepCalls).toBe(1); // sanity: racing the intended await

      tabs.activeId = docB.id;
      editorState.content = "tab B's own live content";

      repCall.resolve({ unmappableCount: 0 });
      await flowPromise;

      expect(editorState.content).toBe("tab B's own live content");
      expect(notifyCalls).toBe(0);
    });

    it("typing in the same tab while checkRepresentable is in flight: the fresh edit is not overwritten, and a stale notice fires", async () => {
      const doc: NormalizeDocState = { id: 1, revision: 0, encoding: "Big5" };
      const tabs: NormalizeTabsState = { docs: [doc], activeId: doc.id };
      const editorState: NormalizeEditorState = { content: NFD_CAFE };
      const repCall = deferred<{ unmappableCount: number }>();
      let checkRepCalls = 0;
      let notifyCalls = 0;

      const flowPromise = runNormalizeFlowSim(tabs, editorState, doc, "NFC", {
        confirmDialog: () => Promise.resolve(true),
        checkRepresentable: () => {
          checkRepCalls += 1;
          return repCall.promise;
        },
        notifyStale: () => {
          notifyCalls += 1;
        },
      });

      await waitUntil(() => checkRepCalls > 0);
      expect(checkRepCalls).toBe(1);

      doc.revision += 1;
      editorState.content = NFD_CAFE + " plus fresh typing";

      repCall.resolve({ unmappableCount: 0 });
      await flowPromise;

      expect(editorState.content).toBe(NFD_CAFE + " plus fresh typing");
      expect(notifyCalls).toBe(1);
    });
  });

  describe("second (unrepresentable-characters) confirm dialog", () => {
    it("switching tabs while the second confirm dialog is up: not applied, silently", async () => {
      const docA: NormalizeDocState = { id: 1, revision: 0, encoding: "Big5" };
      const docB: NormalizeDocState = { id: 2, revision: 0, encoding: "Big5" };
      const tabs: NormalizeTabsState = { docs: [docA, docB], activeId: docA.id };
      const editorState: NormalizeEditorState = { content: NFD_CAFE };
      const secondConfirmCall = deferred<boolean>();
      let confirmCalls = 0;
      let notifyCalls = 0;

      const flowPromise = runNormalizeFlowSim(tabs, editorState, docA, "NFC", {
        confirmDialog: () => {
          confirmCalls += 1;
          return confirmCalls === 1 ? Promise.resolve(true) : secondConfirmCall.promise;
        },
        checkRepresentable: () => Promise.resolve({ unmappableCount: 2 }),
        notifyStale: () => {
          notifyCalls += 1;
        },
      });

      await waitUntil(() => confirmCalls > 1);
      expect(confirmCalls).toBe(2); // sanity: racing the second confirm

      tabs.activeId = docB.id;
      editorState.content = "tab B's own live content";

      secondConfirmCall.resolve(true);
      await flowPromise;

      expect(editorState.content).toBe("tab B's own live content");
      expect(notifyCalls).toBe(0);
    });

    it("typing in the same tab while the second confirm dialog is up: the fresh edit is not overwritten, and a stale notice fires", async () => {
      const doc: NormalizeDocState = { id: 1, revision: 0, encoding: "Big5" };
      const tabs: NormalizeTabsState = { docs: [doc], activeId: doc.id };
      const editorState: NormalizeEditorState = { content: NFD_CAFE };
      const secondConfirmCall = deferred<boolean>();
      let confirmCalls = 0;
      let notifyCalls = 0;

      const flowPromise = runNormalizeFlowSim(tabs, editorState, doc, "NFC", {
        confirmDialog: () => {
          confirmCalls += 1;
          return confirmCalls === 1 ? Promise.resolve(true) : secondConfirmCall.promise;
        },
        checkRepresentable: () => Promise.resolve({ unmappableCount: 2 }),
        notifyStale: () => {
          notifyCalls += 1;
        },
      });

      await waitUntil(() => confirmCalls > 1);
      expect(confirmCalls).toBe(2);

      doc.revision += 1;
      editorState.content = NFD_CAFE + " plus fresh typing";

      secondConfirmCall.resolve(true);
      await flowPromise;

      expect(editorState.content).toBe(NFD_CAFE + " plus fresh typing");
      expect(notifyCalls).toBe(1);
    });
  });

  describe("control — no race", () => {
    it("Unicode-encoding doc: applies normally with a single confirm, no representability check, no dialog regression", async () => {
      const doc: NormalizeDocState = { id: 1, revision: 0, encoding: "UTF-8" };
      const tabs: NormalizeTabsState = { docs: [doc], activeId: doc.id };
      const editorState: NormalizeEditorState = { content: NFD_CAFE };
      let notifyCalls = 0;

      await runNormalizeFlowSim(tabs, editorState, doc, "NFC", {
        confirmDialog: () => Promise.resolve(true),
        checkRepresentable: () => {
          throw new Error("UTF-8 doc must never call checkRepresentable");
        },
        notifyStale: () => {
          notifyCalls += 1;
        },
      });

      expect(editorState.content).toBe(NFC_CAFE);
      expect(notifyCalls).toBe(0);
    });

    it("legacy-encoding doc with unrepresentable characters: applies normally through all three awaits", async () => {
      const doc: NormalizeDocState = { id: 1, revision: 0, encoding: "Big5" };
      const tabs: NormalizeTabsState = { docs: [doc], activeId: doc.id };
      const editorState: NormalizeEditorState = { content: NFD_CAFE };
      let confirmCalls = 0;
      let checkRepCalls = 0;
      let notifyCalls = 0;

      await runNormalizeFlowSim(tabs, editorState, doc, "NFC", {
        confirmDialog: () => {
          confirmCalls += 1;
          return Promise.resolve(true);
        },
        checkRepresentable: () => {
          checkRepCalls += 1;
          return Promise.resolve({ unmappableCount: 2 });
        },
        notifyStale: () => {
          notifyCalls += 1;
        },
      });

      expect(editorState.content).toBe(NFC_CAFE);
      expect(confirmCalls).toBe(2);
      expect(checkRepCalls).toBe(1);
      expect(notifyCalls).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// main.ts-shaped simulation for the streaming convert/replace completion
// callbacks' own capture-before-IPC / validate-after-IPC guard (issue #163).
// Same technique as the reload/reopen and normalize harnesses above (main.ts
// has no *.test.ts of its own — see the reload/reopen harness's header
// comment): mirrors main.ts's streamCompletionTarget and its two call sites
// (showEncodingMenu's convertFileToEncoding item, the "stream_replace" menu
// case) closely enough to reproduce the race, wired to the real
// captureIdentity/validateIdentity (this module).
//
// Unlike reload/reopen (whose target is always the SAME doc the operation
// captured) and normalize (whose target is the shared editor surface), a
// streaming convert/replace operation's target is a PATH ON DISK: a tab
// closing mid-operation doesn't necessarily mean there's nothing left to
// refresh — a fresh tab may have been reopened onto that same path while the
// (typically long-running) operation ran. StreamTabsState below models
// `tabs.docs`/`tabs.findByPath` as a plain array plus a lookup, precisely so
// a wrongful apply to the original (closed, detached) doc instead of the
// reopened one is visible: it mutates/reloads an object no longer reachable
// from `tabs.docs` at all, while the reopened doc — the one actually still
// on screen — is left showing stale content.

interface StreamDocState {
  id: number;
  path: string;
  revision: number;
  encoding: string;
  withBom: boolean;
}

interface StreamTabsState {
  docs: StreamDocState[];
}

function makeStreamDoc(overrides: Partial<StreamDocState> = {}): StreamDocState {
  return { id: 1, path: "/big.txt", revision: 0, encoding: "UTF-8", withBom: false, ...overrides };
}

/** Mirrors tabs.ts's findByPath. */
function findByPathSim(tabs: StreamTabsState, path: string): StreamDocState | null {
  return tabs.docs.find((d) => d.path === path) ?? null;
}

/** Mirrors main.ts's streamCompletionTarget (issue #163): "apply"/"edited"
 *  return `doc` itself unchanged (both treated the same — see main.ts's own
 *  doc comment for why a streaming op's target can never actually be
 *  edited); "closed" looks up whatever tab is currently showing the same
 *  path, or null if none. */
function streamCompletionTargetSim(
  tabs: StreamTabsState,
  guard: GuardIdentity,
  doc: StreamDocState,
  path: string,
): StreamDocState | null {
  const verdict = validateIdentity(guard, doc, tabs.docs.includes(doc));
  return verdict === "closed" ? findByPathSim(tabs, path) : doc;
}

interface StreamDeps {
  reloadFromDisk: (doc: StreamDocState) => void;
  notifyClosed: () => void;
}

/** Mirrors the streamConvert call site's completion callback (issue #163):
 *  `guard`/`path` captured before runStreamConvert's own internal awaits
 *  (the busy overlay, the streaming IPC call, the blocking result dialog)
 *  start; re-validated once its onConverted fires. */
function streamConvertCompletionSim(
  tabs: StreamTabsState,
  guard: GuardIdentity,
  doc: StreamDocState,
  path: string,
  target: { value: string; withBom: boolean },
  deps: StreamDeps,
): void {
  const resolved = streamCompletionTargetSim(tabs, guard, doc, path);
  if (!resolved) {
    deps.notifyClosed();
    return;
  }
  // Set *before* reloadFromDisk, same ordering main.ts's real call site
  // uses — reloadFromDisk reopens with whatever resolved.encoding already
  // holds.
  resolved.encoding = target.value;
  resolved.withBom = target.withBom;
  deps.reloadFromDisk(resolved);
}

/** Mirrors the "stream_replace" call site's completion callback (issue
 *  #163) — same shape, minus the encoding mutation (a replace never changes
 *  encoding). */
function streamReplaceCompletionSim(
  tabs: StreamTabsState,
  guard: GuardIdentity,
  doc: StreamDocState,
  path: string,
  deps: StreamDeps,
): void {
  const resolved = streamCompletionTargetSim(tabs, guard, doc, path);
  if (!resolved) {
    deps.notifyClosed();
    return;
  }
  deps.reloadFromDisk(resolved);
}

describe("issue #163 — streaming convert/replace completion callbacks race a tab close", () => {
  describe("streamConvert", () => {
    it("tab closed before completion, same path reopened into a fresh tab: the fresh (reopened) tab is reloaded, not the closed doc", () => {
      const closedDoc = makeStreamDoc({ id: 1, encoding: "UTF-8", withBom: false });
      const tabs: StreamTabsState = { docs: [closedDoc] };
      const guard = captureIdentity(closedDoc);

      // Tab closes mid-conversion (tabs.ts close()'s splice, simulated),
      // then the same path is reopened into a DIFFERENT doc object —
      // closedtabs.ts's Reopen Closed Tab, or the user manually reopening
      // it. A fresh id, same path.
      tabs.docs = tabs.docs.filter((d) => d !== closedDoc);
      const reopenedDoc = makeStreamDoc({ id: 2, encoding: "UTF-8", withBom: false });
      tabs.docs.push(reopenedDoc);

      const reloadCalls: StreamDocState[] = [];
      streamConvertCompletionSim(
        tabs,
        guard,
        closedDoc,
        "/big.txt",
        { value: "Big5", withBom: true },
        {
          reloadFromDisk: (d) => reloadCalls.push(d),
          notifyClosed: () => {
            throw new Error("must not notify — a live tab exists for this path");
          },
        },
      );

      expect(reloadCalls).toEqual([reopenedDoc]);
      expect(reopenedDoc.encoding).toBe("Big5");
      expect(reopenedDoc.withBom).toBe(true);
      // The detached doc the callback originally closed over is left
      // completely untouched — proves the mutation landed on the live tab,
      // not a stale reference nothing displays anymore.
      expect(closedDoc.encoding).toBe("UTF-8");
      expect(closedDoc.withBom).toBe(false);
    });

    it("tab closed before completion, no tab reopened for the path: a completion notice fires and zero docs are mutated or reloaded", () => {
      const closedDoc = makeStreamDoc({ id: 1, encoding: "UTF-8", withBom: false });
      const tabs: StreamTabsState = { docs: [] }; // closed, nothing else open anywhere
      const guard = captureIdentity(closedDoc);

      const reloadCalls: StreamDocState[] = [];
      let notifyCalls = 0;
      streamConvertCompletionSim(
        tabs,
        guard,
        closedDoc,
        "/big.txt",
        { value: "Big5", withBom: true },
        {
          reloadFromDisk: (d) => reloadCalls.push(d),
          notifyClosed: () => {
            notifyCalls += 1;
          },
        },
      );

      expect(reloadCalls).toEqual([]);
      expect(notifyCalls).toBe(1);
      expect(closedDoc.encoding).toBe("UTF-8"); // untouched
      expect(closedDoc.withBom).toBe(false);
    });

    it("control — tab never closed: reloads the original doc, unchanged from pre-#163 behavior", () => {
      const doc = makeStreamDoc({ id: 1, encoding: "UTF-8", withBom: false });
      const tabs: StreamTabsState = { docs: [doc] };
      const guard = captureIdentity(doc);

      const reloadCalls: StreamDocState[] = [];
      streamConvertCompletionSim(
        tabs,
        guard,
        doc,
        "/big.txt",
        { value: "Big5", withBom: true },
        {
          reloadFromDisk: (d) => reloadCalls.push(d),
          notifyClosed: () => {
            throw new Error("must not notify — tab is still open");
          },
        },
      );

      expect(reloadCalls).toEqual([doc]);
      expect(doc.encoding).toBe("Big5");
      expect(doc.withBom).toBe(true);
    });

    it("doc still open but its revision moved during the operation (e.g. an unrelated external-change reload landed): still reloads the same doc — 'edited' is treated the same as 'apply'", () => {
      const doc = makeStreamDoc({ id: 1, revision: 0, encoding: "UTF-8", withBom: false });
      const tabs: StreamTabsState = { docs: [doc] };
      const guard = captureIdentity(doc);
      doc.revision = 1; // something else reloaded/reopened this doc while the conversion ran

      const reloadCalls: StreamDocState[] = [];
      streamConvertCompletionSim(
        tabs,
        guard,
        doc,
        "/big.txt",
        { value: "Big5", withBom: false },
        {
          reloadFromDisk: (d) => reloadCalls.push(d),
          notifyClosed: () => {
            throw new Error("must not notify — tab is still open");
          },
        },
      );

      expect(reloadCalls).toEqual([doc]);
      expect(doc.encoding).toBe("Big5");
    });
  });

  describe("streamReplace", () => {
    it("tab closed before completion, same path reopened into a fresh tab: the fresh (reopened) tab is reloaded, not the closed doc", () => {
      const closedDoc = makeStreamDoc({ id: 1 });
      const tabs: StreamTabsState = { docs: [closedDoc] };
      const guard = captureIdentity(closedDoc);

      tabs.docs = tabs.docs.filter((d) => d !== closedDoc);
      const reopenedDoc = makeStreamDoc({ id: 2 });
      tabs.docs.push(reopenedDoc);

      const reloadCalls: StreamDocState[] = [];
      streamReplaceCompletionSim(tabs, guard, closedDoc, "/big.txt", {
        reloadFromDisk: (d) => reloadCalls.push(d),
        notifyClosed: () => {
          throw new Error("must not notify — a live tab exists for this path");
        },
      });

      expect(reloadCalls).toEqual([reopenedDoc]);
    });

    it("tab closed before completion, no tab reopened for the path: a completion notice fires and nothing is reloaded", () => {
      const closedDoc = makeStreamDoc({ id: 1 });
      const tabs: StreamTabsState = { docs: [] };
      const guard = captureIdentity(closedDoc);

      const reloadCalls: StreamDocState[] = [];
      let notifyCalls = 0;
      streamReplaceCompletionSim(tabs, guard, closedDoc, "/big.txt", {
        reloadFromDisk: (d) => reloadCalls.push(d),
        notifyClosed: () => {
          notifyCalls += 1;
        },
      });

      expect(reloadCalls).toEqual([]);
      expect(notifyCalls).toBe(1);
    });

    it("control — tab never closed: reloads the original doc, unchanged from pre-#163 behavior", () => {
      const doc = makeStreamDoc({ id: 1 });
      const tabs: StreamTabsState = { docs: [doc] };
      const guard = captureIdentity(doc);

      const reloadCalls: StreamDocState[] = [];
      streamReplaceCompletionSim(tabs, guard, doc, "/big.txt", {
        reloadFromDisk: (d) => reloadCalls.push(d),
        notifyClosed: () => {
          throw new Error("must not notify — tab is still open");
        },
      });

      expect(reloadCalls).toEqual([doc]);
    });
  });
});
