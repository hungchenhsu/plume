import { describe, expect, it } from "vitest";
import { decideSaveCompletion } from "./savecompletion";
import {
  fingerprintsEqual,
  mustDefer,
  nextDrainStep,
  type LockOwner,
} from "./savemutex";

/** A promise plus its resolve/reject, exposed for manual settlement — lets
 *  a test hold a save/open IPC mock open across another synchronous action
 *  (e.g. a second request being issued) before deciding when it "arrives".
 *  Same shape as chunkguard.test.ts / savecompletion.test.ts's helper. */
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

describe("mustDefer — full branch table", () => {
  it("nothing in flight: proceeds", () => {
    expect(mustDefer({ inFlight: null })).toBe(false);
  });

  it("a save is in flight: defers", () => {
    expect(mustDefer({ inFlight: "save" })).toBe(true);
  });

  it("a reload is in flight: defers", () => {
    expect(mustDefer({ inFlight: "reload" })).toBe(true);
  });
});

describe("nextDrainStep — full branch table", () => {
  it("nothing pending: done, regardless of dirty", () => {
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: null, dirty: false }),
    ).toEqual({ kind: "done" });
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: null, dirty: true }),
    ).toEqual({ kind: "done" });
  });

  it("pending reload only: reload, regardless of dirty", () => {
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: null, dirty: false }),
    ).toEqual({ kind: "reload" });
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: null, dirty: true }),
    ).toEqual({ kind: "reload" });
  });

  it("pending save only, doc still dirty: runs it, carrying the pending saveAs flag", () => {
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: false, dirty: true }),
    ).toEqual({ kind: "save", saveAs: false });
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: true, dirty: true }),
    ).toEqual({ kind: "save", saveAs: true });
  });

  it("pending save only, doc already clean: dropped as a redundant no-op write", () => {
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: false, dirty: false }),
    ).toEqual({ kind: "dropSave" });
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: true, dirty: false }),
    ).toEqual({ kind: "dropSave" });
  });

  it("both a reload and a save pending: reload always drains first, regardless of the save's flag or dirty", () => {
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: true, dirty: true }),
    ).toEqual({ kind: "reload" });
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: false, dirty: false }),
    ).toEqual({ kind: "reload" });
  });
});

