import { describe, expect, it } from "vitest";
import { createBackupPipeline, type BackupSlot } from "./backuppipeline";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function slot(id = 1): BackupSlot {
  return { id, backupName: null };
}

/** Pipeline over a recording fake IO; each save/remove can be deferred. */
function setup() {
  const saves: Array<{ name: string; content: string; gate: ReturnType<typeof deferred<void>> }> =
    [];
  const removes: Array<{ name: string; gate: ReturnType<typeof deferred<void>> }> = [];
  const pipeline = createBackupPipeline({
    save: (name, content) => {
      const gate = deferred<void>();
      saves.push({ name, content, gate });
      return gate.promise;
    },
    remove: (name) => {
      const gate = deferred<void>();
      removes.push({ name, gate });
      return gate.promise;
    },
  });
  return { pipeline, saves, removes };
}

/** Let queued microtasks run so the next queue op can start. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("createBackupPipeline — commit-on-success (issue #263)", () => {
  it("commits backupName only after the write lands, never while in flight", async () => {
    const { pipeline, saves } = setup();
    const doc = slot();
    const flushed = pipeline.flush(doc, "unsaved text");
    await settle();
    // Write started but not landed: session snapshots taken now must not
    // reference the file yet.
    expect(saves).toHaveLength(1);
    expect(doc.backupName).toBeNull();
    saves[0].gate.resolve();
    await expect(flushed).resolves.toBe(true);
    expect(doc.backupName).toBe(saves[0].name);
  });

  it("a failed write leaves the name uncommitted and resolves false", async () => {
    const { pipeline, saves } = setup();
    const doc = slot();
    const flushed = pipeline.flush(doc, "text");
    await settle();
    saves[0].gate.reject(new Error("disk full"));
    await expect(flushed).resolves.toBe(false);
    expect(doc.backupName).toBeNull();
  });

  it("retries after a failure reuse the same reserved name", async () => {
    const { pipeline, saves } = setup();
    const doc = slot();
    const first = pipeline.flush(doc, "v1");
    await settle();
    saves[0].gate.reject(new Error("boom"));
    await first;

    const second = pipeline.flush(doc, "v2");
    await settle();
    saves[1].gate.resolve();
    await expect(second).resolves.toBe(true);
    expect(saves[1].name).toBe(saves[0].name);
    expect(doc.backupName).toBe(saves[0].name);
  });

  it("later flushes keep writing to the committed name", async () => {
    const { pipeline, saves } = setup();
    const doc = slot();
    const first = pipeline.flush(doc, "v1");
    await settle();
    saves[0].gate.resolve();
    await first;

    const second = pipeline.flush(doc, "v2");
    await settle();
    saves[1].gate.resolve();
    await second;
    expect(saves[1].name).toBe(saves[0].name);
  });
});

describe("createBackupPipeline — per-doc write ordering", () => {
  it("a second flush for the same doc waits for the first write to settle", async () => {
    const { pipeline, saves } = setup();
    const doc = slot();
    const first = pipeline.flush(doc, "older");
    const second = pipeline.flush(doc, "newer");
    await settle();
    // Only the first write may be in flight — un-serialized, both IPC
    // calls would race and the older content could land last.
    expect(saves).toHaveLength(1);
    expect(saves[0].content).toBe("older");
    saves[0].gate.resolve();
    await settle();
    expect(saves).toHaveLength(2);
    expect(saves[1].content).toBe("newer");
    saves[1].gate.resolve();
    await Promise.all([first, second]);
  });

  it("different docs do not serialize against each other", async () => {
    const { pipeline, saves } = setup();
    const a = slot(1);
    const b = slot(2);
    void pipeline.flush(a, "a");
    void pipeline.flush(b, "b");
    await settle();
    expect(saves).toHaveLength(2);
  });
});

describe("createBackupPipeline — drop vs in-flight writes (issue #263)", () => {
  it("queues the delete behind an in-flight write and never commits the name", async () => {
    const { pipeline, saves, removes } = setup();
    const doc = slot();
    const flushed = pipeline.flush(doc, "text");
    await settle();
    expect(saves).toHaveLength(1);

    // The save completed (say, on disk) while the drop already happened:
    // the write must not resurrect the name, and the queued delete must
    // clean the just-written file up.
    pipeline.drop(doc);
    saves[0].gate.resolve();
    await expect(flushed).resolves.toBe(false);
    expect(doc.backupName).toBeNull();
    await settle();
    expect(removes).toHaveLength(1);
    expect(removes[0].name).toBe(saves[0].name);
  });

  it("cancels a queued-but-unrun flush instead of minting a fresh backup after the drop", async () => {
    const { pipeline, saves, removes } = setup();
    const doc = slot();
    const first = pipeline.flush(doc, "v1");
    const second = pipeline.flush(doc, "v2"); // queued behind first
    await settle();
    pipeline.drop(doc); // arrives before second ever runs

    saves[0].gate.resolve();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await settle();
    // Exactly one write ever hit IO — the cancelled flush would otherwise
    // have created a file the drop's delete never knew about.
    expect(saves).toHaveLength(1);
    expect(removes).toHaveLength(1);
    expect(doc.backupName).toBeNull();
  });

  it("drops a committed backup: clears the slot synchronously and deletes the file", async () => {
    const { pipeline, saves, removes } = setup();
    const doc = slot();
    const flushed = pipeline.flush(doc, "text");
    await settle();
    saves[0].gate.resolve();
    await flushed;
    expect(doc.backupName).not.toBeNull();

    pipeline.drop(doc);
    expect(doc.backupName).toBeNull();
    await settle();
    expect(removes.map((r) => r.name)).toEqual([saves[0].name]);
  });

  it("a drop with nothing written and nothing reserved deletes nothing", async () => {
    const { pipeline, removes } = setup();
    pipeline.drop(slot());
    await settle();
    expect(removes).toHaveLength(0);
  });

  it("a flush enqueued after a drop starts a fresh backup lifecycle", async () => {
    const { pipeline, saves, removes } = setup();
    const doc = slot();
    const first = pipeline.flush(doc, "v1");
    await settle();
    saves[0].gate.resolve();
    await first;
    pipeline.drop(doc);
    // The queued delete gates the queue — let it land first (which is
    // itself the ordering under test).
    await settle();
    removes[0].gate.resolve();

    const second = pipeline.flush(doc, "v2");
    await settle();
    // The old name was dropped; a new edit gets a new file.
    expect(saves).toHaveLength(2);
    saves[1].gate.resolve();
    await expect(second).resolves.toBe(true);
    expect(doc.backupName).toBe(saves[1].name);
  });
});

describe("createBackupPipeline — forget", () => {
  it("releases per-doc state; a reused id starts clean", async () => {
    const { pipeline, saves } = setup();
    const doc = slot(7);
    const first = pipeline.flush(doc, "v1");
    await settle();
    saves[0].gate.reject(new Error("boom"));
    await first;
    pipeline.forget(7);

    const again = slot(7);
    const second = pipeline.flush(again, "v2");
    await settle();
    saves[1].gate.resolve();
    await expect(second).resolves.toBe(true);
  });
});
