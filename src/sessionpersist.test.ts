import { describe, expect, it } from "vitest";
import { createSessionPersister } from "./sessionpersist";

/** A promise whose resolve is triggered from the outside (mirrors
 *  opqueue.test.ts's own helper — used here to simulate a slow IPC
 *  response for the first write). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createSessionPersister", () => {
  it("passes each persist()'s value through save()", async () => {
    const persister = createSessionPersister<number>({
      collect: () => 42,
      save: () => Promise.resolve(),
    });
    await expect(persister.persist()).resolves.toBeUndefined();
  });

  // Regression for the v0.7 Track R race (same shape as issue #252/PR
  // #270's recentOps): without a queue, two persist() calls fire save()
  // concurrently, and whichever IPC response resolves first "wins" on
  // disk — here the second (fresher) write resolves fast while the first
  // (staler) write is still in flight, so an unserialized implementation
  // would let the stale write land last and overwrite the fresh one.
  it("a slow first write does not get overwritten on disk by a fast second write", async () => {
    const saved: number[] = [];
    const firstWrite = deferred<void>();
    let value = 1;
    const persister = createSessionPersister<number>({
      collect: () => value,
      save: (session) => {
        if (saved.length === 0 && session === 1) {
          return firstWrite.promise.then(() => {
            saved.push(session);
          });
        }
        saved.push(session);
        return Promise.resolve();
      },
    });

    const p1 = persister.persist(); // captures value===1, save() is slow
    value = 2;
    const p2 = persister.persist(); // captures value===2, save() is fast

    // Let any (incorrectly) eager second write happen.
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([]);

    firstWrite.resolve();
    await Promise.all([p1, p2]);

    // Landed in enqueue order; the final on-disk value is the later
    // (fresher) snapshot, never the stale one that happened to resolve
    // whenever its slow IPC call finally settled.
    expect(saved).toEqual([1, 2]);
  });

  // Isolates the snapshot-freeze requirement from ordering: both writes
  // resolve immediately here (no IPC delay), so a naive-but-still-queued
  // implementation that calls collect() lazily inside the queued closure
  // (`queue.enqueue(() => save(collect()))`) would have both writes read
  // `value` only once the queue actually got to them — by which point the
  // synchronous mutation below has already happened — and record [2, 2]
  // instead of [1, 2].
  it("freezes the snapshot at persist()'s call time, not when the queue runs it", async () => {
    const calls: number[] = [];
    let value = 1;
    const persister = createSessionPersister<number>({
      collect: () => value,
      save: (session) => {
        calls.push(session);
        return Promise.resolve();
      },
    });

    const p1 = persister.persist(); // must capture value===1 synchronously
    value = 2; // mutated before persist()'s queued closure has run at all
    const p2 = persister.persist(); // must capture value===2

    await Promise.all([p1, p2]);

    expect(calls).toEqual([1, 2]);
  });

  it("a failed write does not block a later one", async () => {
    let calls = 0;
    const persister = createSessionPersister<number>({
      collect: () => 1,
      save: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("disk full")) : Promise.resolve();
      },
    });

    await expect(persister.persist()).rejects.toThrow("disk full");
    await expect(persister.persist()).resolves.toBeUndefined();
  });
});