describe("fingerprintsEqual", () => {
  it("equal primitives (including both null — no verified baseline yet)", () => {
    expect(fingerprintsEqual("fp-1", "fp-1")).toBe(true);
    expect(fingerprintsEqual(null, null)).toBe(true);
  });

  it("different primitives", () => {
    expect(fingerprintsEqual("fp-1", "fp-2")).toBe(false);
    expect(fingerprintsEqual(null, "fp-1")).toBe(false);
  });

  it("structurally equal Fingerprint-shaped objects (fsguard.rs's actual camelCase shape)", () => {
    const a = { len: 42, modified: { secs: 100, nanos: 0 }, identity: [1, 2] };
    const b = { len: 42, modified: { secs: 100, nanos: 0 }, identity: [1, 2] };
    expect(fingerprintsEqual(a, b)).toBe(true);
  });

  it("differs in one nested field", () => {
    const a = { len: 42, modified: { secs: 100, nanos: 0 }, identity: [1, 2] };
    const b = { len: 42, modified: { secs: 100, nanos: 1 }, identity: [1, 2] };
    expect(fingerprintsEqual(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// main.ts-shaped simulation. main.ts itself has no *.test.ts — it's wired
// directly into IPC/DOM/editor and isn't unit-testable on its own (see
// savecompletion.ts's header comment) — so, same as chunkguard.test.ts for
// issue #120, this harness mirrors main.ts's planned withLock/drainLock/
// saveFlow/reloadFromDisk control flow closely enough to reproduce issue
// #124's race, wired to the real mustDefer/nextDrainStep/fingerprintsEqual
// (and the real decideSaveCompletion) rather than reimplementing their
// logic independently — a wrong or missing defer check here fails exactly
// like it would in production.

interface OpenedFixture {
  content: string;
  fingerprint: unknown;
}

interface SaveIpcResult {
  written: boolean;
  stale: boolean;
  fingerprint: unknown;
  writtenContent: string;
}

/** Minimal stand-in for the slice of tabs.ts's Doc this simulation
 *  exercises, plus the three new lock fields main.ts's saveFlow/
 *  reloadFromDisk read and write (issue #124). */
function makeDocState() {
  return {
    dirty: false,
    backupName: null as string | null,
    fingerprint: "fp-0" as unknown,
    buffer: "",
    revision: 0,
    saveReloadInFlight: null as LockOwner,
    pendingReload: false,
    pendingSaveAs: null as boolean | null,
  };
}
type DocState = ReturnType<typeof makeDocState>;

/** Fake disk backing the save/open IPC mocks — the ground truth this
 *  simulation checks doc.fingerprint/buffer against once a scenario
 *  settles (issue #124's "(b) fingerprint 與 buffer 一致" requirement). */
interface FakeDisk {
  content: string;
  fingerprint: unknown;
}

function writeDisk(disk: FakeDisk, content: string, fingerprint: unknown): void {
  disk.content = content;
  disk.fingerprint = fingerprint;
}

/** Mirrors backup.ts's dropBackup for this simulation — backup.test.ts
 *  already covers the real delete-then-null behavior in isolation, so this
 *  only needs to be observable, not IPC-backed. */
function dropBackupSim(doc: DocState): void {
  doc.backupName = null;
}

/** Mirrors reloadFromDisk's state-mutation body (main.ts, after its
 *  openDocument await): unconditional apply. */
function applyOpened(doc: DocState, opened: OpenedFixture): void {
  doc.dirty = false;
  dropBackupSim(doc);
  doc.revision += 1;
  doc.fingerprint = opened.fingerprint;
  doc.buffer = opened.content;
}

/** Hooks a test can inject into the harness. */
interface HarnessOptions {
  /** Mirrors main.ts reevaluateReload's dirty-confirm dialog (issue #124
   *  critic-review P2): consulted when a drained pending reload finds
   *  genuine external changes AND the doc went dirty while the reload sat
   *  in the pending slot. Defaults to throwing so a test that reaches the
   *  dialog without expecting to fails loudly instead of silently
   *  resolving one way or the other. */
  confirmReload?: () => Promise<boolean>;
  /** Fired synchronously right after a save's bytes land on the fake disk
   *  — the hook point for simulating an external third party rewriting
   *  the file immediately after our own write, before the drain's
   *  reevaluation gets to read it. */
  onDiskWritten?: () => void;
}

/** One doc's harness. `disk` backs the default fetch used whenever a test
 *  doesn't inject its own controllable one (drainLock's reload
 *  reevaluation always reads current disk truth — see the module doc
 *  comment on why that specifically must not be blindly re-applied). */
function createHarness(doc: DocState, disk: FakeDisk, options: HarnessOptions = {}) {
  let pendingResolvers: Array<(written: boolean) => void> = [];
  let currentSaveIpc: () => Promise<SaveIpcResult> = () =>
    Promise.resolve({ written: false, stale: false, fingerprint: null, writtenContent: "" });
  const confirmReload =
    options.confirmReload ??
    (() => {
      throw new Error(
        "reached the dirty-confirm dialog but the test injected no confirmReload",
      );
    });

  function fetchDisk(): Promise<OpenedFixture> {
    return Promise.resolve({ content: disk.content, fingerprint: disk.fingerprint });
  }

  async function runSave(ipc: () => Promise<SaveIpcResult>): Promise<boolean> {
    const revisionAtStart = doc.revision;
    const result = await ipc();
    if (!result.written) return false;
    writeDisk(disk, result.writtenContent, result.fingerprint);
    options.onDiskWritten?.();
    const decision = decideSaveCompletion({
      written: result.written,
      stale: result.stale,
      revisionAtStart,
      currentRevision: doc.revision,
      pathChanged: false,
    });
    if (decision.updateFingerprint) doc.fingerprint = result.fingerprint;
    if (decision.clearDirty) doc.dirty = false;
    if (decision.dropBackup) dropBackupSim(doc);
    return true;
  }

  /** Drained pending reload only ever re-validates against current disk
   *  truth (issue #124) — never the direct/unconditional apply a fresh
   *  entry uses (see fetchAndApplyReload below). Critic-review P2: if the
   *  doc went dirty while the reload sat in the pending slot, applying
   *  would silently discard those edits — the buffer side needs consent
   *  too, not just the disk side, so this walks the same confirm dialog
   *  handleExternalChange already shows dirty docs, and a confirmed
   *  reload applies a FRESH read (disk may move again mid-dialog). */
  async function reevaluateReload(): Promise<void> {
    const opened = await fetchDisk();
    if (fingerprintsEqual(opened.fingerprint, doc.fingerprint)) return; // no-op: nothing changed beyond what already landed
    if (doc.dirty) {
      const reload = await confirmReload();
      if (!reload) return;
      applyOpened(doc, await fetchDisk());
      return;
    }
    applyOpened(doc, opened);
  }

  async function withLock(owner: "save" | "reload", body: () => Promise<void>): Promise<void> {
    doc.saveReloadInFlight = owner;
    try {
      await body();
    } finally {
      doc.saveReloadInFlight = null;
      await drainLock();
    }
  }

  async function drainLock(): Promise<void> {
    const step = nextDrainStep({
      pendingReload: doc.pendingReload,
      pendingSaveAs: doc.pendingSaveAs,
      dirty: doc.dirty,
    });
    if (step.kind === "done") return;
    if (step.kind === "reload") {
      doc.pendingReload = false;
      await withLock("reload", reevaluateReload);
      return;
    }
    const resolvers = pendingResolvers;
    pendingResolvers = [];
    doc.pendingSaveAs = null;
    if (step.kind === "dropSave") {
      for (const resolve of resolvers) resolve(true);
      await drainLock(); // something else may have queued up meanwhile
      return;
    }
    let result = false;
    await withLock("save", async () => {
      result = await runSave(currentSaveIpc);
    });
    for (const resolve of resolvers) resolve(result);
  }

  return {
    async issueSave(saveAs: boolean, ipc: () => Promise<SaveIpcResult>): Promise<boolean> {
      currentSaveIpc = ipc;
      if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
        return new Promise<boolean>((resolve) => {
          doc.pendingSaveAs = saveAs;
          pendingResolvers.push(resolve);
        });
      }
      let result = false;
      await withLock("save", async () => {
        result = await runSave(ipc);
      });
      return result;
    },
    async issueReload(fetchOpen: () => Promise<OpenedFixture> = fetchDisk): Promise<void> {
      if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
        doc.pendingReload = true;
        return;
      }
      await withLock("reload", async () => {
        applyOpened(doc, await fetchOpen());
      });
    },
  };
}

describe("issue #124 — save in flight blocks a reload request (failing-test-first: reproduces the critic-review race)", () => {
  it("defers the reload instead of applying it concurrently, then re-validates against disk once the save releases the lock — no orphan backup, no fingerprint/buffer desync, no fake staleness on the next save", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "local-edit";
    doc.fingerprint = "fp-0";
    doc.revision = 5;
    const disk: FakeDisk = { content: "disk-0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const saveCall = deferred<SaveIpcResult>();

    // 1. User hits Save; its IPC round trip is still in flight.
    const savePromise = harness.issueSave(false, () => saveCall.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // 2. While the save is in flight, the watcher (or saveFlow's own
    //    stale-confirm "reload" choice — same call site, same guard) fires
    //    a reload request for the same doc. Pre-fix this ran
    //    reloadFromDisk immediately, concurrently with the save; the fix
    //    must defer it instead.
    await harness.issueReload();
    expect(doc.pendingReload).toBe(true);
    expect(doc.buffer).toBe("local-edit"); // untouched — not applied yet

    // 3. The save's IPC resolves: it wrote "local-edit" successfully.
    //    doc.revision never moved (the deferred reload never got to bump
    //    it), so #112's own guard clears dirty and drops the backup.
    saveCall.resolve({
      written: true,
      stale: false,
      fingerprint: "fp-1",
      writtenContent: "local-edit",
    });
    const written = await savePromise;

    expect(written).toBe(true);
    // (a) No orphan backup: dirty and backupName still agree with each
    //     other all the way through — this is what #124 calls out as
    //     surviving the reload/save interleaving unguarded.
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    // (b) fingerprint matches what's actually on disk, and the buffer
    //     wasn't clobbered by the deferred reload once it drained — its
    //     stale-recheck (fingerprintsEqual) found the watcher's
    //     notification was just this save's own write and skipped
    //     applying, instead of blindly overwriting fresher content with
    //     the disk snapshot it originally would have fetched.
    expect(doc.pendingReload).toBe(false);
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.fingerprint).toBe(disk.fingerprint);
    expect(doc.buffer).toBe("local-edit");
    expect(disk.content).toBe("local-edit");
  });

  it("control — a reload deferred behind a save that turns out to be genuinely stale (a real external change) does apply once drained", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "local-edit";
    doc.fingerprint = "fp-0";
    doc.revision = 5;
    const disk: FakeDisk = { content: "disk-0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const saveCall = deferred<SaveIpcResult>();
    const savePromise = harness.issueSave(false, () => saveCall.promise);
    await harness.issueReload();
    expect(doc.pendingReload).toBe(true);

    saveCall.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "local-edit" });
    await savePromise;

    // Unlike the scenario above, something *else* wrote to disk after the
    // save (not modeled by writeDisk — an independent external actor).
    disk.content = "genuinely-newer-external-content";
    disk.fingerprint = "fp-2";

    // The drain's reevaluation only runs once, right when the save's lock
    // releases (already happened by the time savePromise resolved above,
    // per withLock's finally awaiting drainLock) — so re-issue a reload to
    // observe the still-current disk state directly, proving the
    // reevaluation path itself (not just the no-op branch) is exercised
    // elsewhere. This call runs immediately since nothing is in flight.
    await harness.issueReload();

    expect(doc.buffer).toBe("genuinely-newer-external-content");
    expect(doc.fingerprint).toBe("fp-2");
  });
});

describe("issue #124 critic-review P2 — a doc that went dirty while its reload sat in the pending slot must not be silently clobbered by the drain", () => {
  /** The full counterexample sequence from the critic review: clean doc →
   *  Cmd+S (save1 holds the lock) → external third-party write lands on
   *  disk → watcher fires → handleExternalChange takes its no-prompt
   *  clean-doc branch → reloadFromDisk hits mustDefer → pendingReload →
   *  THE USER TYPES in this window (dirty=true, revision bumps, hot-exit
   *  backup flushes) → save1 resolves written (revision moved, so #112's
   *  guard correctly keeps dirty) → drainLock runs the pending reload.
   *  Pre-fix, reevaluateReload saw only the disk-side fingerprint
   *  mismatch and applied unconditionally: dirty=false, backup dropped,
   *  buffer replaced — the user's fresh keystrokes silently gone with no
   *  dialog and no backup left covering them. */
  function typedWhilePendingScenario(confirmReload: () => Promise<boolean>) {
    const doc = makeDocState();
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "clean-content";
    doc.revision = 5;
    const disk: FakeDisk = { content: "clean-content", fingerprint: "fp-0" };
    let externalWritePending = true;
    const harness = createHarness(doc, disk, {
      confirmReload,
      // The external third party rewrites the file immediately after
      // save1's own bytes land — so the drain's fresh read sees a genuine
      // fingerprint mismatch, not just save1's own write.
      onDiskWritten: () => {
        if (!externalWritePending) return;
        externalWritePending = false;
        writeDisk(disk, "external-content", "fp-ext");
      },
    });
    return { doc, disk, harness };
  }

  async function driveScenario(
    doc: DocState,
    harness: ReturnType<typeof createHarness>,
  ): Promise<void> {
    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // Watcher fires for the external change; clean doc → no prompt →
    // reloadFromDisk → mustDefer → pending slot.
    await harness.issueReload();
    expect(doc.pendingReload).toBe(true);

    // The user types in exactly this window: dirty flips on, revision
    // bumps (editor onDocChanged), the hot-exit backup cycle flushes.
    doc.dirty = true;
    doc.revision += 1;
    doc.buffer = "clean-content-plus-typing";
    doc.backupName = "bk-typed.txt";

    // save1 resolves; its revision snapshot no longer matches, so #112's
    // completion guard keeps dirty/backup (verified below implicitly —
    // if it cleared them, the drain would take the dropSave path and the
    // assertions would fail differently).
    save1.resolve({
      written: true,
      stale: false,
      fingerprint: "fp-1",
      writtenContent: "clean-content",
    });
    await p1;
  }

  it("user declines the dialog: buffer, dirty, and the hot-exit backup all survive — nothing is silently discarded", async () => {
    const confirmCalls: number[] = [];
    const { doc, harness } = typedWhilePendingScenario(() => {
      confirmCalls.push(1);
      return Promise.resolve(false);
    });

    await driveScenario(doc, harness);

    // The dialog was actually consulted — a silent apply OR a silent skip
    // would both be wrong; the user decides.
    expect(confirmCalls.length).toBe(1);
    expect(doc.buffer).toBe("clean-content-plus-typing");
    expect(doc.dirty).toBe(true);
    expect(doc.backupName).toBe("bk-typed.txt");
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.pendingReload).toBe(false);
  });

  it("user confirms the dialog: the reload applies a FRESH disk read (disk may have moved again while the dialog was up)", async () => {
    const { doc, disk, harness } = typedWhilePendingScenario(() => {
      // While the dialog sat open, the external file changed yet again —
      // confirming must apply what's on disk NOW, not the snapshot the
      // reevaluation fetched before asking.
      writeDisk(disk, "external-content-v2", "fp-ext-2");
      return Promise.resolve(true);
    });

    await driveScenario(doc, harness);

    expect(doc.buffer).toBe("external-content-v2");
    expect(doc.fingerprint).toBe("fp-ext-2");
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull(); // user explicitly chose to discard
    expect(doc.saveReloadInFlight).toBeNull();
  });

  it("control — a doc that stayed clean through the pending window still reloads without any dialog", async () => {
    const doc = makeDocState();
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "clean-content";
    doc.revision = 5;
    const disk: FakeDisk = { content: "clean-content", fingerprint: "fp-0" };
    let externalWritePending = true;
    // No confirmReload injected: reaching the dialog here would throw.
    const harness = createHarness(doc, disk, {
      onDiskWritten: () => {
        if (!externalWritePending) return;
        externalWritePending = false;
        writeDisk(disk, "external-content", "fp-ext");
      },
    });

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    await harness.issueReload();
    expect(doc.pendingReload).toBe(true);
    // No typing this time — the doc stays clean through the window.
    save1.resolve({
      written: true,
      stale: false,
      fingerprint: "fp-1",
      writtenContent: "clean-content",
    });
    await p1;

    expect(doc.buffer).toBe("external-content");
    expect(doc.fingerprint).toBe("fp-ext");
    expect(doc.dirty).toBe(false);
  });
});

describe("issue #124 — reload in flight blocks a save request", () => {
  it("defers the save instead of running it concurrently, then reruns it fresh once the reload releases the lock — a clean post-reload doc drops the redundant write", async () => {
    const doc = makeDocState();
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "old-content";
    doc.revision = 1;
    const disk: FakeDisk = { content: "old-content", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const openCall = deferred<OpenedFixture>();
    const reloadPromise = harness.issueReload(() => openCall.promise);
    expect(doc.saveReloadInFlight).toBe("reload");

    // The user hits Save while the reload's own IPC call is still in
    // flight (e.g. it was triggered by a watcher event moments earlier).
    const savePromise = harness.issueSave(false, () =>
      Promise.resolve({
        written: true,
        stale: false,
        fingerprint: "fp-should-not-be-used",
        writtenContent: "should-not-be-written",
      }),
    );
    expect(doc.pendingSaveAs).toBe(false);

    openCall.resolve({ content: "new-external-content", fingerprint: "fp-ext" });
    await reloadPromise;

    // Reload replaced the buffer and left the doc clean; the deferred
    // save, once drained, finds nothing dirty to write and is dropped
    // rather than clobbering the just-reloaded content.
    expect(doc.buffer).toBe("new-external-content");
    expect(doc.dirty).toBe(false);

    const written = await savePromise;
    expect(written).toBe(true); // told "covered" even though the write was dropped
    // Unchanged: reload only ever reads — neither it nor the dropped save
    // wrote anything to disk, so the fake disk's own content never moved
    // (only doc.buffer, in memory, reflects what the reload fetched).
    expect(disk.content).toBe("old-content");
    expect(doc.fingerprint).toBe("fp-ext"); // still the reload's baseline, not clobbered
  });

  // No "genuine edit lands mid-flight, so the drained save actually reruns"
  // counterpart here (unlike double-save's below): applyOpened (reload)
  // clears dirty unconditionally and runs entirely synchronously once its
  // own fetch resolves, right through drainLock's next-step check — there
  // is no real await point in between for a keystroke to land at. A save
  // deferred behind a reload can only ever see a clean doc once drained,
  // exactly as issue #124's own text expects ("實務上 reload 後 doc 是
  // clean"). A fresh edit arriving after the reload has already fully
  // settled starts its own new saveFlow call later — a separate scenario,
  // not this pending slot's drain.
});

describe("issue #124 — double-save determinism", () => {
  it("a second save requested while the first is in flight is dropped once the first already wrote the latest content — deterministic outcome, not resolve-order-dependent", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "edit-1";
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // A second Save request for the same doc arrives before the first's
    // IPC round trip resolves (double Cmd+S, or Close-with-save racing a
    // manual Save). Pre-fix each ran its own concurrent saveDocument call;
    // post-fix the second coalesces into the single pending slot.
    const p2 = harness.issueSave(false, () => {
      throw new Error(
        "save2's own ipc must never be invoked — save1 already wrote the latest content, so the drain must drop it, not re-run it",
      );
    });
    expect(doc.pendingSaveAs).toBe(false);

    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    // save2 was coalesced, not re-run — the content it wanted saved is
    // already on disk, so its caller still sees success.
    expect(r2).toBe(true);
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    expect(doc.fingerprint).toBe("fp-1");
    expect(disk.content).toBe("edit-1");
  });

  it("a second save actually reruns once a genuine edit lands before the first completes — not silently dropped just because a save was already pending", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "edit-1";
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    const p2 = harness.issueSave(false, () =>
      Promise.resolve({ written: true, stale: false, fingerprint: "fp-2", writtenContent: "edit-2" }),
    );

    // An edit lands after save1 snapshotted its content but before it
    // resolved — mirrors #112's own scenario (savecompletion.test.ts).
    doc.revision += 1;
    doc.buffer = "edit-2";

    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // save1's own completion must not have cleared dirty/dropped the
    // backup (#112's revision guard) — the drained save2 is what finally
    // does, once it actually runs against the newer content.
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    expect(doc.fingerprint).toBe("fp-2");
    expect(disk.content).toBe("edit-2");
  });
});

describe("issue #124 — lock releases and drains even when the in-flight op throws/rejects", () => {
  it("a save whose IPC call rejects still releases the lock and drains a pending reload — never stuck forever", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.fingerprint = "fp-0";
    doc.buffer = "local-edit";
    const disk: FakeDisk = { content: "external", fingerprint: "fp-ext" };
    // The doc is dirty and the disk genuinely differs, so the drained
    // reload consults the dirty-confirm dialog (critic-review P2) — this
    // test's subject is the lock draining at all after a rejection, so
    // the user just confirms.
    const harness = createHarness(doc, disk, {
      confirmReload: () => Promise.resolve(true),
    });

    const saveCall = deferred<SaveIpcResult>();
    // No try/catch around this in the harness (mirrors withLock's finally
    // being the actual safety net, not an inner catch) — isolates that the
    // *lock's own* release doesn't depend on saveFlow's outer try/catch
    // existing, only on withLock's finally running regardless of outcome.
    const p = harness.issueSave(false, () => saveCall.promise).catch(() => "caught" as const);

    await harness.issueReload(); // watcher fires while the save is in flight
    expect(doc.pendingReload).toBe(true);

    saveCall.reject(new Error("IPC transport error"));
    const outcome = await p;

    expect(outcome).toBe("caught");
    // The lock must not be stuck on "save" forever, and the reload that
    // was waiting on it must actually have run once released.
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.pendingReload).toBe(false);
    expect(doc.buffer).toBe("external");
    expect(doc.fingerprint).toBe("fp-ext");
  });

  it("a reload whose IPC call rejects still releases the lock and drains a pending save", async () => {
    const doc = makeDocState();
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "old-content";
    const disk: FakeDisk = { content: "old-content", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const openCall = deferred<OpenedFixture>();
    const reloadPromise = harness.issueReload(() => openCall.promise).catch(() => "caught" as const);

    const savePromise = harness.issueSave(false, () =>
      Promise.resolve({ written: true, stale: false, fingerprint: "fp-2", writtenContent: "edit-after-failed-reload" }),
    );
    expect(doc.pendingSaveAs).toBe(false);

    openCall.reject(new Error("file vanished mid-read"));
    const reloadOutcome = await reloadPromise;

    expect(reloadOutcome).toBe("caught");
    expect(doc.saveReloadInFlight).toBeNull();

    // The failed reload never touched dirty/buffer, so the doc is still
    // clean as far as the drain can tell — the pending save is dropped as
    // a redundant no-op, exactly like the "reload succeeded and left the
    // doc clean" case above. (main.ts's real reloadFromDisk swallows this
    // exact failure itself — see its own try/catch — so in production the
    // pending save would in practice run against whatever doc.dirty
    // already was; this simulation isolates that the *lock* still drains
    // correctly regardless.)
    const written = await savePromise;
    expect(written).toBe(true);
    expect(disk.content).toBe("old-content");
  });
});
